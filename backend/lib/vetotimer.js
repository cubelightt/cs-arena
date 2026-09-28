// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// BP 超时自动操作:vetoing 房间到达 veto_deadline_at 后自动操作并广播
// ban/pick 阶段随机;选边(side)阶段默认 CT(不随机)
import { getDb, now } from '../db.js'
import config from '../config.js'
import { getRoomJson, updateRoomRow, broadcastRoom } from './rooms.js'
import { vetoStepOf, applyVetoAction, applySideChoice } from './veto.js'

function autoAction(roomId, io) {
  const room = getRoomJson(roomId)
  if (!room || room.status !== 'vetoing') return

  const step = vetoStepOf(room)
  if (step.phase === 'done') {
    updateRoomRow(roomId, { veto_deadline_at: null })
    broadcastRoom(io, roomId)
    return
  }
  if (step.phase === 'side') {
    // 选边超时:默认 CT
    const { patch } = applySideChoice(room, 'ct', room.hostId, config.vetoTurnTimeoutMs)
    updateRoomRow(roomId, patch)
    broadcastRoom(io, roomId)
    return
  }
  const remaining = room.mapPool.filter((id) => !room.banned.includes(id) && !room.picked.includes(id))
  if (remaining.length === 0) {
    updateRoomRow(roomId, { veto_deadline_at: null })
    return
  }
  const mapId = remaining[Math.floor(Math.random() * remaining.length)]
  const type = step.phase === 'ban' ? 'ban' : 'pick'
  const { patch } = applyVetoAction(room, mapId, type, room.hostId, config.vetoTurnTimeoutMs)
  updateRoomRow(roomId, patch)
  broadcastRoom(io, roomId)
}

export function startVetoTimer(io, intervalMs = 1000) {
  setInterval(() => {
    try {
      const rows = getDb()
        .prepare(
          "SELECT id FROM rooms WHERE status = 'vetoing' AND veto_deadline_at IS NOT NULL AND veto_deadline_at <= ?",
        )
        .all(now())
      for (const row of rows) autoAction(row.id, io)
    } catch (err) {
      console.error('[veto-timer]', err)
    }
  }, intervalMs)
}
