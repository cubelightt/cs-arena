// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 服务器状态:每台 game_servers(一个 agent/桥控制的一组实例)归为一组,每个服务器对应一个实例
// 三态:in_match(比赛中)/ idle(空闲)/ stopped(已停止);桥不可达为 unknown
// 实例名以 agent /v1/health 返回为准(health 不可达时回退 DB 中该服务器的实例)
// showAdminOnly=false(普通用户)时隐藏 admin_only 实例,组 summary 同步剔除
import { listGameServers, serverInstanceNames } from './gameServers.js'
import { listInstances } from './instances.js'
import * as bridge from './bridge.js'
import config from '../config.js'

export const STATUS_LABELS = {
  in_match: '比赛中',
  idle: '空闲',
  stopped: '已停止',
  unknown: '未知',
}

export function normalizeStatus(health, state, provisionState = null) {
  // 供给中(creating/deleting/failed)或待确认(bridge_report)的实例一律不可用 →
  // 归入 unknown(面板据 provisionState 显示「部署中/待确认」徽章;分配守卫在后端)
  if (provisionState) return 'unknown'
  if (health === 'STOPPED') return 'stopped'
  if (health === 'RUNNING') {
    // booting(开赛准备)/ cooling(赛后等 demo)/ in_match 均视为"比赛中"(实例被占用)
    if (state === 'idle') return 'idle'
    return 'in_match'
  }
  return 'unknown'
}

export async function buildServerStatus({ showAdminOnly = true } = {}) {
  const instStates = new Map(listInstances().map((i) => [i.name, i]))
  const groups = []

  for (const srv of listGameServers({ activeOnly: true })) {
    let health = {}
    try {
      health = (await bridge.bridgeHealth(srv)).instances || {}
    } catch {
      health = {}
    }
    // 并集:DB 实例 ∪ 桥健康实例 —— 桥配置未同步的新增实例显示为 UNKNOWN(提示需同步),不再消失
    let names = [...new Set([...serverInstanceNames(srv.id), ...Object.keys(health)])]
    if (names.length === 0) names = Object.keys(health)
    if (!showAdminOnly) {
      names = names.filter((n) => !instStates.get(n)?.adminOnly)
    }

    const servers = names.map((name) => {
      const h = health[name] || 'UNKNOWN'
      const st = instStates.get(name)
      const state = st?.state ?? 'idle'
      const provisionState = st?.provisionState ?? null
      const status = normalizeStatus(h, state, provisionState)
      return {
        name,
        port: st?.port ?? 0,
        status,
        statusLabel: STATUS_LABELS[status] ?? status,
        health: h,
        state,
        provisionState,
        matchId: st?.matchId ?? null,
        adminOnly: !!st?.adminOnly,
        botCapable: name === config.botInstanceName, // 增强人机模式仅此实例可用(装了 CS2-Bot-Improver)
      }
    })

    const summary = { inMatch: 0, idle: 0, stopped: 0, unknown: 0 }
    for (const s of servers) {
      if (s.status === 'in_match') summary.inMatch++
      else if (s.status === 'idle') summary.idle++
      else if (s.status === 'stopped') summary.stopped++
      else summary.unknown++
    }

    groups.push({
      groupId: srv.id,
      groupName: srv.name,
      hostIp: srv.host_ip,
      region: srv.region,
      summary,
      servers,
    })
  }
  return groups
}
