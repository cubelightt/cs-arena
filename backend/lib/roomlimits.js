// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 实例最大玩家数(maxplayers):全局默认 + 房间级覆盖
//
// 数值语义 = 引擎启动项 `-maxplayers`(MSM 的 competitive preset 弱默认 12,
// 由命令行环境变量 `MAXPLAYERS=<n> cs2-server @<inst> start|restart` 覆盖 —— 实机验证 2026-09-18)。
// 实例均开启 SourceTV(`+tv_enable 1`),SourceTV 占 1 席 → 可用玩家席 = maxPlayers - SOURCE_TV_SLOTS。
//
// 生效路径:开赛时后端把房间生效值经桥作为 `MAXPLAYERS` 环境变量传给 msm 的 restart
// (平台开赛前一律 restart 实例,restart 内部即 start,同样吃环境变量覆盖)。
import config from '../config.js'
import { getSetting, setSetting } from './settings.js'

export const SOURCE_TV_SLOTS = 1
export const MIN_MAX_PLAYERS = 2
export const MAX_MAX_PLAYERS = 64

function clampInt(v, fallback) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_MAX_PLAYERS, Math.max(MIN_MAX_PLAYERS, n))
}

// 全局默认(管理面板可改;settings 表 default_max_players)
export function getDefaultMaxPlayers() {
  return clampInt(getSetting('default_max_players', config.defaultMaxPlayers), config.defaultMaxPlayers)
}

export function setDefaultMaxPlayers(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < MIN_MAX_PLAYERS || n > MAX_MAX_PLAYERS) {
    throw new Error(`最大玩家数需为 ${MIN_MAX_PLAYERS}~${MAX_MAX_PLAYERS} 的整数`)
  }
  setSetting('default_max_players', n)
  return getMaxPlayersSetting()
}

// 设置快照(前端展示容量口径:tvSlots 固定占席)
export function getMaxPlayersSetting() {
  return {
    maxPlayers: getDefaultMaxPlayers(),
    min: MIN_MAX_PLAYERS,
    max: MAX_MAX_PLAYERS,
    tvSlots: SOURCE_TV_SLOTS,
  }
}

// 房间生效值:房间覆盖(仅管理员可设)优先,否则全局默认
export function effectiveMaxPlayers(roomRow) {
  const override = roomRow?.max_players
  return override == null ? getDefaultMaxPlayers() : clampInt(override, getDefaultMaxPlayers())
}

// 房间可用玩家席(双方 + 观战 + 未来的人机都算在内)
export function roomPlayerCapacity(maxPlayers) {
  return Math.max(0, maxPlayers - SOURCE_TV_SLOTS)
}

// 观战席的容量口径:配置值(spec_seats)与实际槽位数取大者。
// 队伍缩容时"超员逐个移入观战席"只搬人不裁剪(routes/rooms.js 的 trim),实际观战人数会超过 spec_seats;
// 只按配置计会少算座位 → 开赛/改配置放行超员,溢出连接到最后才被引擎拒绝。
export function specSeatsForCapacity(configured, slots) {
  const actual = Array.isArray(slots) ? slots.filter((s) => s?.team === 'spec').length : 0
  return Math.max(Number(configured) || 0, actual)
}

// 容量校验:返回错误信息,合法时返回 null
export function checkRoomCapacity({ teamA, teamB, specSeats, maxPlayers }) {
  const need = Number(teamA) + Number(teamB) + Number(specSeats)
  const capacity = roomPlayerCapacity(maxPlayers)
  if (need > capacity) {
    return `房间容量超限:双方+观战共 ${need} 人,实例最大玩家数 ${maxPlayers}(SourceTV 占 ${SOURCE_TV_SLOTS} 席,可用 ${capacity} 席);请管理员调大本房间/全局的最大玩家数或减少人数`
  }
  return null
}

// 传给 msm 的环境变量(桥按 env 下发;值仅数字,见 bridge.py 校验)
export function maxPlayersEnv(maxPlayers) {
  return { MAXPLAYERS: String(maxPlayers) }
}
