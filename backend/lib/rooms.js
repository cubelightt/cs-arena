// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 房间行 ↔ JSON 序列化 + 更新 + Socket 广播
import { getDb } from '../db.js'
import { getPendingSwap } from './swaps.js'
import { normalizeSlots, recalcCaptains } from './slots.js'
import { effectiveMaxPlayers } from './roomlimits.js'
import { normalizeDuelPreset, resolveDuelMaxRounds } from './duel.js'

// ---- 对局内显示名(比赛用 id,与房间绑定)----
// 用途:玩家给自己在对局中显示的名字(可不同于 Steam 名/账号昵称),**只在所属房间生效**。
// 生效路径:开赛时写进比赛 JSON 的 team1/team2/spectators 玩家名 → MatchZy LoadClientNames()
// 落成 csgo/MatchZyPlayerNames/Match_<matchId>.ini 并执行 sv_load_forced_client_names_file
// → CS2 引擎强制显示该名字。
// 约束(强制名文件是 KeyValues 行格式):不含引号 / 反斜杠 / 换行与控制字符;长度上限 32 字符。
export const DISPLAY_NAME_MAX = 32

// 归一化:返回 null = 清除(回到账号昵称);非法抛错(调用方转 400)
export function normalizeDisplayName(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return null
  if ([...s].length > DISPLAY_NAME_MAX) throw new Error(`显示名过长(上限 ${DISPLAY_NAME_MAX} 字符)`)
  if (/["\\]/.test(s) || /[\u0000-\u001f\u007f]/.test(s)) {
    throw new Error('显示名不可包含引号、反斜杠、换行等控制字符')
  }
  return s
}

// 房间显示名映射 { steamId: name }(坏值按空处理)
export function getDisplayNames(roomRow) {
  try {
    const o = JSON.parse(roomRow?.display_names || '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

// 只保留仍在房间槽位里的成员(离房/被踢的条目不再暴露,也不写进比赛 JSON)
export function pruneDisplayNames(slots, map) {
  const ids = new Set((slots || []).map((s) => s?.player?.steamId).filter(Boolean))
  const out = {}
  for (const [id, name] of Object.entries(map || {})) {
    if (ids.has(id) && name) out[id] = String(name)
  }
  return out
}

export function serializeRoom(row) {
  if (!row) return null
  // 槽位先归一化:显示名需按当前成员过滤(离房/被踢的条目不再暴露)
  const slots = normalizeSlots(JSON.parse(row.slots))
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    hostId: row.host_id,
    password: row.password,
    matchType: row.match_type,
    teamA: row.team_a,
    teamB: row.team_b,
    teamAName: row.team_a_name,
    teamBName: row.team_b_name,
    specSeats: row.spec_seats,
    bestOf: row.best_of,
    pickMode: row.pick_mode,
    // 单挑对决「地图池选择」(仅 1v1 房间,direct 选图生效):total=总竞技图池(默认) duel=单挑图池
    mapPoolKind: row.map_pool_kind === 'duel' ? 'duel' : 'total',
    // 单挑对决回合局数(mp_maxrounds):仅 duel 房间可改(奇数,solo 固定 51);custom 房间恒为 null。
    // 生效值 = 玩法类型默认(长枪/手枪/狙击 31,Solo三项 51)或房间覆盖
    maxRounds: row.match_type === 'duel'
      ? resolveDuelMaxRounds(normalizeDuelPreset(row.duel_preset) ?? 'rifle', row.max_rounds)
      : null,
    // 单挑对决玩法类型(仅 duel 房间):rifle=长枪决斗(默认)/ pistol=手枪决斗 / sniper=狙击决斗 / solo=Solo三项
    duelPreset: row.match_type === 'duel' ? (normalizeDuelPreset(row.duel_preset) ?? 'rifle') : null,
    status: row.status,
    slots,
    mapPool: JSON.parse(row.map_pool),
    banned: JSON.parse(row.banned),
    picked: JSON.parse(row.picked),
    vetoHistory: JSON.parse(row.veto_history),
    vetoTurn: row.veto_turn,
    vetoDeadlineAt: row.veto_deadline_at ?? null,
    knifeRound: !!row.knife_round,
    autoFill: !!row.auto_fill,
    // 友军伤害开关:默认开启(旧行/缺列按开启处理)
    friendlyFire: row.friendly_fire == null ? true : !!row.friendly_fire,
    // 竞技加时默认开启，单挑始终关闭；开赛时快照到比赛 cvars。
    overtimeEnabled: row.match_type !== 'duel' && (row.best_of === 3 || row.overtime_enabled == null || !!row.overtime_enabled),
    // 对局录像开关:默认开启(缺列/null 按开启处理);关闭时不启动 GOTV 录像并在完赛后立即解除冷却
    recordDemo: row.record_demo == null ? true : !!row.record_demo,
    // 对局内显示名开关(房间级,仅房主/管理员可改,**默认关闭**):关闭时玩家不能自助改名(管理员仍可改)
    allowDisplayName: !!row.allow_display_name,
    // 中途加入观战开关(房间级,房主可改,**默认开启**;缺列按开启):关闭时本房间拒绝非名单观战申请
    spectatorJoin: row.spectator_join == null ? true : !!row.spectator_join,
    // 实例最大玩家数(-maxplayers):maxPlayers=生效值(房间覆盖 ?? 全局默认);maxPlayersOverride=房间覆盖(null=跟随默认)
    maxPlayers: effectiveMaxPlayers(row),
    maxPlayersOverride: row.max_players ?? null,
    botMode: !!row.bot_mode,
    botAim: row.bot_aim ?? 'mixed',
    botNades: row.bot_nades ?? 'normal',
    botProteam: row.bot_proteam ?? null,
    bpPhase: row.bp_phase ?? null,
    sideChoices: row.side_choices
      ? (() => {
          try {
            return JSON.parse(row.side_choices)
          } catch {
            return {}
          }
        })()
      : {},
    sidePendingFor: row.side_pending_for ?? null,
    captainA: row.captain_a ?? null,
    captainB: row.captain_b ?? null,
    // 对局内显示名(比赛用 id,与房间绑定):{ steamId: name },仅本房间开赛时写入比赛 JSON
    displayNames: pruneDisplayNames(slots, getDisplayNames(row)),
    pendingSwap: getPendingSwap(row.id),
    serverChoice: row.server_choice
      ? (() => {
          try {
            return JSON.parse(row.server_choice)
          } catch {
            return { mode: 'auto', group: null, instance: null }
          }
        })()
      : { mode: 'auto', group: null, instance: null },
    server: row.server ? JSON.parse(row.server) : undefined,
    createdAt: row.created_at,
  }
}

// 房间活跃态(占用"一个用户一个房间"配额的状态;finished 是历史行,不算占用)
export const ACTIVE_ROOM_STATUSES = ['waiting', 'vetoing', 'starting', 'live']

// 该用户当前所在的房间(可能多条:历史数据/管理员操作外的旁路);exceptRoomId 用于排除本次目标房间
export function findUserRooms(steamId, exceptRoomId = null) {
  const rows = getDb().prepare('SELECT * FROM rooms').all()
  const out = []
  for (const row of rows) {
    if (exceptRoomId && row.id === exceptRoomId) continue
    let slots = []
    try {
      slots = JSON.parse(row.slots || '[]')
    } catch {
      continue
    }
    if (slots.some((s) => s.player?.steamId === steamId)) out.push(row)
  }
  return out
}

// 离开语义(与显式 POST /:id/leave 一致,供断线自动退房复用):
// 房主离开 → **先结束进行中的比赛**(强制结束:比赛置 aborted + 释放实例锁)再解散房间并广播 room:removed;
// 成员离开 → 移除+队长补位并广播 room:update
// 返回 null 表示房间不存在或该玩家本就不在房间
export async function performLeave(io, roomId, steamId) {
  const row = getRoomRow(roomId)
  if (!row) return null
  const room = serializeRoom(row)
  if (!room.slots.some((s) => s.player.steamId === steamId)) return null
  if (room.hostId === steamId) {
    // 房主解散时若比赛进行中(starting/live):必须收尾,否则 match 行停在 live、实例锁停在 in_match,
    // 该实例无法再被分配,只能管理员手动重置(2026-09-18 修复,房间结束后的实例释放规则)
    if (room.status === 'live' || room.status === 'starting') {
      try {
        // 延迟导入:rooms ↔ instances 互相引用,静态 import 会形成循环依赖
        const { forceEndMatch } = await import('./instances.js')
        await forceEndMatch({ roomId, io })
      } catch (err) {
        console.warn(`[room] 房主离开时结束比赛失败(仍解散房间): ${err.message}`)
      }
    }
    getDb().prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
    io.to(`room:${roomId}`).emit('room:removed', roomId)
    return { deleted: true }
  }
  room.slots = room.slots.filter((s) => s.player.steamId !== steamId)
  recalcCaptains(room)
  updateRoomRow(roomId, { slots: JSON.stringify(room.slots), captain_a: room.captainA, captain_b: room.captainB })
  broadcastRoom(io, roomId)
  return { deleted: false }
}

export function getRoomRow(id) {
  return getDb().prepare('SELECT * FROM rooms WHERE id = ?').get(id)
}

export function getRoomJson(id) {
  return serializeRoom(getRoomRow(id))
}

// patch: 与 rooms 表字段同名的平铺键值(含 JSON 列需预先 JSON.stringify)
export function updateRoomRow(id, patch) {
  const keys = Object.keys(patch)
  if (keys.length === 0) return getRoomRow(id)
  const sets = keys.map((k) => `${k} = ?`)
  getDb()
    .prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id)
  return getRoomRow(id)
}

export function broadcastRoom(io, id) {
  const room = getRoomJson(id)
  if (room) io.to(`room:${id}`).emit('room:update', room)
  return room
}

/** 比赛结束后保留房间与成员，清空上一场选图/选边，允许重新开赛。 */
export function resetRoomAfterMatch(roomId) {
  updateRoomRow(roomId, {
    status: 'waiting', server: null, banned: '[]', picked: '[]',
    veto_history: '[]', veto_turn: 0, bp_phase: null, side_choices: '{}',
    side_pending_for: null, veto_deadline_at: null,
  })
}
