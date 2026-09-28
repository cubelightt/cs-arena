// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 非名单玩家「中途加入观战」:房间级开关(rooms.spectator_join,默认开启)
// + 平台级总开关(settings.spectator_join,默认开启) + 实例侧名单追加
//
// 为什么需要:MatchZy 在比赛已 setup 时会把任何不在名单里的连接者踢出
// (EventHandlers.cs EventPlayerConnectFullHandler:GetPlayerTeam(player)==None → KickPlayer),
// 名单唯一来源 = 开赛时下发的比赛 JSON(team1/team2/spectators)。因此"允许非名单用户中途观战"
// = 把该 steamid 追加进实例侧的 spectators 名单:
//   matchzy_addplayer <steam64> spec "<name>"   (Teams.cs;仅 isMatchSetup 可用,追加后重写强制名文件)
// 追加后玩家受 MatchZy 自身阵营守卫约束:jointeam 监听拦截换队请求、EventPlayerTeam 把玩家按名单
// 拉回 CsTeam.Spectator(GetPlayerTeam 命中 spectators)→ **只能观战,无法加入两侧队伍**。
//
// 下发通道 = 桥的管理控制台 op(lib/bridge.js bridgeConsole → msm send),不占 send 前缀白名单,
// 生产环境无需改主机桥配置。代价:命令经 tmux 注入,必须**纯 ASCII**(非 ASCII 字符会被丢弃,
// 参数缺失时命令直接报 Usage 失败),故名字做 ASCII 化,空则回退 Spec-<steamid 后 4 位>。
//
// 席位:实例 -maxplayers 是硬上限且 SourceTV 固定占 1 席;开赛时已占用 (teamA + teamB + specSeats)。
// 平台按剩余席位限制追加人数,避免观战者把候补/掉线重连的选手挤在门外(引擎仍会兜底拒绝溢出连接)。
import { getDb } from '../db.js'
import * as bridge from './bridge.js'
import { getSetting, setSetting } from './settings.js'
import { effectiveMaxPlayers, roomPlayerCapacity, specSeatsForCapacity } from './roomlimits.js'

export const SPEC_STEAMID_RE = /^\d{17}$/
// 与 bots.js 同风格的控制台注入安全白名单(控制台命令字符串里只允许这些字符)
export const SPECTATOR_NAME_RE = /^[A-Za-z0-9 ._-]{1,24}$/

// 平台级总开关(settings 表 spectator_join):**默认开启**(2026-09-22 由"默认不允许"改;
// 日常入口改为房间级开关 rooms.spectator_join,这里是管理员的停用开关)
export function getSpectatorJoinSetting() {
  return { allow: getSetting('spectator_join', true) !== false }
}

export function setSpectatorJoinSetting(allow) {
  if (typeof allow !== 'boolean') throw new Error('allow 需为布尔值(true/false)')
  setSetting('spectator_join', allow)
  return getSpectatorJoinSetting()
}

// 名字 ASCII 化:非 ASCII 经桥的 tmux 通道会丢,保留字母数字与空格 . _ -,空则回退占位名
export function sanitizeSpectatorName(name, steamId) {
  const ascii = String(name ?? '')
    .replace(/[^\x20-\x7E]/g, '') // 先剔除非 ASCII(含中文)
    .replace(/[^A-Za-z0-9 ._-]/g, '') // 再去掉引号/分号等控制台敏感字符
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
    .trim()
  if (ascii) return ascii
  const tail = String(steamId ?? '').slice(-4)
  return `Spec-${/^\d{4}$/.test(tail) ? tail : 'viewer'}`
}

// 剩余可用席位 = 实例席位(-maxplayers − SourceTV 1)− 本场已占(双方名额 + 观战席)
// 观战席按"配置 ∪ 实际槽位"计(缩容把超员移入观战席时实际人数会超过 spec_seats,见 roomlimits.js)
export function spectatorSeatsLeft(roomRow) {
  let slots = []
  try {
    slots = JSON.parse(roomRow?.slots || '[]')
  } catch {
    slots = []
  }
  const occupied =
    Number(roomRow?.team_a || 0) + Number(roomRow?.team_b || 0) + specSeatsForCapacity(roomRow?.spec_seats, slots)
  return Math.max(0, roomPlayerCapacity(effectiveMaxPlayers(roomRow)) - occupied)
}

// 已追加的非名单观战者(matches.spectators_extra,JSON 数组)
export function listExtraSpectators(matchRow) {
  try {
    const arr = JSON.parse(matchRow?.spectators_extra || '[]')
    return Array.isArray(arr) ? arr.map(String).filter((s) => SPEC_STEAMID_RE.test(s)) : []
  } catch {
    return []
  }
}

// 该 steamid 是否已在本场名单内(team1/team2/spectators):在名单内则无需追加,直接可连接
export function matchRosterHasSteamId(payload, steamId) {
  let p = payload
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p)
    } catch {
      return false
    }
  }
  const id = String(steamId ?? '')
  if (!id) return false
  const has = (obj) => !!obj && Object.prototype.hasOwnProperty.call(obj, id)
  return has(p?.team1?.players) || has(p?.team2?.players) || has(p?.spectators?.players)
}

// 追加观战:幂等(已登记直接返回);先登记席位再下发命令,下发失败回滚登记
export async function addExtraSpectator({ matchRow, roomRow, steamId, name }) {
  const id = String(steamId ?? '')
  if (!SPEC_STEAMID_RE.test(id)) throw new Error('steamId 非法')
  if (!matchRow?.instance_name) throw new Error('比赛未绑定实例')
  const list = listExtraSpectators(matchRow)
  const asciiName = sanitizeSpectatorName(name, id)
  if (list.includes(id)) return { added: false, name: asciiName, seatsLeft: Math.max(0, spectatorSeatsLeft(roomRow) - list.length) }

  const seats = spectatorSeatsLeft(roomRow)
  if (list.length >= seats) {
    throw new Error(
      `本场无空余席位可追加观战(实例最大玩家数 ${effectiveMaxPlayers(roomRow)},SourceTV 占 1 席,已占 ${roomRow.team_a}+${roomRow.team_b}+${roomRow.spec_seats} 席)`,
    )
  }

  const next = [...list, id]
  getDb().prepare('UPDATE matches SET spectators_extra = ? WHERE id = ?').run(JSON.stringify(next), matchRow.id)
  try {
    await bridge.bridgeConsole(matchRow.instance_name, `matchzy_addplayer ${id} spec "${asciiName}"`)
  } catch (err) {
    getDb().prepare('UPDATE matches SET spectators_extra = ? WHERE id = ?').run(JSON.stringify(list), matchRow.id)
    throw err
  }
  return { added: true, name: asciiName, seatsLeft: Math.max(0, seats - next.length) }
}
