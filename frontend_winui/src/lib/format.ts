// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 展示层格式化：字节 / 运行时长 / 时间戳（主机概况等面板用，避免各处各写一份口径）

/** 字节数人类可读：B 取整，KB 及以上保留一位小数（104.9 GB、421.5 MB、47.7 KB） */
export function humanBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/** 秒 → 运行时长：3h23m / 45m / 12s / 2d3h（0 或非法值显示 —） */
export function formatUptime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—'
  const s = Math.floor(sec)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 本地时钟 HH:MM（「数据时间」用） */
export function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 本地日期时间 YYYY-MM-DD HH:MM */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 百分比一位小数（87.3%） */
export function formatPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  return `${pct.toFixed(1)}%`
}
