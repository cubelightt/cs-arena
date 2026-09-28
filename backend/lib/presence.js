// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 房间频道在线登记 + 断线宽限自动退房
// 玩家关闭网页/断网导致 socket 断开时,宽限期内未重连则按显式退房语义移除(房主离开即解散房间)
import { performLeave } from './rooms.js'
import { getDisconnectGrace } from './settings.js'

const presence = new Map() // roomId -> Map<steamId, Set<socketId>>
const timers = new Map() // `${roomId}:${steamId}` -> Timeout

function keyOf(roomId, steamId) {
  return `${roomId}:${steamId}`
}

// socket 加入房间频道时登记(同一账号多标签页/多连接累计计数)
export function presenceJoin(roomId, steamId, socketId) {
  if (!presence.has(roomId)) presence.set(roomId, new Map())
  const byUser = presence.get(roomId)
  if (!byUser.has(steamId)) byUser.set(steamId, new Set())
  byUser.get(steamId).add(socketId)
  // 重连回房:取消待执行的自动退房
  const key = keyOf(roomId, steamId)
  if (timers.has(key)) {
    clearTimeout(timers.get(key))
    timers.delete(key)
  }
}

// socket 断开时移除登记(该账号的其他连接仍在则不触发退房)
export function presenceLeave(roomId, steamId, socketId) {
  const byUser = presence.get(roomId)
  byUser?.get(steamId)?.delete(socketId)
  if (byUser?.get(steamId)?.size === 0) byUser.delete(steamId)
  if (byUser?.size === 0) presence.delete(roomId)
}

export function presenceCount(roomId, steamId) {
  return presence.get(roomId)?.get(steamId)?.size ?? 0
}

// 断线后调度宽限退房:到点时账号已无任何在线连接才执行(双保险,重连时 presenceJoin 亦会取消)
// 注:performLeave 为 async(房主离开时可能需要先结束进行中的比赛),失败只告警、不影响其它流程
function runLeave(io, roomId, steamId) {
  Promise.resolve(performLeave(io, roomId, steamId)).catch((err) =>
    console.warn(`[presence] 自动退房失败(${roomId}): ${err.message}`),
  )
}

export function scheduleAutoLeave(io, roomId, steamId) {
  if (presenceCount(roomId, steamId) > 0) return
  // 杂项设置(管理面板可调):关闭=断开立即退房;秒数 0=永不超时(仅登记,不调度)
  const { enabled, seconds } = getDisconnectGrace()
  if (!enabled) {
    runLeave(io, roomId, steamId)
    return
  }
  if (seconds === 0) return
  const key = keyOf(roomId, steamId)
  if (timers.has(key)) return
  const t = setTimeout(() => {
    timers.delete(key)
    if (presenceCount(roomId, steamId) > 0) return
    runLeave(io, roomId, steamId)
  }, seconds * 1000)
  t.unref?.()
  timers.set(key, t)
}
