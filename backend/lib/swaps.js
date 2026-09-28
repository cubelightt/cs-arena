// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 换位申请登记(内存,60s 过期;重启丢失可接受)
const SWAPS = new Map() // roomId → { id, fromPlayerId, targetPlayerId, at }

const SWAP_TTL_MS = 60000

export function setPendingSwap(roomId, fromPlayerId, targetPlayerId) {
  SWAPS.set(roomId, { id: `swap-${Date.now()}`, fromPlayerId, targetPlayerId, at: Date.now() })
}

export function getPendingSwap(roomId) {
  const s = SWAPS.get(roomId)
  if (!s) return null
  if (Date.now() - s.at > SWAP_TTL_MS) {
    SWAPS.delete(roomId)
    return null
  }
  return s
}

export function consumePendingSwap(roomId) {
  SWAPS.delete(roomId)
}

export function clearRoomSwaps(roomId) {
  SWAPS.delete(roomId)
}
