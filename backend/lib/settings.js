// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 全局设置(settings 表,kv):服役地图池等运行时可调整项
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, now } from '../db.js'
import config from '../config.js'
import { listMaps } from './matchjson.js'

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return fallback
  }
}

export function setSetting(key, value) {
  const json = JSON.stringify(value)
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, json, now())
}

// 服役地图池(恒 7 张,BP 专用;从总竞技图池中选择)
export function getActiveMapPool() {
  return getSetting('active_map_pool', config.defaultActiveMapPool)
}

// 校验并保存服役池:恒 7 张 + 全部为**官方图**(社区图不进 BP)
export function setActiveMapPool(mapIds) {
  if (!Array.isArray(mapIds)) throw new Error('mapIds 必须为数组')
  if (mapIds.length !== 7) throw new Error('服役地图池必须正好 7 张(恒 7 张,BP 专用)')
  const known = new Set(listMaps().filter((m) => m.kind === 'official').map((m) => m.fullName))
  const invalid = mapIds.filter((id) => !known.has(id))
  if (invalid.length > 0) throw new Error(`地图不在总竞技图池中(社区图不可进服役池): ${invalid.join(', ')}`)
  setSetting('active_map_pool', [...new Set(mapIds)])
  return getActiveMapPool()
}

// 断线自动退房宽限(秒,杂项设置):enabled=false 玩家断开立即退房;seconds=0 永不超时(断开后不自动退房);上限 999
export function getDisconnectGrace() {
  const fallback = { enabled: true, seconds: Math.max(1, Math.round(config.roomDisconnectGraceMs / 1000)) }
  const v = getSetting('disconnect_grace', fallback)
  return {
    enabled: v?.enabled !== false,
    seconds: Math.min(999, Math.max(0, Math.round(Number(v?.seconds) || 0))),
  }
}

// 局部更新:仅传 enabled 或仅传 seconds 时保留另一项当前值
export function setDisconnectGrace(patch = {}) {
  const cur = getDisconnectGrace()
  const enabled = patch.enabled === undefined ? cur.enabled : !!patch.enabled
  let seconds = patch.seconds === undefined ? cur.seconds : Math.round(Number(patch.seconds))
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 999) {
    throw new Error('宽限时长需为 0~999 秒(0=永不超时)')
  }
  const next = { enabled, seconds }
  setSetting('disconnect_grace', next)
  return next
}

// 建房模式平台开关(杂项设置):关闭后仅管理员仍可创建该类型房间。
// 缺失设置或缺失字段都按开启处理，保证首次部署及旧数据库行为不变。
const ROOM_MODE_AVAILABILITY_FALLBACK = { custom: true, duel: true, botMode: true }

export function getRoomModeAvailability() {
  const v = getSetting('room_mode_availability', ROOM_MODE_AVAILABILITY_FALLBACK) ?? {}
  return Object.fromEntries(
    Object.entries(ROOM_MODE_AVAILABILITY_FALLBACK).map(([key, fallback]) => [
      key,
      typeof v[key] === 'boolean' ? v[key] : fallback,
    ]),
  )
}

// 局部更新:只保存传入的布尔字段，其它模式保留现值。
export function setRoomModeAvailability(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('模式设置需为对象')
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new Error('至少指定一个房间模式')
  for (const key of keys) {
    if (!Object.hasOwn(ROOM_MODE_AVAILABILITY_FALLBACK, key)) throw new Error(`未知房间模式: ${key}`)
    if (typeof patch[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`)
  }
  const next = { ...getRoomModeAvailability(), ...patch }
  setSetting('room_mode_availability', next)
  return next
}

// ---- 录像定期归档(杂项设置;M6)--------------------------------------------------
// 每天到点把实例 MatchZy/*.dem 归集到主机 demo_dir(桥 job kind demo_collect,只搬不删)。
// 默认**开启**、每天 05:00 之后第一次巡检执行;组忙(有实例非 idle/有进行中任务)则跳过、下一个巡检再试。
// `lastRun` 记 'YYYY-MM-DD'(本地日),保证一天只自动跑一次;`DEMO_ARCHIVE=off` 可整体关掉调度器。
const DEMO_ARCHIVE_FALLBACK = { enabled: true, hour: 5, lastRun: null }

export function getDemoArchive() {
  const v = getSetting('demo_archive', DEMO_ARCHIVE_FALLBACK) ?? {}
  const hour = Number(v.hour)
  return {
    enabled: v.enabled !== false,
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.trunc(hour))) : DEMO_ARCHIVE_FALLBACK.hour,
    lastRun: typeof v.lastRun === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.lastRun) ? v.lastRun : null,
  }
}

// 局部更新:仅传 enabled / 仅传 hour 时保留另一项
export function setDemoArchive(patch = {}) {
  const cur = getDemoArchive()
  const enabled = patch.enabled === undefined ? cur.enabled : !!patch.enabled
  let hour = cur.hour
  if (patch.hour !== undefined) {
    hour = Math.trunc(Number(patch.hour))
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) throw new Error('执行时刻需为 0~23 的整点(每小时的第 0 分)')
  }
  // 改时刻后允许当天按新时刻再跑一次(否则"调到更早的时刻"要等到明天)
  const lastRun = patch.hour !== undefined && hour !== cur.hour ? null : cur.lastRun
  const next = { enabled, hour, lastRun }
  setSetting('demo_archive', next)
  return next
}

// 调度器记账:标记今天已执行(day = 'YYYY-MM-DD')
export function markDemoArchiveRun(day) {
  const cur = getDemoArchive()
  setSetting('demo_archive', { ...cur, lastRun: day })
}

// 首页内容(左卡 + 更新日志):存 settings 表 home_content,管理面板在线编辑(仅管理员可写)
// 更新日志首次读取(尚未在后台保存过)时用仓库文件 update/CHANGELOG.md 播种,source='file' 供面板提示
const HOME_CONTENT_KEY = 'home_content'
const HOME_CONTENT_MAX_CHARS = 100 * 1024

function changelogSeedPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'update', 'CHANGELOG.md')
}

export function getHomeContent() {
  const v = getSetting(HOME_CONTENT_KEY, null)
  if (v && typeof v === 'object') {
    return { leftCard: String(v.leftCard ?? ''), changelog: String(v.changelog ?? ''), source: 'db' }
  }
  let changelog = ''
  try {
    // 文件首行 H1 是文档标题(卡片头部已有「更新日志」),播种时去掉避免重复
    changelog = readFileSync(changelogSeedPath(), 'utf8').replace(/^\s*#\s+.*(\r?\n|$)/, '')
  } catch {
    changelog = ''
  }
  return { leftCard: '', changelog, source: 'file' }
}

// 局部更新:仅传一个字段时保留另一字段当前值;首次保存会把文件播种的更新日志一并落库(此后以 DB 为准)
export function setHomeContent(patch = {}) {
  for (const key of ['leftCard', 'changelog']) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'string') throw new Error(`${key} 需为字符串`)
    if (patch[key].length > HOME_CONTENT_MAX_CHARS) {
      throw new Error(`${key} 过长(上限 ${HOME_CONTENT_MAX_CHARS} 字符)`)
    }
  }
  const cur = getHomeContent()
  setSetting(HOME_CONTENT_KEY, {
    leftCard: patch.leftCard === undefined ? cur.leftCard : patch.leftCard,
    changelog: patch.changelog === undefined ? cur.changelog : patch.changelog,
  })
  return getHomeContent()
}
