// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 实例编排:空闲分配 → 启动/重启 → 下发比赛 JSON → 锁与释放
import crypto from 'node:crypto'
import { getDb, now } from '../db.js'
import config from '../config.js'
import * as bridge from './bridge.js'
import { buildMatchJson, finalMaplist, isKnownMap, getCommunityMapByWorkshopId } from './matchjson.js'
import { getRoomRow, updateRoomRow, broadcastRoom, resetRoomAfterMatch, getDisplayNames, pruneDisplayNames } from './rooms.js'
import { instanceServer, getGameServer } from './gameServers.js'
import { isGroupInMaintenance, maintenanceMessage } from './jobs.js'
import { isAdmin } from './auth.js'
import { resolveHostIp } from './net.js'
import { BOT_NAME_POOL, buildBotCfg, makeBotSlot, nextBotSeq, usedBotNames } from './bots.js'
import { effectiveMaxPlayers, checkRoomCapacity, specSeatsForCapacity } from './roomlimits.js'
import { minFreeSlot } from './slots.js'
import { hasCapability, waitForArenaMatchResult, cancelArenaMatchResultWait } from './agentChannel.js'

// 本地状态缓存,避免频繁读库(listInstances 合并桥健康状态)
const MEM = new Map()

export function cacheInstances() {
  // 先清后填:DB 恒为唯一权威 —— 组编辑(PUT /api/game-servers/:id)整体替换清单、
  // 删组、硬删实例后,被移除的行不得继续留在缓存里,否则幽灵实例仍会被 /api/instances
  // 列出、被自动分配(pickFree)选中并下发到桥(旧实现只增不删;实例可分配状态约定)
  MEM.clear()
  const rows = getDb()
    .prepare(
      `SELECT name, port, state, match_id, admin_only, updated_at, game_server_id,
              idx, provision_state, provision_error, source, created_at
         FROM instances`,
    )
    .all()
  for (const r of rows) MEM.set(r.name, r)
  return MEM
}

/**
 * Backend process recovery for ArenaMatch loads that had not reached `series_start`.
 * Such a result may have been acknowledged by the old process while the DB match row
 * still says pending, so the safe action is to abort it and keep its instance locked
 * until the Go bridge confirms the binding has been closed after reconnect. If ownership
 * cannot be acquired without overwriting another match or provision operation, leave it
 * pending and log the conflict for operator review.
 */
export function recoverPendingArenaMatchesOnStartup() {
  const db = getDb()
  const ts = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const pending = db
      .prepare(
        `SELECT m.id, m.room_id, m.instance_name, i.state AS instance_state,
                i.match_id AS instance_match_id, i.provision_state, i.game_server_id
         FROM matches m
         LEFT JOIN instances i ON i.name = m.instance_name
         WHERE m.status = 'pending' AND (m.arena_match_bind_started = 1 OR m.arena_match_sha256 IS NOT NULL)
           AND m.instance_name IS NOT NULL`,
      )
      .all()
    const abortMatch = db.prepare(
      `UPDATE matches SET status = 'aborted', ended_at = ?
       WHERE id = ? AND status = 'pending' AND (arena_match_bind_started = 1 OR arena_match_sha256 IS NOT NULL)`,
    )
    const resetRoom = db.prepare(
      `UPDATE rooms
       SET status = 'waiting', server = NULL, banned = '[]', picked = '[]', veto_history = '[]',
           veto_turn = 0, bp_phase = NULL, side_choices = '{}', side_pending_for = NULL, veto_deadline_at = NULL
       WHERE id = ? AND status IN ('starting', 'live')`,
    )
    const holdInstance = db.prepare(
      `UPDATE instances SET state = 'booting', match_id = ?, updated_at = ?
       WHERE name = ? AND game_server_id = ? AND (match_id IS NULL OR match_id = ?)
         AND provision_state IS NULL AND (match_id = ? OR state != 'in_match')`,
    )
    let recovered = 0
    for (const match of pending) {
      const alreadyOwned = match.instance_match_id === match.id
      if (
        !match.game_server_id ||
        (match.instance_match_id != null && !alreadyOwned) ||
        match.provision_state != null ||
        (!alreadyOwned && match.instance_state === 'in_match')
      ) {
        console.warn(`[arena-match] 启动恢复 ${match.id}: 实例 ${match.instance_name} 不可安全占锁,保留 pending 状态供后续排查`)
        continue
      }
      const held = holdInstance.run(match.id, ts, match.instance_name, match.game_server_id, match.id, match.id)
      if (held.changes !== 1) {
        console.warn(`[arena-match] 启动恢复 ${match.id}: 实例 ${match.instance_name} 占锁条件变化,保留 pending 状态供后续排查`)
        continue
      }
      if (abortMatch.run(ts, match.id).changes !== 1) throw new Error(`ArenaMatch ${match.id} 启动恢复状态已变化`)
      resetRoom.run(match.room_id)
      recovered++
    }
    db.exec('COMMIT')
    cacheInstances()
    return recovered
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function listInstances() {
  return [...cacheInstances().values()].map((r) => ({
    name: r.name,
    port: r.port,
    // GOTV 端口按主机布局约定 = 端口 + 100(主机布局约定;桥侧权威值见 /api/host/status 的 instances[])
    gotvPort: r.port ? r.port + 100 : null,
    gameServerId: r.game_server_id ?? null,
    state: r.state,
    matchId: r.match_id,
    adminOnly: !!r.admin_only,
    idx: r.idx ?? null,
    provisionState: r.provision_state ?? null,
    provisionError: r.provision_error ?? null,
    source: r.source ?? null,
  }))
}

/** 单实例行(直读 DB,含 M5 供给列;不存在回 null)。 */
export function instanceRow(name) {
  return getDb().prepare('SELECT * FROM instances WHERE name = ?').get(name) ?? null
}

/** 供给状态写入口:provisionState=null 表示正常可用;provisionError 记录失败原因。 */
export function setProvisionState(name, provisionState, provisionError = null) {
  getDb()
    .prepare('UPDATE instances SET provision_state = ?, provision_error = ?, updated_at = ? WHERE name = ?')
    .run(provisionState, provisionError, now(), name)
  cacheInstances()
  return MEM.get(name) ?? null
}

/** 供给中的实例(creating/deleting)不可被分配/手动选择 —— 统一判定。 */
export function isProvisioning(row) {
  return !!row && row.provision_state != null
}

/** 供给中实例的统一文案(错误/409 提示)。 */
export function provisioningMessage(row) {
  const s = row?.provision_state
  if (s === 'deleting') return '该实例正在删除中'
  if (s === 'failed') return '该实例上次部署失败,需管理员重试或清理'
  if (s === 'unconfirmed') return '该实例由主机侧创建,待管理员确认'
  return '该实例正在创建中,请稍后'
}

export function instanceState(name) {
  return MEM.get(name)?.state ?? getDb().prepare('SELECT state FROM instances WHERE name = ?').get(name)?.state ?? 'idle'
}

// 自动分配:按顺序取第一个可用实例
// 规则:跳过 admin_only;cooling 先尝试解除;候选必须 health=RUNNING(系统绝不唤醒 STOPPED)
// onlyName 非空时仅考虑该实例(增强人机模式锁定 bot 实例)
async function pickFree(onlyName = null) {
  cacheInstances()
  for (const r of MEM.values()) {
    if (onlyName && r.name !== onlyName) continue
    if (r.admin_only) continue
    // 维护中的组跳过(更新任务期间自动分配永不落到该组;其他组不受影响)
    if (isGroupInMaintenance(r.game_server_id)) continue
    // 供给中(创建/删除)的实例跳过
    if (isProvisioning(r)) continue
    if (r.state === 'cooling') {
      tryReleaseCooling(r.name)
      if (MEM.get(r.name).state !== 'idle') continue
    }
    if (r.state !== 'idle') continue
    let health
    try {
      health = await bridge.instanceStatus(r.name)
    } catch {
      health = 'UNKNOWN'
    }
    if (health !== 'RUNNING') continue
    setState(r.name, 'booting', null)
    return r.name
  }
  return null
}

// 判断实例是否启用 ArenaMatch 链路:桥声明能力 + 配置开启/实例命中
export function isArenaMatchActive(inst) {
  const srv = instanceServer(inst)
  if (!srv) return false
  if (!hasCapability(srv.id, 'arena_match_ipc')) return false
  const am = config.arenaMatch || {}
  if (am.enabled) return true
  if (Array.isArray(am.instances) && am.instances.includes(inst)) return true
  return false
}

// 状态机写入口(idle/booting/in_match/cooling);workshop 下载期间也以 booting 占锁防自动分配
export function setState(name, state, matchId) {
  const ts = now()
  getDb().prepare('UPDATE instances SET state = ?, match_id = ?, updated_at = ? WHERE name = ?').run(state, matchId, ts, name)
  if (MEM.has(name)) MEM.set(name, { ...MEM.get(name), state, match_id: matchId, updated_at: ts })
  else {
    const port = getDb().prepare('SELECT port FROM instances WHERE name = ?').get(name)?.port ?? 0
    MEM.set(name, { name, state, match_id: matchId, updated_at: ts, port })
  }
  return MEM.get(name)
}

// 该比赛预期的 demo 是否已全部到账(每张图一个 demo)
function demosComplete(matchId) {
  const m = getDb().prepare('SELECT payload, status, current_scores, started_at FROM matches WHERE id = ?').get(matchId)
  if (!m) return true // 比赛行已不存在 → 视为完成
  let payload = {}
  try {
    payload = JSON.parse(m.payload)
  } catch {
    return true
  }
  // 1. 若配置关闭了录像，无需等待 demo，直接判定完成立即解除冷却
  if (payload.record_demo === false) return true

  const numMaps = payload.num_maps || 0
  if (numMaps <= 0) return true

  // 2. 按实际进入 live 的地图与结果计数；旧 MatchZy 若没有 map_result，
  // 使用 series_end 系列比分兜底，避免在收到 Demo 前提前解除冷却。
  let expectedMaps = numMaps
  if (m.status === 'ended' || m.status === 'aborted') {
    const mapResultsCount = getDb()
      .prepare("SELECT COUNT(DISTINCT dedup_key) AS c FROM events WHERE match_id = ? AND event_name = 'map_result'")
      .get(matchId)?.c ?? 0
    const liveCount = getDb()
      .prepare("SELECT COUNT(DISTINCT dedup_key) AS c FROM events WHERE match_id = ? AND event_name = 'going_live'")
      .get(matchId)?.c ?? 0
    let scoreCount = 0
    try {
      const scores = JSON.parse(m.current_scores || '{}')
      scoreCount = Math.max(0, Number(scores.team1_series_score || 0) + Number(scores.team2_series_score || 0))
    } catch {}
    expectedMaps = Math.min(numMaps, Math.max(mapResultsCount, liveCount, scoreCount))
    if (expectedMaps === 0 && m.status === 'ended') expectedMaps = numMaps
    if (expectedMaps === 0 && m.status === 'aborted' && m.started_at) expectedMaps = 1
  }
  if (expectedMaps <= 0) return true

  const got = getDb()
    .prepare('SELECT COUNT(DISTINCT map_number) AS c FROM demos WHERE match_id = ?')
    .get(matchId)?.c ?? 0
  return got >= expectedMaps
}

// 冷却解除:demo 全部到账(事件驱动)或兜底超时(上传失败场景)
export function tryReleaseCooling(name) {
  const cur = MEM.get(name)
  if (!cur || cur.state !== 'cooling') return cur
  const matchId = cur.match_id
  let timeoutMs = config.demo.forceEndCoolingTimeoutMs
  if (matchId != null) {
    const m = getDb().prepare('SELECT status, arena_match_bind_started, arena_match_sha256, arena_match_close_confirmed FROM matches WHERE id = ?').get(matchId)
    // Demo 到齐或冷却超时均不能替代桥确认关闭赛事绑定。
    if ((m?.arena_match_bind_started || m?.arena_match_sha256) && !m.arena_match_close_confirmed) return cur
    if (m && m.status !== 'aborted') timeoutMs = config.demo.coolingTimeoutMs
  }
  const expired = Date.now() - cur.updated_at > timeoutMs
  if (expired || (matchId != null && demosComplete(matchId))) {
    return setState(name, 'idle', null)
  }
  return cur
}

// series_end / forceEnd 后进入冷却:等待该比赛 demo 上传完成才可复用
export function releaseToCooling(name, matchId) {
  const cur = MEM.get(name) ?? {}
  if (matchId != null && cur.match_id != null && cur.match_id !== matchId) return
  setState(name, 'cooling', matchId)
}

// /api/demos 收到上传后调用:demo 到齐 → 解除对应实例冷却
export function demoArrived(matchId) {
  const m = getDb().prepare('SELECT instance_name FROM matches WHERE id = ?').get(matchId)
  if (!m?.instance_name) return
  const cur = MEM.get(m.instance_name)
  if (cur && cur.state === 'cooling' && cur.match_id === matchId) {
    tryReleaseCooling(m.instance_name)
  }
}

// 冷却状态扫描(保持 /api/instances 状态准确)
export function startCoolingSweep(intervalMs = 30000) {
  setInterval(() => {
    cacheInstances()
    for (const r of MEM.values()) {
      if (r.state === 'cooling') tryReleaseCooling(r.name)
    }
  }, intervalMs)
}

export function releaseInstance(name, matchId) {
  const cur = MEM.get(name) ?? {}
  if (matchId != null && cur.match_id != null && cur.match_id !== matchId) return
  setState(name, 'idle', null)
}

const ARENA_CLOSE_IN_FLIGHT = new Map()

// 终态比赛的桥绑定关闭确认会持久化；失败时实例继续占锁，桥心跳会重试。
export function confirmArenaMatchClose(name, matchId, closeBinding = bridge.bridgeArenaMatchClose) {
  const key = `${name}:${matchId}`
  if (ARENA_CLOSE_IN_FLIGHT.has(key)) return ARENA_CLOSE_IN_FLIGHT.get(key)
  const task = (async () => {
    const db = getDb()
    const match = db.prepare(
      'SELECT instance_name, status, arena_match_bind_started, arena_match_sha256, arena_match_close_confirmed FROM matches WHERE id = ?',
    ).get(matchId)
    if (!match || match.instance_name !== name || !(match.arena_match_bind_started || match.arena_match_sha256) || !['aborted', 'ended'].includes(match.status)) return false
    const owned = db.prepare('SELECT state, match_id FROM instances WHERE name = ?').get(name)
    if (!owned || owned.match_id !== matchId || !['booting', 'cooling', 'in_match'].includes(owned.state)) return false
    if (owned.state === 'in_match') {
      // 进程可在终态入库之后、进入冷却之前退出；重连时补齐这一步。
      db.prepare("UPDATE instances SET state = 'cooling', updated_at = ? WHERE name = ? AND state = 'in_match' AND match_id = ?")
        .run(now(), name, matchId)
      cacheInstances()
    }
    if (!match.arena_match_close_confirmed) {
      const closed = await closeBinding(name, matchId)
      const missingUnboundMeta = !match.arena_match_sha256 && /no such file|does not exist/i.test(closed.data?.error || '')
      if ((closed.status !== 200 || closed.data?.ok !== true) && !missingUnboundMeta) return false
      db.prepare('UPDATE matches SET arena_match_close_confirmed = 1 WHERE id = ?').run(matchId)
    }
    if (owned.state === 'booting') {
      // 启动失败/重启恢复均不需要等待 Demo；只释放仍属于本场的恢复锁。
      db.prepare("UPDATE instances SET state = 'idle', match_id = NULL, updated_at = ? WHERE name = ? AND state = 'booting' AND match_id = ?")
        .run(now(), name, matchId)
      cacheInstances()
    } else {
      cacheInstances()
      tryReleaseCooling(name)
    }
    return true
  })().catch((err) => {
    console.warn(`[arena-match] 关闭桥绑定失败 ${name}/${matchId}: ${err.message}`)
    return false
  }).finally(() => ARENA_CLOSE_IN_FLIGHT.delete(key))
  ARENA_CLOSE_IN_FLIGHT.set(key, task)
  return task
}

// 全部复位(管理接口用,如事件丢失导致锁泄漏;冷却一并解除)
export function resetAllInstances() {
  getDb().prepare("UPDATE instances SET state = 'idle', match_id = NULL WHERE state IN ('booting', 'in_match', 'cooling')").run()
  cacheInstances()
}

// 单个实例锁复位(admin 手动重置)
export function resetInstance(name) {
  getDb().prepare("UPDATE instances SET state = 'idle', match_id = NULL WHERE name = ?").run(name)
  cacheInstances()
}

// 设置实例分级(admin_only):普通(0)可被自动分配;仅管理员(1)只可管理员选择
export function setInstanceAdminOnly(name, adminOnly) {
  getDb().prepare('UPDATE instances SET admin_only = ? WHERE name = ?').run(adminOnly ? 1 : 0, name)
  cacheInstances()
}

// 手动选择实例校验(房主选择路径;要求 RUNNING,系统不唤醒)
export async function validateManualInstance(instanceName, hostIsAdmin) {
  const row = getDb().prepare('SELECT * FROM instances WHERE name = ?').get(instanceName)
  if (!row) throw new Error(`实例 ${instanceName} 不存在`)
  if (isProvisioning(row)) throw new Error(provisioningMessage(row))
  if (row.admin_only && !hostIsAdmin) throw new Error('该实例仅管理员可选择')
  const srv = getGameServer(row.game_server_id)
  if (!srv || !srv.is_active) throw new Error('实例所属服务器组不可用')
  const maint = maintenanceMessage(row.game_server_id)
  if (maint) throw new Error(maint)
  if (row.state === 'in_match') throw new Error('该实例正在比赛中')
  if (row.state === 'cooling') throw new Error('该实例冷却中,请稍后')
  if (row.state === 'booting') throw new Error('该实例正在启动中')
  let health
  try {
    health = await bridge.instanceStatus(instanceName)
  } catch {
    health = 'UNKNOWN'
  }
  if (health !== 'RUNNING') throw new Error('实例未运行,请管理员先启动')
  return instanceName
}

function parseServerChoice(roomRow) {
  if (!roomRow.server_choice) return null
  try {
    return JSON.parse(roomRow.server_choice)
  } catch {
    return null
  }
}

/**
 * 开赛全流程:
 * 1. 生成 matchid/token,比赛 JSON 落库
 * 2. 分配空闲实例 → 启动/重启 → 轮询 RUNNING
 * 3. msm send "matchzy_loadmatch_url ..." → 服务器主动 GET 拉取
 * 4. 房间置 live,写入服务器信息
 */
export async function startMatch({ roomId, io }) {
  const roomRow = getRoomRow(roomId)
  if (!roomRow) throw new Error('room not found')
  let slots = JSON.parse(roomRow.slots)
  const picked = JSON.parse(roomRow.picked)
  const mapPool = JSON.parse(roomRow.map_pool)
  let maplist = finalMaplist({ picked, mapPool })
  if (maplist.length < roomRow.best_of) throw new Error(`尚未完成选图(需 ${roomRow.best_of} 张)`)
  // BP 模式:选边未完成(或超时未默认)时禁止开赛
  if (roomRow.pick_mode === 'veto' && roomRow.side_pending_for) {
    throw new Error('请先完成选边(超时将自动默认 CT)')
  }
  // 维护守卫(纵深防御;路由层已在置 starting 之前拦一次):维护中的组一律不可开赛
  {
    const group = parseServerChoice(roomRow)?.group
    const maint = group ? maintenanceMessage(group) : null
    if (maint) throw new Error(maint + ',暂停开赛')
  }

  // 未知地图校验:目录(maps 表)外的官方名/旧别名无法换图(MatchZy IsMapValid 会静默跳过)
  const unknown = maplist.filter((id) => !isKnownMap(id))
  if (unknown.length > 0) throw new Error(`未知地图,请检查地图池: ${unknown.join(', ')}`)

  // 本场地图:BO1 直接选图且勾选多张 → 后端随机取一张作为实际比赛图(picked 集合保留不覆盖)
  let finalMap = maplist[0] ?? null
  if (roomRow.pick_mode === 'direct' && roomRow.best_of === 1 && maplist.length > 1) {
    finalMap = maplist[Math.floor(Math.random() * maplist.length)]
    maplist = [finalMap]
  }

  // 增强人机:TeamB 自动补满随机命名人机(名字池内本房间未用名)
  if (roomRow.bot_mode) {
    const tNeed = roomRow.team_b - slots.filter((s) => s.team === 't').length
    if (tNeed > 0) {
      const used = usedBotNames(slots)
      const pool = BOT_NAME_POOL.filter((n) => !used.has(n))
      let seq = nextBotSeq(slots)
      for (const name of pool.slice(0, tNeed)) {
        slots = [...slots, makeBotSlot(name, 't', minFreeSlot(slots, 't'), seq++)]
      }
      getDb().prepare('UPDATE rooms SET slots = ? WHERE id = ?').run(JSON.stringify(slots), roomId)
      broadcastRoom(io, roomId)
    }
  }

  // 双方按各自名额校验(3v4/5v6 等不等人数房间也可开赛)
  const ctCount = slots.filter((s) => s.team === 'ct').length
  const tCount = slots.filter((s) => s.team === 't').length
  if (ctCount < roomRow.team_a || tCount < roomRow.team_b) {
    throw new Error(`开赛需 CT ${roomRow.team_a} 人 / T ${roomRow.team_b} 人(当前 ${ctCount} / ${tCount})`)
  }

  // 实例最大玩家数(-maxplayers):房间覆盖 ?? 全局默认;开赛时作为 MAXPLAYERS 传给 msm 启动进程。
  // 容量守卫与此前 config 端一致(观战/人机同占席位),防历史房间或默认值变更后超员
  const maxPlayers = effectiveMaxPlayers(roomRow)
  const capacityErr = checkRoomCapacity({
    teamA: roomRow.team_a,
    teamB: roomRow.team_b,
    specSeats: specSeatsForCapacity(roomRow.spec_seats, slots),
    maxPlayers,
  })
  if (capacityErr) throw new Error(capacityErr)

  // MatchZy ready 判定(0.8.15 源码 ReadySystem.IsTeamReady / Utility.CheckLiveRequired):
  //   每队 ready = 该队**全部已连接玩家都 ready** 且人数 ≥ players_per_team;两队都 ready、
  //   观战满足(min_spectators_to_ready=0 → 恒真)才 HandleMatchStart 开赛。
  // 故 players_per_team 取**两队名额的较大值**:任一队少人在场或有人未 ready 都不会开赛
  //   (旧值取 min:人数多的一队少 1 人也能开赛 —— "部分玩家 ready 就开游戏"的根因)。
  // 人数不等房间(3v4 等):MatchZy 只有单一阈值,较小队永远达不到大队名额,需该队全员 ready 后
  //   由任一队员输入 .forceready(阈值即 min_players_to_ready,故它取**较小队名额**;旧值
  //   teamA+teamB 让 forceready 永远无法达成)。ASYMMETRIC_READY=lenient 可回退旧口径(见 config.js)。
  // 增强人机:bot 不参与 ready(§7),按真人数 —— TeamA 真人数即阈值(TeamB 由 bot 补齐)
  let playersPerTeam, minPlayersToReady
  if (roomRow.bot_mode) {
    const humans = slots.filter((s) => s.team === 'ct' && !s.isBot).length
    if (humans < 1) throw new Error('增强人机模式需 TeamA 至少 1 名真人玩家')
    playersPerTeam = humans
    minPlayersToReady = humans
  } else if (config.asymmetricReady === 'lenient') {
    playersPerTeam = Math.min(roomRow.team_a, roomRow.team_b)
    minPlayersToReady = Math.min(roomRow.team_a, roomRow.team_b)
  } else {
    playersPerTeam = Math.max(roomRow.team_a, roomRow.team_b)
    minPlayersToReady = Math.min(roomRow.team_a, roomRow.team_b)
  }
  const roomForJson = {
    slots,
    teamAName: roomRow.team_a_name,
    teamBName: roomRow.team_b_name,
    bestOf: roomRow.best_of,
    knifeRound: !!roomRow.knife_round,
    friendlyFire: roomRow.friendly_fire == null ? true : !!roomRow.friendly_fire,
    overtimeEnabled: roomRow.overtime_enabled == null ? true : !!roomRow.overtime_enabled,
    recordDemo: roomRow.record_demo == null ? true : !!roomRow.record_demo,
    pickMode: roomRow.pick_mode,
    // 单挑对决(1v1)开局 cfg:matchType 判定 + maxRounds/duelPreset(原样下发,duel.js 内解析默认与 solo 锁定)
    matchType: roomRow.match_type,
    maxRounds: roomRow.max_rounds ?? null,
    duelPreset: roomRow.duel_preset ?? null,
    // 对局内显示名(比赛用 id;房间级,只有本房间成员有值)→ 写入比赛 JSON 的玩家名
    displayNames: pruneDisplayNames(slots, getDisplayNames(roomRow)),
    sideChoices: roomRow.side_choices
      ? (() => {
          try {
            return JSON.parse(roomRow.side_choices)
          } catch {
            return {}
          }
        })()
      : {},
  }

  const token = crypto.randomBytes(16).toString('hex')
  const payload = buildMatchJson({
    matchId: 0, // 占位,入库拿到真实 id 后重建
    room: roomForJson,
    maplist,
    playersPerTeam,
    minPlayersToReady,
    publicBaseUrl: config.publicBaseUrl,
    token,
  })
  const mrow = getDb()
    .prepare('INSERT INTO matches (room_id, token, payload, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(roomId, token, JSON.stringify(payload), 'pending', now())
  const matchId = Number(mrow.lastInsertRowid)

  // 重新生成携带真实 matchid 的 payload
  const finalPayload = buildMatchJson({
    matchId,
    room: roomForJson,
    maplist,
    playersPerTeam,
    minPlayersToReady,
    publicBaseUrl: config.publicBaseUrl,
    token,
  })
  getDb().prepare('UPDATE matches SET payload = ? WHERE id = ?').run(JSON.stringify(finalPayload), matchId)

  // 实例分配:房主手动选择(manual)或自动(auto,跳过 admin_only 与非 RUNNING)
  // 增强人机:锁定 bot 实例(仅该实例安装 CS2-Bot-Improver)
  const choice = parseServerChoice(roomRow)
  let inst = null
  try {
    if (choice?.mode === 'manual') {
      if (!choice.instance) throw new Error('请选择实例')
      if (roomRow.bot_mode && choice.instance !== config.botInstanceName) {
        throw new Error(`增强人机模式仅支持 ${config.botInstanceName} 实例`)
      }
      inst = await validateManualInstance(choice.instance, isAdmin(roomRow.host_id))
      setState(inst, 'booting', null)
    } else {
      inst = await pickFree(roomRow.bot_mode ? config.botInstanceName : null)
      if (!inst) {
        throw new Error(
          roomRow.bot_mode
            ? `增强人机模式仅支持 ${config.botInstanceName} 实例,当前不可用`
            : '无可用运行中实例,请联系管理员启动',
        )
      }
    }
  } catch (err) {
    getDb().prepare("UPDATE matches SET status = 'aborted' WHERE id = ?").run(matchId)
    throw err
  }

  let arenaBindingStarted = false
  try {
    // 用房间生效的 -maxplayers 重启实例(MSM 由 MAXPLAYERS 环境变量覆盖 preset 弱默认)
    await bridge.startAndWait(inst, { maxPlayers })
    // 房主可能在此期间解散了房间(显式离开/断线自动退房):必须中止,否则实例锁会留在本局
    // (房间已不存在 → 没人再来结束比赛;见 房间结束后的实例释放规则)
    if (!getRoomRow(roomId)) throw new Error('房间已解散,开赛中止')
    // 插件加载缓冲:CS2 RUNNING ≠ MatchZy 已就绪
    if (config.pluginReadyDelayMs > 0) {
      await new Promise((r) => setTimeout(r, config.pluginReadyDelayMs))
    }
    // 人机就位 cfg 固化:每场都覆写实例 cfg/arena_bots.cfg —— 人机房写就位指令,
    // 普通房写空文件中和同实例(如 match3)上一场人机房残留;ArenaMatch 与 MatchZy 均在 warmup/live
    // 各执行一次,是防配置污染与 GOTV 录像闭环的前置条件 (实例设置恢复流程)
    await bridge.bridgeWriteCfg(inst, 'arena_bots.cfg', roomRow.bot_mode ? buildBotCfg(slots, roomRow) : '// arena: no bots (non-bot match)\n')
    // 社区图就位(此时无比赛,操作无副作用):
    //   本地自维护图(localMap)→ **跳过 host_workshop_map**(不挂载工坊 addon,地图脚本/自带 cfg 均不存在,
    //     参数全由平台接管),预检实例本地 maps/<internal>.vpk 已部署(经桥 mapfile_status);
    //   工坊图 → host_workshop_map <id>(需主机已下载;首次下载慢时 WORKSHOP_PRELOAD_DELAY_MS 缓冲)
    const communityMaps = [...new Set(maplist.map(String))]
      .map((id) => getCommunityMapByWorkshopId(id))
      .filter(Boolean)
    for (const m of communityMaps) {
      if (m.localMap) {
        const filename = `${m.internalName || m.workshopId}.vpk`
        const st = await bridge.bridgeMapFileStatus(inst, filename)
        if (!st.data?.present) {
          throw new Error(
            `本地图 ${filename} 未部署到实例 @${inst}(期望路径 ${st.data?.path ?? 'maps/' + filename},请先部署该地图或改用工坊地图),请先部署或将地图改回工坊流程`,
          )
        }
        continue
      }
      await bridge.sendCommand(inst, `host_workshop_map ${m.workshopId}`)
      if (config.workshopPreloadDelayMs > 0) {
        await new Promise((r) => setTimeout(r, config.workshopPreloadDelayMs))
      }
    }
    // 下发前最后一道校验:房间仍存在(插件缓冲/写文件期间可能被解散)
    if (!getRoomRow(roomId)) throw new Error('房间已解散,开赛中止')

    if (isArenaMatchActive(inst)) {
      // ArenaMatch 独立开赛链路
      // 1. 原子登记绑定意图与实例所有权，避免强退与新比赛争抢未标记的 booting 锁。
      const db = getDb()
      db.exec('BEGIN IMMEDIATE')
      try {
        const claimed = db.prepare(
          "UPDATE instances SET match_id = ?, updated_at = ? WHERE name = ? AND state = 'booting' AND match_id IS NULL",
        ).run(matchId, now(), inst)
        if (claimed.changes !== 1) throw new Error('ArenaMatch 实例锁已发生变化')
        const bindingStarted = db.prepare(
          `UPDATE matches SET instance_name = ?, arena_match_bind_started = 1
           WHERE id = ? AND status = 'pending'`,
        ).run(inst, matchId)
        if (bindingStarted.changes !== 1) throw new Error('ArenaMatch 比赛已结束或绑定状态发生变化')
        db.exec('COMMIT')
      } catch (claimErr) {
        db.exec('ROLLBACK')
        throw claimErr
      }
      cacheInstances()
      arenaBindingStarted = true
      // 向桥绑定比赛并落盘私有凭据与干净 JSON, 取得 SHA-256。
      const bindRes = await bridge.bridgeArenaMatchBind(inst, matchId, finalPayload)
      if (!bindRes.data?.ok) {
        throw new Error(`arena_match_bind 失败: ${bindRes.data?.error || 'unknown'}`)
      }
      const sha256 = bindRes.data.sha256
      const savedBinding = getDb()
        .prepare(
          `UPDATE matches
           SET instance_name = ?, arena_match_sha256 = ?, arena_match_bind_started = 1, arena_match_close_confirmed = 0,
               arena_match_result_seq = 0, arena_match_result_json = NULL
           WHERE id = ? AND status = 'pending'`,
        )
        .run(inst, sha256, matchId)
      if (savedBinding.changes !== 1) throw new Error('ArenaMatch 比赛已结束或绑定状态发生变化')

      // 2. 注册装载结果等待器 (默认 15s 超时)
      const resultPromise = waitForArenaMatchResult(inst, matchId, sha256, 15000)
      resultPromise.catch(() => {})

      // 3. 控制台下发 arena_match_load <id>
      const sent = await bridge.sendCommand(inst, `arena_match_load ${matchId}`)
      if (!sent.ok) throw new Error(`arena_match_load 下发失败: ${sent.error || sent.stderr || 'unknown'}`)

      // 4. 等待插件装载回执与 ACK 确认
      await resultPromise
    } else {
      // 经典 MatchZy 链路:比赛 JSON 写入实例 csgo/ 目录,再 send matchzy_loadmatch <文件>
      const fileName = `matchzy_load_${matchId}.json`
      await bridge.bridgeWriteMatchFile(inst, fileName, finalPayload)
      await bridge.sendCommand(inst, `matchzy_loadmatch ${fileName}`)
      getDb().prepare('UPDATE matches SET instance_name = ? WHERE id = ?').run(inst, matchId)
    }
    if (getRoomRow(roomId)?.status !== 'starting') throw new Error('房间已退出开赛状态,开赛中止')
  } catch (err) {
    if (arenaBindingStarted && inst) {
      cancelArenaMatchResultWait(inst, matchId)
    }
    getDb().prepare("UPDATE matches SET status = 'aborted' WHERE id = ? AND status NOT IN ('ended', 'aborted')").run(matchId)
    if (arenaBindingStarted && inst) {
      const owned = getDb().prepare('SELECT match_id FROM instances WHERE name = ?').get(inst)?.match_id === matchId
      if (owned) {
        if (!await confirmArenaMatchClose(inst, matchId)) {
          console.warn(`[arena-match] 开赛失败 ${matchId}: ${inst} 保持锁定，等待桥关闭绑定`)
        }
      } else if (!getDb().prepare('SELECT arena_match_close_confirmed FROM matches WHERE id = ?').get(matchId)?.arena_match_close_confirmed) {
        console.warn(`[arena-match] 开赛失败 ${matchId}: ${inst} 所有权已变化，桥关闭需人工核对`)
      }
    } else {
      releaseInstance(inst, matchId)
    }
    updateRoomRow(roomId, {
      status: 'waiting',
      server: null,
      bp_phase: null,
      side_choices: '{}',
      side_pending_for: null,
      veto_deadline_at: null,
    })
    broadcastRoom(io, roomId)
    throw err
  }

  setState(inst, 'in_match', matchId)

  // 服务器信息取实例所属 game_servers 记录(DB 为准)
  // host_ip 可为域名:开赛时解析为 IP 写入 room.server(支持动态 DNS,失败回退原值)
  const srv = instanceServer(inst) || config.gameServers[0]
  const port = MEM.get(inst)?.port ?? 0
  const connectIp = await resolveHostIp(srv?.host_ip || '127.0.0.1')
  updateRoomRow(roomId, {
    status: 'live',
    veto_deadline_at: null,
    server: JSON.stringify({
      ip: connectIp,
      port,
      password: '',
      region: srv?.region || '',
    }),
  })
  const roomJson = broadcastRoom(io, roomId)
  return { matchId, instance: inst, finalMap, room: roomJson }
}

// 强制结束:向实例发 css_endmatch(0.8.15 真实命令)+ 释放 + 房间复位
export async function forceEndMatch({ roomId, io }) {
  const m = getDb()
    .prepare("SELECT * FROM matches WHERE room_id = ? AND status IN ('pending', 'live') ORDER BY id DESC LIMIT 1")
    .get(roomId)
  if (m) {
    try {
      if (m.instance_name) {
        // 优先 css_endmatch(0.8.15 存在);matchzy_endmatch 不存在,保留仅为兼容旧白名单
        await bridge.sendCommand(m.instance_name, 'css_endmatch')
      }
    } catch {
      // 实例不可达时忽略
    }
    getDb()
      .prepare("UPDATE matches SET status = 'aborted', ended_at = ? WHERE id = ?")
      .run(now(), m.id)
    if (m.instance_name) {
      // 所有权感知:仅当实例锁仍属于本局比赛时才冷却(避免误抢其他进行中比赛)
      const cur = getDb().prepare('SELECT state, match_id FROM instances WHERE name = ?').get(m.instance_name)
      if (cur && (cur.match_id == null || cur.match_id === m.id)) {
        releaseToCooling(m.instance_name, m.id)
      }
    }
    // 实例侧整理与桥绑定释放:与 series_end 同一套(强退/房主离开/解散后也把该场产物收拾掉)
    if (m.instance_name) {
      if (m.arena_match_bind_started || m.arena_match_sha256) void confirmArenaMatchClose(m.instance_name, m.id)
      bridge.matchCleanup(m.instance_name, { matchId: m.id }).catch((err) =>
        console.warn('[match-cleanup]', m.instance_name, m.id, err.message),
      )
    }
  }
  resetRoomAfterMatch(roomId)
  broadcastRoom(io, roomId)
  return m?.id ?? null
}
