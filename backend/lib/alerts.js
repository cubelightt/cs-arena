// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 平台在线告警(2026-09-21):把"桥断了 / 后端没了,没人知道"变成"日志与面板立刻能看到"。
//
// 提供桥连接状态告警，便于主机侧排查。
//   ① 桥离线:该组桥超过 `bridgeOfflineAlertMs`(默认 120s)没有连接 → critical 告警
//      —— 此时平台对该组**完全失去控制**(开赛/启停/建删/更新全部失败),必须显式提示。
//   ② 后端自身存活:暴露 startedAt/uptimeMs;进程被杀/重启后 **uptime 归零**就是可见信号
//      (`/api/health` 的 `backend.uptimeMs`),再配合 `deploy/arena-backend.service`(systemd,Restart=always)。
//
// 设计要点:listAlerts() 是**纯读**(面板 5s 轮询 /api/health 也不会有什么开销);
// 日志只在**边沿**(出现/恢复)打一行,由 server.js 的 30s 巡检调用 sweepAlerts()。
import { agentBridgeStatus } from './agentChannel.js'
import { listGameServers } from './gameServers.js'
import config from '../config.js'

const STARTED_AT = Date.now()
const LOGGED = new Set() // 已打过日志的告警 key(边沿触发,不刷屏)

/** 后端自身信息(存活/重启可观测)。 */
export function backendInfo() {
  return { startedAt: STARTED_AT, uptimeMs: Date.now() - STARTED_AT }
}

/** 各组的桥连接态势(含"离线多久";never connected 时以本进程启动时刻起算)。 */
export function bridgeStatuses() {
  const st = agentBridgeStatus()
  const nowTs = Date.now()
  return listGameServers().map((g) => {
    const s = st[g.id] || {}
    const connected = !!s.connected
    const since = connected ? nowTs : (s.offlineSince ?? STARTED_AT)
    return {
      groupId: g.id,
      name: g.name,
      active: !!g.is_active,
      connected,
      lastSeenAt: s.lastSeenAt ?? null,
      offlineMs: connected ? 0 : Math.max(0, nowTs - since),
    }
  })
}

/** 当前告警列表(纯函数;stub 模式没有真桥,不报桥离线)。 */
export function listAlerts() {
  const alerts = []
  if (config.bridge.mode !== 'stub') {
    const threshold = config.bridgeOfflineAlertMs
    if (threshold > 0) {
      for (const b of bridgeStatuses()) {
        if (!b.active || b.connected || b.offlineMs < threshold) continue
        alerts.push({
          level: 'critical',
          code: 'bridge_offline',
          groupId: b.groupId,
          message:
            `服务器组 ${b.groupId}(${b.name})的桥已离线 ${fmtDuration(b.offlineMs)}:` +
            '平台对该组无法下发任何指令(开赛/启停/建删/更新都会失败);' +
            '请在游戏主机检查 `systemctl --user status cs-agent` 与 `cs status`',
          detail: { offlineMs: b.offlineMs, lastSeenAt: b.lastSeenAt },
        })
      }
    }
  }
  return alerts
}

/** 周期巡检:告警出现/恢复各打一行日志(边沿触发);返回当前告警数。 */
export function sweepAlerts(log = (m) => console.warn(m)) {
  const cur = new Map(listAlerts().map((a) => [`${a.code}:${a.groupId ?? '-'}`, a]))
  for (const [key, a] of cur) {
    if (!LOGGED.has(key)) {
      LOGGED.add(key)
      log(`[alerts] ${a.message}`)
    }
  }
  for (const key of [...LOGGED]) {
    if (!cur.has(key)) {
      LOGGED.delete(key)
      console.log(`[alerts] 已恢复:${key}`)
    }
  }
  return cur.size
}

/** 人话时长(告警文案用)。 */
function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}
