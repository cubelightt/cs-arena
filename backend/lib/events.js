// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// MatchZy remote_log 事件接收:解析 → 幂等入库 → 房间/比赛状态更新 → Socket 广播
// 事件推送无重试无持久化,web 侧幂等 + 状态快照补偿(README 有说明)
import { getDb, now } from '../db.js'
import { getRoomRow, resetRoomAfterMatch, broadcastRoom } from './rooms.js'
import { releaseToCooling, confirmArenaMatchClose } from './instances.js'
import { matchCleanup } from './bridge.js'

export function dedupKey(event) {
  const m = event.map_number ?? ''
  switch (event.event) {
    case 'series_start':
      return 'series_start'
    case 'going_live':
      return `going_live:${m}`
    case 'round_end':
      return `round_end:${m}:${event.round_number}`
    case 'map_result':
      return `map_result:${m}`
    case 'series_end':
      return 'series_end'
    case 'map_picked':
      return `map_picked:${event.team}:${event.map_name}`
    case 'map_vetoed':
      return `map_vetoed:${event.team}:${event.map_name}`
    case 'side_picked':
      return `side_picked:${m}`
    case 'player_disconnect':
      return `player_disconnect:${event.player}`
    case 'demo_upload_ended':
      return `demo_upload_ended:${m}:${event.filename}`
    default:
      return `other:${event.event}`
  }
}

const KNOWN_EVENTS = new Set([
  'series_start',
  'going_live',
  'round_end',
  'map_result',
  'series_end',
  'map_picked',
  'map_vetoed',
  'side_picked',
  'player_disconnect',
  'demo_upload_ended',
])

function finalizeRecord(match, roomRow, event) {
  const payload = typeof event === 'string' ? JSON.parse(event) : event
  const score1 = payload.team1_series_score ?? 0
  const score2 = payload.team2_series_score ?? 0
  const winner = payload.winner?.team === 'team1' ? 'team1' : payload.winner?.team === 'team2' ? 'team2' : null
  const maps = (JSON.parse(match.payload || '{}').maplist ?? []) // 官方名(de_xxx)原样入库
  const players = JSON.parse(roomRow.slots).map((s) => ({
    steamId: s.player.steamId,
    name: s.player.name,
    avatarUrl: s.player.avatarUrl,
    team: s.team,
    isHost: s.player.steamId === roomRow.host_id,
    isBot: !!s.isBot,
  }))
  getDb()
    .prepare(
      'INSERT INTO records (room_id, room_name, code, match_type, best_of, maps, players, score1, score2, winner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      roomRow.id,
      roomRow.name,
      roomRow.code,
      roomRow.match_type,
      roomRow.best_of,
      JSON.stringify(maps),
      JSON.stringify(players),
      score1,
      score2,
      winner,
      now(),
    )
}

/**
 * 处理一个事件。返回 { stored, roomChanged, roomId }
 */
export function handleEvent({ io, match, event }) {
  const db = getDb()
  const eventName = event.event
  if (!KNOWN_EVENTS.has(eventName)) {
    // 未知事件也入库(便于排查),但不触发状态变更
    db.prepare('INSERT INTO events (match_id, event_name, dedup_key, payload, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(match.id, eventName, `other:${eventName}`, JSON.stringify(event), now())
    return { stored: true, roomChanged: false, roomId: match.room_id }
  }

  const key = dedupKey(event)
  const res = db
    .prepare(
      `INSERT INTO events (match_id, event_name, dedup_key, payload, received_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(match_id, event_name, dedup_key) DO NOTHING`,
    )
    .run(match.id, eventName, key, JSON.stringify(event), now())

  if (Number(res.changes) === 0) {
    return { stored: false, roomChanged: false, roomId: match.room_id }
  }

  // 桥可能在网站强退或完赛后补送已持久化的事件。确认入库即可，
  // 不能把已中止比赛重新置为 live，或改写同一房间随后开出的比赛。
  if (match.status === 'aborted' || match.status === 'ended') {
    return { stored: true, roomChanged: false, roomId: match.room_id }
  }

  let roomChanged = false
  const roomRow = getRoomRow(match.room_id)

  switch (eventName) {
    case 'series_start':
      db.prepare("UPDATE matches SET status = 'live', started_at = ? WHERE id = ?").run(now(), match.id)
      break
    case 'going_live':
      // 增强人机的就位已固化为实例 cfg/arena_bots.cfg(开赛时由后端写入,
      // 挂 MatchZy warmup/live cfg 链 exec),无需在事件里下发任何指令
      break
    case 'round_end':
    case 'map_result':
      db.prepare('UPDATE matches SET current_scores = ? WHERE id = ?').run(JSON.stringify(event), match.id)
      break
    case 'series_end': {
      const isForced = event.forced === true
      db.prepare('UPDATE matches SET status = ?, current_scores = ?, ended_at = ? WHERE id = ?').run(
        isForced ? 'aborted' : 'ended',
        JSON.stringify(event),
        now(),
        match.id,
      )
      // 冷却期:等该比赛 demo 上传到账后自动解除,期间实例不可复用
      if (match.instance_name) releaseToCooling(match.instance_name, match.id)
      // 桥确认关闭后才能通过 Demo 到齐或超时解除冷却。
      if (match.instance_name && (match.arena_match_bind_started || match.arena_match_sha256)) {
        void confirmArenaMatchClose(match.instance_name, match.id)
      }
      // 实例侧整理(对局录像不动):删该场 MatchZy 回合备份/回合恢复残留/强制名文件,
      // 并把平台比赛 JSON 归档到实例目录之外
      if (match.instance_name) {
        matchCleanup(match.instance_name, { matchId: match.id }).catch((err) =>
          console.warn('[match-cleanup]', match.instance_name, match.id, err.message),
        )
      }
      if (roomRow) {
        if (!isForced) {
          finalizeRecord(match, roomRow, event)
          resetRoomAfterMatch(roomRow.id)
        } else {
          // 强制中止不结算虚假战绩记录,房间恢复 waiting 状态
          resetRoomAfterMatch(roomRow.id)
        }
        roomChanged = true
      }
      break
    }
    default:
      break
  }

  io.to(`room:${match.room_id}`).emit('match:event', { matchId: match.id, event })

  let room = null
  if (roomChanged || eventName === 'series_start' || eventName === 'going_live' || eventName === 'round_end' || eventName === 'map_result') {
    room = broadcastRoom(io, match.room_id)
  }
  return { stored: true, roomChanged, roomId: match.room_id, room }
}
