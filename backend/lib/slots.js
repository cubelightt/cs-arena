// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 槽位语义:PlayerSlot.slot = 队内 0 基序号(ct/t/spec 各自独立编号)
// 后端为唯一持久化方;前端按序号落位渲染,空槽点击携带目标 slot 精确换位

export function teamLimit(room, team) {
  if (team === 'spec') return room.specSeats
  return team === 'ct' ? room.teamA : room.teamB
}

// 补齐缺失 slot 的成员:按该队最小空闲号分配(旧数据首次读取即得紧凑编号;
// 已有 slot 的成员与其空洞保持不变 —— 同队移位/踢人产生的空洞符合槽位心智)
export function normalizeSlots(slots) {
  const taken = { ct: new Set(), t: new Set(), spec: new Set() }
  for (const s of slots) {
    if (typeof s.slot === 'number') taken[s.team]?.add(s.slot)
  }
  return slots.map((s) => {
    if (typeof s.slot === 'number') return s
    const set = taken[s.team] ?? new Set()
    let i = 0
    while (set.has(i)) i++
    set.add(i)
    return { ...s, slot: i }
  })
}

export function minFreeSlot(slots, team) {
  const taken = new Set(slots.filter((s) => s.team === team && typeof s.slot === 'number').map((s) => s.slot))
  let i = 0
  while (taken.has(i)) i++
  return i
}

// 该队成员按原槽位顺序压缩为 0..n-1(连续无空洞;config 缩容后调用)
export function compactTeamSlots(slots, team) {
  const ordered = slots
    .filter((s) => s.team === team)
    .sort((a, b) => a.slot - b.slot)
    .map((s) => s.player.steamId)
  const slotOf = new Map(ordered.map((id, i) => [id, i]))
  return slots.map((s) => (s.team === team ? { ...s, slot: slotOf.get(s.player.steamId) } : s))
}

// 该队成员随机重排为 0..n-1(连续无空洞;shuffle 分队后调用)
export function shuffleTeamSlots(slots, team) {
  const ids = slots.filter((s) => s.team === team).map((s) => s.player.steamId)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  const slotOf = new Map(ids.map((id, i) => [id, i]))
  return slots.map((s) => (s.team === team ? { ...s, slot: slotOf.get(s.player.steamId) } : s))
}

// 带目标 slot 的换位校验(setteam/move 共用);通过返回 { slot },失败返回 { status, error }
export function resolveTargetSlot(room, slots, member, team, slot) {
  const limit = teamLimit(room, team)
  if (!Number.isInteger(slot) || slot < 0 || slot >= limit) {
    return { status: 400, error: '无效槽位' }
  }
  if (member.team !== team && slots.filter((s) => s.team === team).length >= limit) {
    return { status: 409, error: '该阵营已满' }
  }
  const occupied = slots.some(
    (s) => s.team === team && s.slot === slot && s.player.steamId !== member.player.steamId,
  )
  if (occupied) return { status: 409, error: '该槽位已被占用' }
  return { slot }
}

// 队内成员列表(过滤)
export function teamMembers(slots, team) {
  return slots.filter((s) => s.team === team)
}

// 队内第一位成员的 steamId(无成员返回 null;增强人机槽位不参与队长补位)
export function firstMember(slots, team) {
  return teamMembers(slots, team).find((s) => !s.isBot)?.player.steamId ?? null
}

// 队长补位规则:现任队长仍在本队则保留,否则该队第一位补位(自 routes/rooms.js 收编)
export function recalcCaptains(room) {
  const inTeam = (steamId, team) => teamMembers(room.slots, team).some((s) => s.player.steamId === steamId)
  room.captainA = inTeam(room.captainA, 'ct') ? room.captainA : firstMember(room.slots, 'ct')
  room.captainB = inTeam(room.captainB, 't') ? room.captainB : firstMember(room.slots, 't')
}
