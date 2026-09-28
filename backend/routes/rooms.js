// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 房间 API(语义对齐前端 zustand mock,字段与 frontend/src/lib/types.ts 一致)
import { Router } from 'express'
import { getDb, generateCode, now } from '../db.js'
import { getRoomRow, getRoomJson, updateRoomRow, broadcastRoom, performLeave, getDisplayNames, pruneDisplayNames, normalizeDisplayName, findUserRooms, ACTIVE_ROOM_STATUSES } from '../lib/rooms.js'
import { requireAuth, isAdmin } from '../lib/auth.js'
import { startMatch, forceEndMatch, validateManualInstance, provisioningMessage } from '../lib/instances.js'
import { applyVetoAction, applySideChoice, currentVetoTeam } from '../lib/veto.js'
import { sanitizeTeamName, listMaps } from '../lib/matchjson.js'
import { getActiveMapPool, getRoomModeAvailability } from '../lib/settings.js'
import { getDefaultMaxPlayers, checkRoomCapacity, specSeatsForCapacity, MIN_MAX_PLAYERS, MAX_MAX_PLAYERS } from '../lib/roomlimits.js'
import { DUEL_MIN_ROUNDS, DUEL_MAX_ROUNDS, normalizeDuelPreset } from '../lib/duel.js'
import { getGameServer } from '../lib/gameServers.js'
import { maintenanceMessage } from '../lib/jobs.js'
import { getSpectatorJoinSetting, addExtraSpectator, matchRosterHasSteamId, listExtraSpectators } from '../lib/spectators.js'
import { setPendingSwap, getPendingSwap, consumePendingSwap, clearRoomSwaps } from '../lib/swaps.js'
import { teamLimit, minFreeSlot, compactTeamSlots, shuffleTeamSlots, resolveTargetSlot, teamMembers, firstMember, recalcCaptains } from '../lib/slots.js'
import {
  BOT_NAME_POOL,
  BOT_AIM_MODES,
  BOT_NADE_MODES,
  getProTeam,
  sanitizeBotName,
  makeBotSlot,
  nextBotSeq,
  usedBotNames,
} from '../lib/bots.js'

const DEFAULT_AVATAR =
  'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg'

// 房间地图池计算(pickMode × 单挑「地图池选择」):
// veto(BP)= 服役池(恒 7 张官方图);community = 社区图(按房间 matchType 过滤);
// direct = 按 mapPoolKind —— total=官方总池(默认)/ duel=单挑图池(社区图勾选「单挑对决」,仅 1v1 房间可选)
function roomMapPool(pickMode, matchType, poolKind) {
  if (pickMode === 'community') {
    return listMaps().filter((m) => m.kind === 'workshop' && (m.matchTypes || []).includes(matchType)).map((m) => m.id)
  }
  if (pickMode === 'direct') {
    if (poolKind === 'duel') {
      return listMaps().filter((m) => m.kind === 'workshop' && (m.matchTypes || []).includes('duel')).map((m) => m.id)
    }
    return listMaps().filter((m) => m.kind === 'official').map((m) => m.id)
  }
  return getActiveMapPool()
}

function playerFromUser(u) {
  return {
    id: u.steam_id,
    steamId: u.steam_id,
    name: u.name,
    avatarUrl: u.avatar_url || DEFAULT_AVATAR,
  }
}

function slotCounts(slots) {
  return {
    ct: slots.filter((s) => s.team === 'ct').length,
    t: slots.filter((s) => s.team === 't').length,
    spec: slots.filter((s) => s.team === 'spec').length,
  }
}

function isHost(req, room) {
  return room.hostId === req.user.steam_id
}

// 准备阶段(waiting/vetoing)才允许换位/移交/随机分队(开始后禁止)
function isPrepStatus(status) {
  return status === 'waiting' || status === 'vetoing'
}

// 洗牌时若队长参与换队 → 两队均按第一位重选
function recalcCaptainsAfterMove(room) {
  room.captainA = firstMember(room.slots, 'ct')
  room.captainB = firstMember(room.slots, 't')
}

export function createRoomsRouter(ctx) {
  const router = Router()
  const auth = requireAuth()
  const { io } = ctx

  // 访问日志:便于定位前端请求是否到达/被谁拦截
  router.use((req, res, next) => {
    const t = Date.now()
    res.on('finish', () => {
      console.log(
        `[room] ${new Date(t).toLocaleTimeString()} ${req.method} ${req.originalUrl} → ${res.statusCode} user=${req.user?.steam_id ?? '-'} ${Date.now() - t}ms`,
      )
    })
    next()
  })

  function guardHost(req, res, room) {
    // 管理员对所有房间操作放行(超管)
    if (isAdmin(req.user.steam_id)) return true
    if (!isHost(req, room)) {
      res.status(403).json({ error: '只有房主可以执行此操作' })
      return false
    }
    return true
  }

  // 列表(公开房间,不含密码;含开赛中与进行中房间;finished 排除,战绩走记录页)
  router.get('/', (req, res) => {
    const rows = getDb()
      .prepare("SELECT * FROM rooms WHERE status IN ('waiting', 'vetoing', 'starting', 'live') ORDER BY created_at DESC")
      .all()
    res.json(
      rows.map((r) => {
        const room = getRoomJson(r.id)
        delete room.password
        return room
      }),
    )
  })

  // 详情
  router.get('/:id', (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    res.json(room)
  })

  // 状态快照(断线重连补状态用)
  // match.extraSpectators = 本场经「中途加入观战」追加的非名单观战者 steamid 列表
  // (比赛页据此判断"我已获准观战",刷新/换设备后仍成立;名单本身是公开信息,与 slots 同口径)
  router.get('/:id/status', (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    const m = getDb().prepare('SELECT * FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(room.id)
    res.json({
      room,
      match: m
        ? {
            id: m.id,
            status: m.status,
            instanceName: m.instance_name,
            currentScores: m.current_scores ? JSON.parse(m.current_scores) : null,
            extraSpectators: listExtraSpectators(m),
          }
        : null,
      // 观战开关快照(比赛页据此决定「申请中途加入观战」按钮是否可点):
      // roomAllowed = 房间级开关(房主) / platformAllowed = 平台级总开关(管理员)
      spectate: {
        roomAllowed: room.spectatorJoin !== false,
        platformAllowed: getSpectatorJoinSetting().allow,
      },
    })
  })

  // 创建房间(botMode=增强人机:TeamB 全人机、TeamA 真人可加人机;人机不参与刀局,固定 BO1)
  router.post('/', auth, async (req, res) => {
    const { name, matchType, botMode, recordDemo, overtimeEnabled } = req.body ?? {}
    const admin = isAdmin(req.user.steam_id)
    const type = matchType === 'duel' ? 'duel' : 'custom'
    const isBotMode = botMode === true
    if (overtimeEnabled != null && typeof overtimeEnabled !== 'boolean') return res.status(400).json({ error: 'overtimeEnabled 必须为布尔值' })
    if (matchType === 'duel' && overtimeEnabled === true) return res.status(400).json({ error: '单挑对决不支持加时' })
    if (!name || typeof name !== 'string') return res.status(400).json({ error: '缺少房间名' })
    const requestedMode = isBotMode ? 'botMode' : type
    if (!admin && !getRoomModeAvailability()[requestedMode]) {
      const labels = { custom: '自定义竞技', duel: '单挑对决', botMode: '增强人机' }
      return res.status(403).json({ error: `管理员已关闭「${labels[requestedMode]}」房间` })
    }
    // 单房间守卫(2026-09-22 用户定档):一个用户同一时间只能持有一个活跃房间(管理员不受限);
    // 创建 = 进入新房间,故先离开自己所在的其它"准备中"房间(finished 历史行不算占用,不下手)
    const mine = findUserRooms(req.user.steam_id)
    if (!admin) {
      const busy = mine.find((r) => r.status === 'starting' || r.status === 'live')
      if (busy) return res.status(409).json({ error: `你正在进行中的房间「${busy.name}」,请先结束比赛再创建新房间` })
      const hosted = mine.find((r) => r.host_id === req.user.steam_id && ACTIVE_ROOM_STATUSES.includes(r.status))
      if (hosted) {
        return res.status(409).json({
          error: `你已有房间「${hosted.name}」,同一时间只能创建/拥有一个房间(可在房间大厅打开它,用「解散房间」结束;或先打完那场)`,
        })
      }
    }
    for (const r of mine) {
      if (r.host_id === req.user.steam_id) continue // 自己持有的房间不自动解散(管理员可有多个)
      if (r.status === 'waiting' || r.status === 'vetoing') await performLeave(io, r.id, req.user.steam_id)
    }
    const isDuel = type === 'duel'
    const room = {
      id: `room-${now()}-${Math.floor(Math.random() * 1e4)}`,
      code: generateCode(6),
      name: String(name).slice(0, 40),
      hostId: req.user.steam_id,
      matchType: type,
      teamA: isDuel ? 1 : 5,
      teamB: isDuel ? 1 : 5,
      teamAName: 'TEAM A',
      teamBName: 'TEAM B',
      specSeats: isDuel ? 6 : 1,
      bestOf: 1,
      pickMode: isDuel ? 'direct' : 'veto',
      status: 'waiting',
      slots: JSON.stringify([{ player: playerFromUser(req.user), team: 'ct', slot: 0 }]),
      // 地图池:custom=服役池(恒 7 张,BP 专用);duel=单挑图池(社区图勾选「单挑对决」,
      // 「地图池选择」默认值,可经 /config 切回总竞技图池 —— 2026-09-19 起默认改为单挑图池)
      mapPool: JSON.stringify(isDuel ? roomMapPool('direct', 'duel', 'duel') : getActiveMapPool()),
      mapPoolKind: isDuel ? 'duel' : 'total',
      banned: '[]',
      picked: '[]',
      vetoHistory: '[]',
      vetoTurn: 0,
      // 拼刀选边默认关闭(2026-09-19,全模式;此前 custom 默认开启、人机房关闭)。
      // 单挑对决固定无刀局且 /config 禁止开启;custom 房间可经 /config 自行开启
      knifeRound: 0,
      friendlyFire: 1, // 友军伤害默认开启(competitive/MatchZy 默认);关闭时经比赛 JSON cvars 下发
      overtimeEnabled: !isDuel && overtimeEnabled !== false ? 1 : 0,
      recordDemo: recordDemo === false ? 0 : 1, // 对局录像默认开启;关闭时下发 record_demo: false 并不等录像立即解除冷却
      spectatorJoin: 1, // 允许中途加入观战默认开启(房间级;平台级总开关见 settings.spectator_join)
      botMode: isBotMode ? 1 : 0,
      botAim: 'mixed',
      botNades: 'normal',
      botProteam: null,
      captainA: req.user.steam_id, // A 队第一位(房主)为队长A
      captainB: null,
      serverChoice: JSON.stringify({ mode: 'auto', group: null, instance: null }),
      server: null,
      createdAt: now(),
    }
    getDb()
      .prepare(
        `INSERT INTO rooms (id, code, name, host_id, match_type, team_a, team_b, team_a_name, team_b_name, spec_seats, best_of, pick_mode, map_pool_kind, status, slots, map_pool, banned, picked, veto_history, veto_turn, knife_round, friendly_fire, record_demo, overtime_enabled, spectator_join, bot_mode, bot_aim, bot_nades, bot_proteam, captain_a, captain_b, server_choice, server, created_at)
         VALUES (:id, :code, :name, :hostId, :matchType, :teamA, :teamB, :teamAName, :teamBName, :specSeats, :bestOf, :pickMode, :mapPoolKind, :status, :slots, :mapPool, :banned, :picked, :vetoHistory, :vetoTurn, :knifeRound, :friendlyFire, :recordDemo, :overtimeEnabled, :spectatorJoin, :botMode, :botAim, :botNades, :botProteam, :captainA, :captainB, :serverChoice, :server, :createdAt)`,
      )
      .run(room)
    res.status(201).json(getRoomJson(room.id))
  })

  // 加入房间
  router.post('/:id/join', auth, async (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (room.status === 'live' || room.status === 'finished') {
      return res.status(409).json({ error: '比赛已在进行中' })
    }
    if (room.password && room.password !== (req.body?.password ?? '')) {
      return res.status(403).json({ error: '密码错误' })
    }
    const me = room.slots.find((s) => s.player.steamId === req.user.steam_id)
    if (me) return res.json(room)
    // 单房间守卫(2026-09-22):同一用户同一时间只能在一个房间 —— 进入新房间时自动离开旧房间
    // (房主=解散,见 performLeave);但**在进行的房间**(starting/live)不静默抛弃:
    // 那会强制结束整场比赛并影响其他人,改为拒绝并提示先结束
    const mine = findUserRooms(req.user.steam_id, room.id)
    const busy = mine.find((r) => r.status === 'starting' || r.status === 'live')
    if (busy) return res.status(409).json({ error: `你正在进行中的房间「${busy.name}」,请先结束比赛再加入其它房间` })
    for (const r of mine) {
      if (r.status === 'waiting' || r.status === 'vetoing') await performLeave(io, r.id, req.user.steam_id)
    }
    const counts = slotCounts(room.slots)
    if (room.botMode) {
      // 增强人机:TeamB 全人机,真人只进 TeamA / 观战席
      if (counts.ct < room.teamA) {
        room.slots.push({ player: playerFromUser(req.user), team: 'ct', slot: minFreeSlot(room.slots, 'ct') })
      } else if (counts.spec < room.specSeats) {
        room.slots.push({ player: playerFromUser(req.user), team: 'spec', slot: minFreeSlot(room.slots, 'spec') })
      } else {
        return res.status(409).json({ error: '房间已满' })
      }
    } else if (counts.ct >= room.teamA && counts.t >= room.teamB) {
      if (counts.spec >= room.specSeats) return res.status(409).json({ error: '房间已满' })
      room.slots.push({ player: playerFromUser(req.user), team: 'spec', slot: minFreeSlot(room.slots, 'spec') })
    } else {
      const fillTeam = counts.ct < room.teamA && counts.ct <= counts.t ? 'ct' : 't'
      room.slots.push({ player: playerFromUser(req.user), team: fillTeam, slot: minFreeSlot(room.slots, fillTeam) })
    }
    recalcCaptains(room); updateRoomRow(room.id, { slots: JSON.stringify(room.slots), captain_a: room.captainA, captain_b: room.captainB })
    res.json(broadcastRoom(io, room.id))
  })

  // 离开房间(房主=解散):房主离开且比赛进行中时,先强制结束比赛再解散(释放实例锁,见 lib/rooms.js)
  router.post('/:id/leave', auth, async (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    const result = await performLeave(io, room.id, req.user.steam_id)
    if (result?.deleted) return res.json({ ok: true, deleted: true })
    res.json(getRoomJson(room.id) ?? { ok: true })
  })

  // 房主踢人
  router.post('/:id/kick', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    const { playerId } = req.body ?? {}
    room.slots = room.slots.filter((s) => s.player.id !== playerId && s.player.steamId !== playerId)
    recalcCaptains(room); updateRoomRow(room.id, { slots: JSON.stringify(room.slots), captain_a: room.captainA, captain_b: room.captainB })
    res.json(broadcastRoom(io, room.id))
  })

  // 房主换位(可选 slot 精确落位;缺省 = 目标队最小空槽)
  router.post('/:id/move', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    if (!isPrepStatus(room.status)) return res.status(409).json({ error: '比赛开始后禁止换位' })
    const { playerId, team, slot } = req.body ?? {}
    if (!['ct', 't', 'spec'].includes(team)) return res.status(400).json({ error: '无效阵营' })
    const member = room.slots.find((s) => s.player.id === playerId || s.player.steamId === playerId)
    if (!member) return res.status(400).json({ error: '目标玩家不在房间中' })
    // 增强人机:TeamB 仅人机,真人不可移入(bot 可在两队间调度)
    if (room.botMode && team === 't' && !member.isBot) return res.status(400).json({ error: '增强人机模式 TeamB 仅限人机' })
    let next
    if (slot != null) {
      const r = resolveTargetSlot(room, room.slots, member, team, slot)
      if (r.error) return res.status(r.status).json({ error: r.error })
      next = { team, slot: r.slot }
    } else {
      // 观战席同样受 specSeats 限制(此前豁免 → 无 slot 换位可无限堆进观战席,
      // 观战人数既超配置、又让开赛时的容量校验(按 spec_seats 计)失去精度)
      if (slotCounts(room.slots)[team] >= teamLimit(room, team)) {
        return res.status(409).json({ error: team === 'spec' ? '观战席已满' : '该阵营已满' })
      }
      next = { team, slot: minFreeSlot(room.slots, team) }
    }
    room.slots = room.slots.map((s) => (s === member ? { ...s, ...next } : s))
    recalcCaptains(room); updateRoomRow(room.id, { slots: JSON.stringify(room.slots), captain_a: room.captainA, captain_b: room.captainB })
    res.json(broadcastRoom(io, room.id))
  })

  // 自己换位(可选 slot 精确落位:同队仅移自身,原槽留空;跨队 team+slot;缺省 = 目标队最小空槽)
  router.post('/:id/setteam', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!isPrepStatus(room.status)) return res.status(409).json({ error: '比赛开始后禁止换位' })
    const { team, slot } = req.body ?? {}
    if (!['ct', 't', 'spec'].includes(team)) return res.status(400).json({ error: '无效阵营' })
    const member = room.slots.find((s) => s.player.steamId === req.user.steam_id)
    if (!member) return res.status(403).json({ error: '你不在房间中' })
    // 增强人机:TeamB 仅人机,真人不可换入
    if (room.botMode && team === 't') return res.status(400).json({ error: '增强人机模式 TeamB 仅限人机' })
    let next
    if (slot != null) {
      const r = resolveTargetSlot(room, room.slots, member, team, slot)
      if (r.error) return res.status(r.status).json({ error: r.error })
      next = { team, slot: r.slot }
    } else {
      // 观战席同样受 specSeats 限制(此前豁免 → 无 slot 换位可无限堆进观战席,
      // 观战人数既超配置、又让开赛时的容量校验(按 spec_seats 计)失去精度)
      if (slotCounts(room.slots)[team] >= teamLimit(room, team)) {
        return res.status(409).json({ error: team === 'spec' ? '观战席已满' : '该阵营已满' })
      }
      next = { team, slot: minFreeSlot(room.slots, team) }
    }
    room.slots = room.slots.map((s) => (s === member ? { ...s, ...next } : s))
    recalcCaptains(room); updateRoomRow(room.id, { slots: JSON.stringify(room.slots), captain_a: room.captainA, captain_b: room.captainB })
    res.json(broadcastRoom(io, room.id))
  })

  // 房主改配置
  router.post('/:id/config', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    const patch = {}
    const { bestOf, pickMode, teamA, teamB, specSeats, password, teamAName, teamBName, knifeRound, autoFill, friendlyFire, recordDemo, overtimeEnabled, allowDisplayName, spectatorJoin, maxPlayers, maxRounds, duelPreset, mapPoolKind } = req.body ?? {}
    if (bestOf != null) {
      const v = Number(bestOf)
      if (v !== 1 && v !== 3) return res.status(400).json({ error: 'bestOf 只能是 1 或 3' })
      // 社区地图模式仅支持 BO1 单图
      if (v === 3 && (patch.pick_mode === 'community' || room.pickMode === 'community')) {
        return res.status(400).json({ error: '社区地图模式仅支持 BO1' })
      }
      // 增强人机固定 BO1(跨图 bot_kick 后命名人机丢失与 warmup 配额覆盖问题,未验证)
      if (v === 3 && room.botMode) {
        return res.status(400).json({ error: '增强人机模式仅支持 BO1' })
      }
      patch.best_of = v
    }
      // 拼刀选边(2026-09-19 起全模式**默认关闭**;仅 custom 房间可开):
      // 单挑对决(1v1)房间禁止开启 —— 传 true 400;传 false/0 无意义,按 no-op 放行(兼容旧端全量草稿)
      if (knifeRound != null) {
        if (room.matchType === 'duel') {
          if (knifeRound === true) return res.status(400).json({ error: '单挑对决(1v1)房间不支持拼刀选边' })
        } else if (knifeRound === true && room.botMode) {
          // 刀战开关仅 BO1 生效(BO3 维持 knife);人机房间固定关闭(阵容互换未验证)
          return res.status(400).json({ error: '增强人机模式刀战固定关闭' })
        } else {
          patch.knife_round = knifeRound === true ? 1 : 0
        }
      }
    if (autoFill != null) {
      // v2 槽位面板「自动补位」开关(房主可控):0=点击空槽精确落位(默认) 1=自动落目标队最小空槽
      patch.auto_fill = autoFill === true ? 1 : 0
    }
    if (friendlyFire != null) {
      // 「友军伤害」开关(房主可控,默认开启):关闭时开赛经 MatchZy 比赛 JSON cvars 下发
      // mp_friendlyfire 1 + ff_damage_reduction_bullets 0(队友免疫子弹伤害,见 lib/friendlyfire.js);
      // 仅影响开赛时下发的比赛 JSON,对进行中的比赛无效
      patch.friendly_fire = friendlyFire === true ? 1 : 0
    }
    if (overtimeEnabled != null) {
      if (typeof overtimeEnabled !== 'boolean') return res.status(400).json({ error: 'overtimeEnabled 必须为布尔值' })
      if (room.matchType === 'duel' && overtimeEnabled) return res.status(400).json({ error: '单挑对决不支持加时' })
      patch.overtime_enabled = overtimeEnabled ? 1 : 0
    }
    const effectiveBestOf = patch.best_of ?? room.bestOf
    if (effectiveBestOf === 3) {
      if (room.matchType === 'duel') return res.status(400).json({ error: '单挑对决仅支持 BO1' })
      if (overtimeEnabled === false) return res.status(400).json({ error: 'BO3 必须开启加时' })
      patch.overtime_enabled = 1
    }
    if (recordDemo != null) {
      // 「对局录像」开关(房主可控,默认开启):关闭时开赛比赛 JSON 下发 record_demo: false,
      // 完赛后不等待 Demo 上传立即解除实例冷却
      patch.record_demo = recordDemo === true ? 1 : 0
    }
    if (allowDisplayName != null) {
      // 「允许玩家修改显示名」开关(房间级,房主/管理员可改,**默认关闭**):
      // 关闭 = 只有管理员能设置显示名(玩家自助改名 403);开启 = 玩家可改自己。
      // 关掉开关不会清除已设置的名字(管理员可用 name:"" 逐个清除)
      patch.allow_display_name = allowDisplayName === true ? 1 : 0
    }
    if (spectatorJoin != null) {
      // 「允许中途加入观战」开关(房间级,房主可改,**默认开启**):关闭后本房间拒绝非名单观战申请;
      // 平台级总开关 settings.spectator_join(管理员)仍是上位门控,两者都开才允许
      patch.spectator_join = spectatorJoin === true ? 1 : 0
    }
    if (pickMode != null) {
      if (!['direct', 'veto', 'community'].includes(pickMode)) return res.status(400).json({ error: '无效选图模式' })
      // 单挑对决(1v1)固定直接选图(地图池经 mapPoolKind 选择):拒绝任何经 API 切回 BP/社区图的尝试,
      // 存量 duel 房间的 veto/community 由前端自动纠正为 direct(本端点允许该纠正)
      if (room.matchType === 'duel' && pickMode !== 'direct') {
        return res.status(400).json({ error: '单挑对决(1v1)房间选图方式固定为直接选图(地图池经「地图池选择」切换)' })
      }
      patch.pick_mode = pickMode
    }
    if (mapPoolKind != null) {
      // 单挑对决「地图池选择」(仅 1v1 房间,direct 选图生效):total=总竞技图池(默认)/ duel=单挑图池
      if (room.matchType !== 'duel') return res.status(400).json({ error: '仅单挑对决(1v1)房间支持地图池选择' })
      if (!['total', 'duel'].includes(mapPoolKind)) return res.status(400).json({ error: '无效地图池选择(可选 total / duel)' })
      patch.map_pool_kind = mapPoolKind
    }
    if (duelPreset != null) {
      // 单挑对决玩法类型(仅 1v1 房间可传):rifle=长枪决斗(默认)/ pistol=手枪决斗 / sniper=狙击决斗 / solo=Solo三项
      if (room.matchType !== 'duel') return res.status(400).json({ error: '仅单挑对决(1v1)房间支持玩法类型' })
      if (!normalizeDuelPreset(duelPreset)) return res.status(400).json({ error: '无效玩法类型(可选 rifle / pistol / sniper / solo)' })
      patch.duel_preset = duelPreset
    }
    if (maxRounds !== undefined) {
      // 单挑对决回合局数(mp_maxrounds):仅 duel 房间可改;必须为**奇数**
      // (偶数打满可能平分,无法分辨胜负);null/'' = 恢复默认(跟随玩法类型:31,或 solo 固定 51)。
      // 仅影响开赛时下发的比赛 JSON(经 cvars 覆盖 live.cfg 的 mp_maxrounds 24,见 lib/duel.js),
      // 对进行中的比赛无效
      if (room.matchType !== 'duel') return res.status(400).json({ error: '仅单挑对决(1v1)房间支持修改回合局数' })
      if (normalizeDuelPreset(patch.duel_preset ?? room.duelPreset) === 'solo') {
        // Solo三项的阶段(10 手枪+28 长枪+13 狙击)仅对总回合 51 成立 → 锁定,不可修改
        return res.status(400).json({ error: 'Solo三项固定 51 回合(10 手枪+28 长枪+13 狙击),不可修改回合局数' })
      }
      if (maxRounds === null || maxRounds === '') {
        patch.max_rounds = null
      } else {
        const v = Number(maxRounds)
        if (!Number.isInteger(v) || v < DUEL_MIN_ROUNDS || v > DUEL_MAX_ROUNDS) {
          return res.status(400).json({ error: `回合局数需为 ${DUEL_MIN_ROUNDS}~${DUEL_MAX_ROUNDS} 的整数` })
        }
        if (v % 2 === 0) return res.status(400).json({ error: '回合局数必须为单数(奇数),否则无法分辨胜负' })
        patch.max_rounds = v
      }
    }
    {
      // 切换选图模式,或 direct 模式下切换地图池选择 → 房间地图池同步为对应全局池,并清空全部选图/BP 状态。
      // 非 direct 模式下改地图池选择仅存偏好(切回 direct 时生效)
      const pickModeChanged = patch.pick_mode != null && patch.pick_mode !== room.pickMode
      const poolKindChanged = patch.map_pool_kind != null && patch.map_pool_kind !== (room.mapPoolKind || 'total')
      const effPickMode = patch.pick_mode ?? room.pickMode
      const effPoolKind = patch.map_pool_kind ?? room.mapPoolKind ?? 'total'
      if (pickModeChanged || (poolKindChanged && effPickMode === 'direct')) {
        if (effPickMode === 'community') patch.best_of = 1 // 社区地图模式仅 BO1 + 直接选取单张地图
        patch.map_pool = JSON.stringify(roomMapPool(effPickMode, room.matchType, effPoolKind))
        patch.banned = '[]'
        patch.picked = '[]'
        patch.veto_history = '[]'
        patch.veto_turn = 0
        patch.bp_phase = null
        patch.side_choices = '{}'
        patch.side_pending_for = null
        patch.veto_deadline_at = null
      }
    }
    if (teamAName != null) {
      const v = sanitizeTeamName(teamAName).trim()
      if (!v) return res.status(400).json({ error: '队名不能为空' })
      patch.team_a_name = v
    }
    if (teamBName != null) {
      const v = sanitizeTeamName(teamBName).trim()
      if (!v) return res.status(400).json({ error: '队名不能为空' })
      patch.team_b_name = v
    }
    if (teamA != null) {
      // 单挑对决房间的人数(常规建房锁 1v1):仅管理员可改,用于测试非 1v1 场景(2026-09-22 用户定档)
      if (room.matchType === 'duel' && !isAdmin(req.user.steam_id)) {
        return res.status(403).json({ error: '单挑对决房间的人数设置仅管理员可改' })
      }
      const v = Math.min(10, Math.max(1, Number(teamA) || 1))
      patch.team_a = v
    }
    if (teamB != null) {
      // 同上:单挑房人数仅管理员可改
      if (room.matchType === 'duel' && !isAdmin(req.user.steam_id)) {
        return res.status(403).json({ error: '单挑对决房间的人数设置仅管理员可改' })
      }
      const v = Math.min(10, Math.max(1, Number(teamB) || 1))
      patch.team_b = v
    }
    if (specSeats != null) {
      const v = Math.min(16, Math.max(0, Number(specSeats) || 0))
      patch.spec_seats = v
    }
    if (typeof password === 'string') patch.password = password.slice(0, 32)
    // 房间级实例最大玩家数(-maxplayers):仅管理员可改;null/'' = 清除覆盖,跟随全局默认
    if (maxPlayers !== undefined) {
      if (!isAdmin(req.user.steam_id)) return res.status(403).json({ error: '仅管理员可调整房间实例的最大玩家数' })
      if (maxPlayers === null || maxPlayers === '') {
        patch.max_players = null
      } else {
        const v = Number(maxPlayers)
        if (!Number.isInteger(v) || v < MIN_MAX_PLAYERS || v > MAX_MAX_PLAYERS) {
          return res.status(400).json({ error: `最大玩家数需为 ${MIN_MAX_PLAYERS}~${MAX_MAX_PLAYERS} 的整数` })
        }
        patch.max_players = v
      }
    }
    // 容量守卫:实例可用玩家席 = 最大玩家数 - SourceTV 席位;双方+观战(含人机)不得超过
    // (房间覆盖优先,其次全局默认;人机房过去写死 11,现随 maxplayers 设置联动)
    {
      const na = patch.team_a ?? room.teamA
      const nb = patch.team_b ?? room.teamB
      // 改 specSeats 时下面的压缩逻辑会把超出者移出房间,故以新值为准;否则按"配置 ∪ 实际槽位"
      const ns = patch.spec_seats !== undefined ? patch.spec_seats : specSeatsForCapacity(room.specSeats, room.slots)
      const effMax = patch.max_players !== undefined ? patch.max_players ?? getDefaultMaxPlayers() : room.maxPlayers
      const err = checkRoomCapacity({ teamA: na, teamB: nb, specSeats: ns, maxPlayers: effMax })
      if (err) return res.status(400).json({ error: err })
    }

    let slots = room.slots
    if (patch.team_a !== undefined || patch.team_b !== undefined || patch.spec_seats !== undefined) {
      slots = [...slots]
      // 超员按数组原顺序逐个移入观战席(分配观战席最小空槽)
      const trim = (team, limit) => {
        let over = slots.filter((s) => s.team === team).length - limit
        while (over-- > 0) {
          const idx = slots.findIndex((s) => s.team === team)
          if (idx < 0) break
          const moved = { ...slots[idx], team: 'spec', slot: minFreeSlot(slots, 'spec') }
          slots = slots.filter((_, i) => i !== idx)
          slots.push(moved)
        }
      }
      if (patch.team_a !== undefined) trim('ct', patch.team_a)
      if (patch.team_b !== undefined) trim('t', patch.team_b)
      if (patch.spec_seats !== undefined) {
        const specCount = slots.filter((s) => s.team === 'spec').length
        let over = specCount - patch.spec_seats
        if (over > 0) slots = slots.filter((s) => !(s.team === 'spec' && over-- > 0))
      }
      // 缩容的队伍槽位压缩(剩余成员按原槽位顺序收紧为 0..n-1)
      if (patch.team_a !== undefined) slots = compactTeamSlots(slots, 'ct')
      if (patch.team_b !== undefined) slots = compactTeamSlots(slots, 't')
      if (patch.spec_seats !== undefined) slots = compactTeamSlots(slots, 'spec')
      patch.slots = JSON.stringify(slots)
    }
    updateRoomRow(room.id, patch)
    res.json(broadcastRoom(io, room.id))
  })

  // 设置地图池:已移除 —— 房间地图池由全局池决定(veto=服役池 7 张 / direct=总池),切换选图模式时后端自动换池

  // 直接选图(切换勾选)
  router.post('/:id/directpick', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    // direct(官方)/ community(社区)均为直接选图;veto(BP) 走 /veto
    if (!['direct', 'community'].includes(room.pickMode) || room.status !== 'waiting') {
      return res.status(409).json({ error: '当前不可选图' })
    }
    const { mapId } = req.body ?? {}
    if (!room.mapPool.includes(mapId)) return res.status(400).json({ error: '地图不在地图池中' })
    // direct:BO1 不限张数(上限=地图池,由后端随机定本场图)/ BO3 限 bestOf 张
    // community:仅可直接选取单张地图(强制 BO1)
    const maxPicks = room.pickMode === 'community' ? 1 : room.bestOf === 1 ? room.mapPool.length : room.bestOf
    let picked = [...room.picked]
    if (picked.includes(mapId)) picked = picked.filter((id) => id !== mapId)
    else {
      if (picked.length >= maxPicks) {
        const msg = room.pickMode === 'community' ? '社区地图模式仅可选择 1 张地图' : `最多选择 ${maxPicks} 张地图`
        return res.status(409).json({ error: msg })
      }
      picked.push(mapId)
    }
    updateRoomRow(room.id, { picked: JSON.stringify(picked) })
    res.json(broadcastRoom(io, room.id))
  })

  // 开始 BP(仅 pickMode=veto 的房间;direct/community 不走 BP)
  router.post('/:id/veto/start', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    // 单挑对决固定直接选图(/config 已拒绝切换,此为存量数据/其他通道的兜底闸门)
    if (room.matchType === 'duel') return res.status(409).json({ error: '单挑对决(1v1)房间仅支持直接选图' })
    if (room.status !== 'waiting') return res.status(409).json({ error: '当前状态不可开始选图' })
    if (room.pickMode !== 'veto') return res.status(409).json({ error: '仅选图方式为 BP 的房间可开始选图' })
    updateRoomRow(room.id, {
      status: 'vetoing',
      banned: '[]',
      picked: '[]',
      veto_history: '[]',
      veto_turn: 0,
      bp_phase: 'ban',
      side_choices: '{}',
      side_pending_for: null,
      veto_deadline_at: Date.now() + ctx.config.vetoTurnTimeoutMs,
    })
    res.json(broadcastRoom(io, room.id))
  })

  // BP 操作(ban/pick,轮次与阶段校验)
  // 权限:房主 / 管理员 / 当前轮次队伍的队长
  router.post('/:id/veto', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (room.status !== 'vetoing') return res.status(409).json({ error: '不在选图阶段' })
    if (room.sidePendingFor) return res.status(409).json({ error: '当前为选边阶段,请先选边' })
    if (!isHost(req, room) && !isAdmin(req.user.steam_id)) {
      const turnTeam = currentVetoTeam(room)
      const captain = turnTeam === 'ct' ? room.captainA : room.captainB
      if (captain !== req.user.steam_id) {
        return res.status(403).json({ error: '仅当前轮次队伍的队长可以操作' })
      }
    }
    const { mapId, type } = req.body ?? {}
    if (!['ban', 'pick'].includes(type)) return res.status(400).json({ error: '无效操作类型' })
    try {
      const { patch } = applyVetoAction(room, mapId, type, req.user.steam_id, ctx.config.vetoTurnTimeoutMs)
      updateRoomRow(room.id, patch)
      res.json(broadcastRoom(io, room.id))
    } catch (err) {
      res.status(409).json({ error: err.message })
    }
  })

  // 选边(side 子阶段):轮到选边的队伍队长 / 房主 / 管理员;超时默认 CT(vetotimer)
  router.post('/:id/side', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (room.status !== 'vetoing') return res.status(409).json({ error: '不在选图阶段' })
    if (!room.sidePendingFor) return res.status(409).json({ error: '当前没有待选边' })
    const pendingCaptain = room.sidePendingFor === 'team2' ? room.captainB : room.captainA
    if (!isHost(req, room) && !isAdmin(req.user.steam_id) && pendingCaptain !== req.user.steam_id) {
      return res.status(403).json({ error: '仅待选边队伍的队长可以选边' })
    }
    const { side } = req.body ?? {}
    try {
      const { patch } = applySideChoice(room, side, req.user.steam_id, ctx.config.vetoTurnTimeoutMs)
      updateRoomRow(room.id, patch)
      res.json(broadcastRoom(io, room.id))
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // 重置 BP
  router.post('/:id/veto/reset', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    updateRoomRow(room.id, {
      status: 'waiting',
      banned: '[]',
      picked: '[]',
      veto_history: '[]',
      veto_turn: 0,
      bp_phase: null,
      side_choices: '{}',
      side_pending_for: null,
      veto_deadline_at: null,
    })
    res.json(broadcastRoom(io, room.id))
  })

  // 换位申请(任意队员发起;目标为另一队队员或观战;开始后禁止)
  router.post('/:id/swap/request', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!isPrepStatus(room.status)) return res.status(409).json({ error: '比赛开始后禁止换位' })
    const { targetPlayerId } = req.body ?? {}
    const me = room.slots.find((s) => s.player.steamId === req.user.steam_id)
    const target = room.slots.find((s) => s.player.steamId === targetPlayerId)
    if (!me) return res.status(403).json({ error: '你不在房间中' })
    if (!target || target.player.steamId === me.player.steamId) return res.status(400).json({ error: '目标玩家不在房间中' })
    if (target.isBot) return res.status(400).json({ error: '人机无法参与换位申请' })
    if (me.team === target.team) return res.status(400).json({ error: '同队成员无需换位' })
    setPendingSwap(room.id, me.player.steamId, target.player.steamId)
    res.json(broadcastRoom(io, room.id))
  })

  // 换位响应(仅目标本人;同意则互换位置)
  router.post('/:id/swap/respond', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!isPrepStatus(room.status)) return res.status(409).json({ error: '比赛开始后禁止换位' })
    const pending = getPendingSwap(room.id)
    if (!pending) return res.status(400).json({ error: '没有待确认的换位申请(可能已过期)' })
    if (pending.targetPlayerId !== req.user.steam_id) {
      return res.status(403).json({ error: '只有目标玩家可以响应' })
    }
    const { accept } = req.body ?? {}
    if (accept !== true && accept !== false) return res.status(400).json({ error: 'accept 必须为布尔值' })
    consumePendingSwap(room.id)
    if (!accept) return res.json(broadcastRoom(io, room.id))

    const from = room.slots.find((s) => s.player.steamId === pending.fromPlayerId)
    const target = room.slots.find((s) => s.player.steamId === pending.targetPlayerId)
    if (!from || !target) return res.status(400).json({ error: '申请方或目标已不在房间' })
    if (from.team === target.team) return res.status(400).json({ error: '双方已同队,无需换位' })
    // 队长参与 → 失去队长资格,两队按第一位重选
    const captainInvolved = room.captainA === from.player.steamId || room.captainA === target.player.steamId || room.captainB === from.player.steamId || room.captainB === target.player.steamId
    // 互换 seat:team 与 slot 一并交换(各自原槽留给对方,不压缩补位)
    room.slots = room.slots.map((s) => {
      if (s.player.steamId === from.player.steamId) return { ...s, team: target.team, slot: target.slot }
      if (s.player.steamId === target.player.steamId) return { ...s, team: from.team, slot: from.slot }
      return s
    })
    if (captainInvolved) {
      recalcCaptainsAfterMove(room)
    } else {
      recalcCaptains(room)
    }
    updateRoomRow(room.id, { slots: JSON.stringify(room.slots), captain_a: room.captainA, captain_b: room.captainB })
    res.json(broadcastRoom(io, room.id))
  })

  // 移交队长(仅当前队长,目标须同队)
  router.post('/:id/captain/transfer', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!isPrepStatus(room.status)) return res.status(409).json({ error: '比赛开始后禁止移交队长' })
    const { targetPlayerId } = req.body ?? {}
    const teamOf = (steamId) => room.slots.find((s) => s.player.steamId === steamId)?.team ?? null
    const myTeam = teamOf(req.user.steam_id)
    const target = room.slots.find((s) => s.player.steamId === targetPlayerId)
    const isCaptainA = room.captainA === req.user.steam_id && myTeam === 'ct'
    const isCaptainB = room.captainB === req.user.steam_id && myTeam === 't'
    if (!isCaptainA && !isCaptainB) return res.status(403).json({ error: '只有队长可以移交队长' })
    if (!target || target.player.steamId === req.user.steam_id) return res.status(400).json({ error: '目标玩家不在房间中' })
    if (teamOf(target.player.steamId) !== myTeam) return res.status(400).json({ error: '只能移交给同队队员' })
    const patch = myTeam === 'ct' ? { captain_a: target.player.steamId } : { captain_b: target.player.steamId }
    updateRoomRow(room.id, patch)
    res.json(broadcastRoom(io, room.id))
  })

  // 随机分队(仅房主;观战不参与;两队人数保持;至少 2 人换队)
  router.post('/:id/shuffle', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    if (!isPrepStatus(room.status)) return res.status(409).json({ error: '比赛开始后禁止随机分队' })
    // 增强人机:阵营固定(真人 vs 人机),不允许洗牌
    if (room.botMode) return res.status(400).json({ error: '增强人机模式不支持随机分队' })
    const includeCaptains = req.body?.includeCaptains !== false

    const ctBefore = new Set(teamMembers(room.slots, 'ct').map((s) => s.player.steamId))
    const tBefore = new Set(teamMembers(room.slots, 't').map((s) => s.player.steamId))
    const ctCount = ctBefore.size
    const tCount = tBefore.size
    const captains = new Set([room.captainA, room.captainB].filter(Boolean))
    // 参与洗牌的成员:两队队员;includeCaptains=false 时队长留队
    let pool = [...ctBefore, ...tBefore]
    const frozen = new Map() // steamId → 固定队伍
    if (!includeCaptains) {
      pool = pool.filter((id) => !captains.has(id))
      for (const [team, set] of [['ct', ctBefore], ['t', tBefore]]) {
        for (const id of set) {
          if (captains.has(id)) frozen.set(id, team)
        }
      }
    }
    if (pool.length === 0) return res.status(400).json({ error: '没有可参与随机分队的队员' })

    // 随机分配(保持两队人数;≥2 人换队;重试兜底)
    const totalChange = (assign) => {
      let changes = 0
      for (const [id, after] of assign) {
        const before = ctBefore.has(id) ? 'ct' : 't'
        if (before !== after) changes++
      }
      return changes
    }
    let assign = new Map()
    for (let attempt = 0; attempt < 20; attempt++) {
      assign = new Map()
      const shuffled = [...pool].sort(() => Math.random() - 0.5)
      // 先固定队长,再填充
      for (const [id, team] of frozen) assign.set(id, team)
      const freeCt = ctCount - [...frozen.values()].filter((t) => t === 'ct').length
      const candidates = shuffled.filter((id) => !assign.has(id))
      const ctPick = candidates.slice(0, freeCt)
      for (const id of candidates) assign.set(id, ctPick.includes(id) ? 'ct' : 't')
      if (totalChange(assign) >= 2) break
    }
    if (totalChange(assign) < 2) {
      // 兜底:优先交换一对非冻结(队长)玩家;无可交换的非冻结对时才动队长(最后手段)
      const ids = [...assign.keys()]
      const ctIds = ids.filter((id) => assign.get(id) === 'ct')
      const tIds = ids.filter((id) => assign.get(id) === 't')
      const freeCt = ctIds.filter((id) => !frozen.has(id))
      const freeT = tIds.filter((id) => !frozen.has(id))
      if (freeCt.length > 0 && freeT.length > 0) {
        assign.set(freeCt[0], 't')
        assign.set(freeT[0], 'ct')
      } else if (ctIds.length > 0 && tIds.length > 0) {
        assign.set(ctIds[0], 't')
        assign.set(tIds[0], 'ct')
      }
    }

    room.slots = room.slots.map((s) => {
      if (s.team === 'spec') return s // 观战不参与
      return { ...s, team: assign.get(s.player.steamId) }
    })
    // 分队后每队随机重排槽位(0..n-1 连续无空洞)
    room.slots = shuffleTeamSlots(shuffleTeamSlots(room.slots, 'ct'), 't')
    if (includeCaptains) recalcCaptainsAfterMove(room)
    else recalcCaptains(room)
    updateRoomRow(room.id, { slots: JSON.stringify(room.slots), captain_a: room.captainA, captain_b: room.captainB })
    res.json(broadcastRoom(io, room.id))
  })

  // ============ 增强人机:人机管理(仅房主;仅 botMode 房间;仅准备阶段) ============
  function guardBotsRoom(req, res, room, action) {
    if (!room.botMode) {
      res.status(400).json({ error: '仅增强人机房间可管理人机' })
      return false
    }
    if (!isPrepStatus(room.status)) {
      res.status(409).json({ error: `比赛开始后禁止${action}` })
      return false
    }
    return true
  }

  // 添加人机:single=指定名字 / random=名字池随机 / proteam=整队添加(仅 TeamB,需 ≥5 空位)
  router.post('/:id/bots', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    if (!guardBotsRoom(req, res, room, '添加人机')) return
    const { mode } = req.body ?? {}
    let slots = room.slots
    const patch = {}

    if (mode === 'single') {
      const name = sanitizeBotName(req.body?.name)
      if (!name) return res.status(400).json({ error: '人机名仅限字母/数字/空格/._-,且 ≤24 字符' })
      const team = req.body?.team === 'ct' ? 'ct' : 't' // TeamA(TeamA) 可选加人机;TeamB 全人机
      const limit = team === 'ct' ? room.teamA : room.teamB
      if (slots.filter((s) => s.team === team).length >= limit) return res.status(409).json({ error: '该阵营已满' })
      slots = [...slots, makeBotSlot(name, team, minFreeSlot(slots, team), nextBotSeq(slots))]
    } else if (mode === 'random') {
      const team = req.body?.team === 'ct' ? 'ct' : 't'
      const limit = team === 'ct' ? room.teamA : room.teamB
      const free = limit - slots.filter((s) => s.team === team).length
      const used = usedBotNames(slots)
      const pool = BOT_NAME_POOL.filter((n) => !used.has(n))
      const count = Math.max(0, Math.min(Number(req.body?.count) || 1, pool.length))
      if (free === 0) return res.status(409).json({ error: '该阵营已满' })
      if (count === 0) return res.status(400).json({ error: '无效数量' })
      if (count > free) return res.status(409).json({ error: `该阵营仅剩 ${free} 个空位` })
      const picks = [...pool].sort(() => Math.random() - 0.5).slice(0, count)
      let seq = nextBotSeq(slots)
      for (const name of picks) {
        slots = [...slots, makeBotSlot(name, team, minFreeSlot(slots, team), seq++)]
      }
    } else if (mode === 'proteam') {
      const pt = getProTeam(req.body?.teamId)
      if (!pt) return res.status(400).json({ error: '未知职业队' })
      // 职业队仅 TeamB;要求 TeamB 至少 5 个空位(TeamA 无法添加职业队)
      const tFree = room.teamB - slots.filter((s) => s.team === 't').length
      if (tFree < 5) return res.status(409).json({ error: 'TeamB 至少需要 5 个空位才能添加职业队' })
      const used = usedBotNames(slots)
      if (pt.roster.some((n) => used.has(n))) return res.status(409).json({ error: '队内人机名已被占用' })
      let seq = nextBotSeq(slots)
      for (const name of pt.roster) {
        slots = [...slots, makeBotSlot(name, 't', minFreeSlot(slots, 't'), seq++)]
      }
      // 队名/队标随职业队写入,开赛时经 mp_teamname_2(JSON 队名)/ mp_teamlogo_2 生效
      patch.team_b_name = pt.name
      patch.bot_proteam = pt.id
    } else {
      return res.status(400).json({ error: 'mode 仅支持 single / random / proteam' })
    }

    patch.slots = JSON.stringify(slots)
    updateRoomRow(room.id, patch)
    res.json(broadcastRoom(io, room.id))
  })

  // 移除人机:带 botId 移单个;不带移除全部(全部移除时同步清掉职业队标记)
  router.delete('/:id/bots/:botId?', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    if (!guardBotsRoom(req, res, room, '移除人机')) return
    const botId = req.params.botId
    const before = room.slots.length
    room.slots = botId
      ? room.slots.filter((s) => !(s.isBot && s.player.id === botId))
      : room.slots.filter((s) => !s.isBot)
    if (botId && room.slots.length === before) return res.status(404).json({ error: '人机不存在' })
    updateRoomRow(room.id, {
      slots: JSON.stringify(room.slots),
      ...(botId ? {} : { bot_proteam: null }),
    })
    res.json(broadcastRoom(io, room.id))
  })

  // 人机调优:瞄准模式(bot_aim)/ 道具模式(bot_nades),开赛后经控制台下发
  router.post('/:id/botconfig', auth, (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    if (!guardBotsRoom(req, res, room, '修改人机设置')) return
    const { botAim, botNades } = req.body ?? {}
    const patch = {}
    if (botAim != null) {
      if (!BOT_AIM_MODES.includes(botAim)) return res.status(400).json({ error: '无效瞄准模式(mixed/head/body)' })
      patch.bot_aim = botAim
    }
    if (botNades != null) {
      if (!BOT_NADE_MODES.includes(botNades)) return res.status(400).json({ error: '无效道具模式(off/less/normal/more/max)' })
      patch.bot_nades = botNades
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: '缺少 botAim / botNades' })
    updateRoomRow(room.id, patch)
    res.json(broadcastRoom(io, room.id))
  })

  // 服务器选择(仅房主,waiting 状态;两级:先选组,再选组内实例)
  router.post('/:id/server', auth, async (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    if (room.status !== 'waiting') return res.status(409).json({ error: '当前状态不可选择服务器' })
    const { mode, group, instance } = req.body ?? {}

    if (mode === 'auto') {
      updateRoomRow(room.id, { server_choice: JSON.stringify({ mode: 'auto', group: null, instance: null }) })
      return res.json(broadcastRoom(io, room.id))
    }
    if (mode !== 'manual') return res.status(400).json({ error: 'mode 仅支持 auto / manual' })
    if (typeof group !== 'string' || !group) return res.status(400).json({ error: '请选择服务器组' })
    const srv = getGameServer(group)
    if (!srv || !srv.is_active) return res.status(400).json({ error: '服务器组不可用' })

    let inst = null
    if (instance != null && instance !== '') {
      // 增强人机:仅 bot 实例可选(装了 CS2-Bot-Improver 的实例)
      if (room.botMode && instance !== ctx.config.botInstanceName) {
        return res.status(400).json({ error: `增强人机模式仅支持 ${ctx.config.botInstanceName} 实例` })
      }
      const row = getDb().prepare('SELECT * FROM instances WHERE name = ?').get(instance)
      if (!row || row.game_server_id !== group) return res.status(400).json({ error: '实例不存在或不属于该服务器组' })
      // 维护守卫:该组维护中(更新任务进行中)→ 手动选实例一律拒绝
      {
        const maint = maintenanceMessage(row.game_server_id)
        if (maint) return res.status(409).json({ error: maint })
      }
      if (row.admin_only && !isAdmin(req.user.steam_id)) {
        return res.status(403).json({ error: '该实例仅管理员可选择' })
      }
      if (row.state === 'in_match' || row.state === 'booting') return res.status(409).json({ error: '该实例正在使用中' })
      if (row.state === 'cooling') return res.status(409).json({ error: '该实例冷却中,请稍后' })
      // 供给中(创建/删除/失败)的实例不可手动选择(M5;与 pickFree/validateManualInstance 同口径)
      if (row.provision_state) return res.status(409).json({ error: provisioningMessage(row) })
      try {
        await validateManualInstance(instance, isAdmin(req.user.steam_id))
      } catch (e) {
        return res.status(400).json({ error: e.message })
      }
      inst = instance
    }

    updateRoomRow(room.id, { server_choice: JSON.stringify({ mode: 'manual', group, instance: inst }) })
    res.json(broadcastRoom(io, room.id))
  })

  // 开赛(核心:实例编排全流程;waiting→starting 原子过渡防并发重复开赛)
  router.post('/:id/start', auth, async (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    // 维护守卫**必须在置 starting 之前**(否则失败回滚会把房间卡在 starting)
    {
      const choice = room.serverChoice || {}
      const maint = choice.group ? maintenanceMessage(choice.group) : null
      if (maint) return res.status(409).json({ error: maint + ',暂停开赛' })
    }
    const ok = getDb()
      .prepare("UPDATE rooms SET status = 'starting' WHERE id = ? AND status = 'waiting'")
      .run(room.id)
    if (Number(ok.changes) === 0) return res.status(409).json({ error: '开赛中,请勿重复点击' })
    clearRoomSwaps(room.id)
    broadcastRoom(io, room.id)
    try {
      const result = await startMatch({ roomId: room.id, io })
      res.json(result)
    } catch (err) {
      // 失败回滚(若 startMatch 未处理)
      getDb().prepare("UPDATE rooms SET status = 'waiting' WHERE id = ? AND status = 'starting'").run(room.id)
      broadcastRoom(io, room.id)
      res.status(500).json({ error: err.message })
    }
  })

  // 对局内显示名(比赛用 id):与房间绑定,只在本房间生效
  // 权限:玩家改自己需房间开关 allowDisplayName 打开(默认关闭);管理员始终可改房内任意玩家
  // 生效时机:开赛时写入比赛 JSON 的玩家名(MatchZy 强制名文件 → 引擎显示);进行中的比赛不受影响
  router.post('/:id/display-name', auth, (req, res) => {
    const row = getRoomRow(req.params.id)
    if (!row) return res.status(404).json({ error: '房间不存在' })
    const room = getRoomJson(row.id)
    const admin = isAdmin(req.user.steam_id)
    const targetId = String(req.body?.playerId ?? req.user.steam_id)
    if (targetId !== req.user.steam_id && !admin) {
      return res.status(403).json({ error: '仅管理员可修改他人的对局显示名' })
    }
    // 房间开关(默认关闭):关闭时玩家不能自助改名;管理员不受限
    if (!room.allowDisplayName && !admin) {
      return res.status(403).json({ error: '本房间未开放玩家自定义显示名(房主可在房间设置中开启)' })
    }
    if (!room.slots.some((s) => s.player.steamId === targetId)) {
      return res.status(404).json({ error: '该玩家不在房间内' })
    }
    let name
    try {
      name = normalizeDisplayName(req.body?.name)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
    const map = pruneDisplayNames(room.slots, getDisplayNames(row))
    if (name === null) delete map[targetId]
    else map[targetId] = name
    updateRoomRow(row.id, { display_names: JSON.stringify(map) })
    res.json(broadcastRoom(io, row.id))
  })

  // 非名单用户中途加入观战(全局开关「允许中途观战」,默认不允许)
  // 机制:把当前登录用户追加进实例侧 spectators 名单(matchzy_addplayer … spec)后再连接。
  // 仅观战:MatchZy 按名单守卫阵营,jointeam 被拦截、EventPlayerTeam 会把玩家拉回观战席。
  router.post('/:id/spectate', auth, async (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    // 房间级开关(房主在「更多设置 → 比赛设置」里控制,默认开启)
    if (room.spectatorJoin === false) {
      return res.status(403).json({ error: '本房间未开启中途加入观战(房主可在「更多设置」中开启)' })
    }
    // 平台级总开关(管理员 `PUT /api/settings/spectator-join`,默认开启;关闭时全平台一律拒绝)
    if (!getSpectatorJoinSetting().allow) {
      return res.status(403).json({ error: '平台已关闭非名单中途观战(管理员总开关)' })
    }
    if (room.status !== 'live') return res.status(409).json({ error: '比赛未在进行中' })
    const match = getDb()
      .prepare("SELECT * FROM matches WHERE room_id = ? AND status NOT IN ('ended', 'aborted') ORDER BY id DESC LIMIT 1")
      .get(room.id)
    if (!match) return res.status(409).json({ error: '当前没有进行中的比赛' })
    // 已是名单内玩家(参赛/观战席):无需追加,直接给连接信息
    if (matchRosterHasSteamId(match.payload, req.user.steam_id)) {
      return res.json({ ok: true, alreadyInMatch: true, server: room.server ?? null })
    }
    try {
      const r = await addExtraSpectator({
        matchRow: match,
        roomRow: getRoomRow(room.id),
        steamId: req.user.steam_id,
        name: req.user.name,
      })
      res.json({ ok: true, alreadyInMatch: false, ...r, server: room.server ?? null })
    } catch (e) {
      res.status(/席位/.test(e.message) ? 409 : 502).json({ error: e.message })
    }
  })

  // 强制结束比赛
  router.post('/:id/end', auth, async (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    clearRoomSwaps(room.id)
    const matchId = await forceEndMatch({ roomId: room.id, io })
    res.json({ ok: true, matchId })
  })

  // 解散房间
  router.delete('/:id', auth, async (req, res) => {
    const room = getRoomJson(req.params.id)
    if (!room) return res.status(404).json({ error: '房间不存在' })
    if (!guardHost(req, res, room)) return
    clearRoomSwaps(room.id)
    if (room.status === 'live') {
      await forceEndMatch({ roomId: room.id, io }).catch(() => {})
    }
    getDb().prepare('DELETE FROM rooms WHERE id = ?').run(room.id)
    io.to(`room:${room.id}`).emit('room:removed', room.id)
    res.json({ ok: true })
  })

  return router
}
