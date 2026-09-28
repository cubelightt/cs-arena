// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// BP 选图:动作序列驱动(7 图固定池,后端为唯一规则源)
// BO1(池7): 交替 ban×4 至剩3 → pick 阶段无 → 交替 ban×2 至剩1 → done(剩1自动为比赛图)
//            done 后进入选边:TeamB(后手)选择 CT/T,超时默认 CT
// BO3(池7): 交替 ban×2 至剩5 → 交替 pick×2 → 交替 ban×2 至剩1 → done(剩1自动为图三)
//           每次 pick 后对方即时选边(TA pick → TeamB 选;TB pick → TeamA 选),超时默认 CT;图三刀局
// 轮到方:每动作交替 ct(TA)/t(TB),TA 先
// side_pending_for 非空 = 处于选边子阶段

export function vetoStepOf(room) {
  if (room.sidePendingFor) {
    return { phase: 'side', remainingBans: 0, remainingPicks: 0 }
  }
  const remaining = room.mapPool.length - room.banned.length - room.picked.length
  // 阶段1:交替 ban 至剩余 = bestOf + 2
  if (remaining > room.bestOf + 2) {
    return { phase: 'ban', remainingBans: remaining - (room.bestOf + 2), remainingPicks: 0 }
  }
  // 阶段2:交替 pick 至 picked = bestOf - 1
  if (room.picked.length < room.bestOf - 1) {
    return { phase: 'pick', remainingBans: 0, remainingPicks: room.bestOf - 1 - room.picked.length }
  }
  // 阶段3:交替 ban 至剩余 = bestOf - picked
  if (remaining > room.bestOf - room.picked.length) {
    return { phase: 'ban', remainingBans: remaining - (room.bestOf - room.picked.length), remainingPicks: 0 }
  }
  return { phase: 'done', remainingBans: 0, remainingPicks: 0 }
}

export function currentVetoTeam(room) {
  return room.vetoTurn % 2 === 0 ? 'ct' : 't'
}

/**
 * 应用一次 ban/pick。返回 rooms 表字段 patch。
 * 完成后:剩余地图自动补入 picked;BO1 done → 进入选边(TeamB);BO3 每次 pick 后 → 对方选边
 * @throws 阶段错误 / 地图重复操作
 */
export function applyVetoAction(room, mapId, type, byPlayerId, turnTimeoutMs) {
  const step = vetoStepOf(room)
  if (step.phase === 'done') throw new Error('选图已完成')
  if (step.phase === 'side') throw new Error('当前为选边阶段,请先选边')
  if (type === 'pick' && step.phase === 'ban') throw new Error('当前为禁图阶段')
  if (type === 'ban' && step.phase === 'pick') throw new Error('当前为选图阶段')
  if (room.banned.includes(mapId) || room.picked.includes(mapId)) throw new Error('该地图已操作过')

  const banned = [...room.banned]
  const picked = [...room.picked]
  if (type === 'ban') banned.push(mapId)
  else picked.push(mapId)

  const byTeam = currentVetoTeam(room)
  const vetoHistory = [
    ...room.vetoHistory,
    {
      id: `va-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      mapId,
      type,
      byTeam,
      byPlayerId,
      at: Date.now(),
    },
  ]
  const nextRoom = { ...room, banned, picked, vetoHistory, vetoTurn: room.vetoTurn + 1 }
  const nextStep = vetoStepOf(nextRoom)

  let done = false
  let sidePendingFor = null
  if (nextStep.phase === 'done') {
    done = true
    // 剩余地图自动补入 picked
    const remaining = nextRoom.mapPool.filter((id) => !banned.includes(id) && !picked.includes(id))
    if (remaining.length > 0) picked.push(...remaining)
    // BO1:选边权给 TeamB(后手);BO3 done 时图三刀局,无需选边
    if (room.bestOf === 1) sidePendingFor = 'team2'
  } else if (type === 'pick') {
    // BO3:pick 完成后对方即时选边
    sidePendingFor = byTeam === 'ct' ? 'team2' : 'team1'
  }

  return {
    done,
    patch: {
      banned: JSON.stringify(banned),
      picked: JSON.stringify(picked),
      veto_history: JSON.stringify(vetoHistory),
      veto_turn: nextRoom.vetoTurn,
      bp_phase: sidePendingFor ? 'side' : nextStep.phase === 'done' ? 'done' : nextStep.phase,
      side_pending_for: sidePendingFor,
      status: done && !sidePendingFor ? 'waiting' : 'vetoing',
      veto_deadline_at: done && !sidePendingFor ? null : Date.now() + turnTimeoutMs,
    },
  }
}

/**
 * 选边(side 子阶段)。side: 'ct' | 't';超时默认 ct 由调用方决定。
 * 返回 rooms 表字段 patch。
 * @throws 无待选边 / 队伍不匹配 / side 非法
 */
export function applySideChoice(room, side, byPlayerId, turnTimeoutMs) {
  if (!room.sidePendingFor) throw new Error('当前没有待选边')
  if (side !== 'ct' && side !== 't') throw new Error('side 仅支持 ct / t')

  // 选边对应地图:BO1 为唯一图(0);BO3 为最近一次 pick(图 index = picked.length - 1)
  const mapNumber = room.bestOf === 1 ? 0 : Math.max(0, room.picked.length - 1)
  const teamSide = `${room.sidePendingFor}_${side}`
  const sideChoices = { ...(room.sideChoices || {}), [mapNumber]: teamSide }

  const nextRoom = { ...room, sideChoices, sidePendingFor: null }
  const nextStep = vetoStepOf(nextRoom)
  const done = nextStep.phase === 'done'

  return {
    done,
    patch: {
      side_choices: JSON.stringify(sideChoices),
      side_pending_for: null,
      bp_phase: done ? 'done' : nextStep.phase,
      status: done ? 'waiting' : 'vetoing',
      veto_deadline_at: done ? null : Date.now() + turnTimeoutMs,
    },
  }
}
