// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 主机概况:GET /api/host/status(仅管理员)
//
// 数据源 = 桥的 host_status op;本模块只做**缓存与降级**:
//   - 30s TTL 缓存(与 lib/workshop.js 同款范式),?refresh=1 绕过;
//   - 桥未连接 / 未声明 host_status 能力(旧 Python 桥)→ 返回 stale 缓存 + error,无缓存才 502;
//   - 逐个活跃服务器组查询:面板按组展示,组之间互不影响。
import config from '../config.js'
import * as bridge from './bridge.js'
import { listGameServers } from './gameServers.js'
import { getCapabilities, agentConnected } from './agentChannel.js'

const TTL_MS = Number(process.env.HOST_STATUS_TTL_MS || 30000)

// serverId → { data, at, error }
const CACHE = new Map()

function cacheGet(serverId, { refresh = false } = {}) {
  const hit = CACHE.get(serverId)
  if (!hit || refresh) return null
  if (Date.now() - hit.at > TTL_MS) return null
  return hit
}

/**
 * 取某组主机概况。
 * 返回 { ok:true, groupId, groupName, ...hostStatus } 或 { ok:false, groupId, error, stale? , ...staleData }
 */
export async function getHostStatus(serverId, { refresh = false } = {}) {
  const group = listGameServers().find((s) => s.id === serverId)
  const name = group?.name || serverId

  const hit = cacheGet(serverId, { refresh })
  if (hit) return { ...hit.data, groupId: serverId, groupName: name, cachedAt: hit.at }

  // stub 模式:没有真实 agent,数据来自 <ARENA_STUB_DIR>/host-status.json 夹具(前端联调用)
  if (config.bridge.mode === 'stub') {
    try {
      const data = await bridge.hostStatus(serverId, refresh)
      const payload = { ok: true, dataSource: 'stub', groupId: serverId, groupName: name, ...data }
      CACHE.set(serverId, { data: payload, at: Date.now() })
      return { ...payload, cachedAt: Date.now() }
    } catch (e) {
      return { ok: false, dataSource: 'stub', groupId: serverId, groupName: name, error: `stub 夹具读取失败: ${e.message}` }
    }
  }

  if (!agentConnected(serverId)) {
    const stale = CACHE.get(serverId)
    if (stale) return { ...stale.data, groupId: serverId, groupName: name, cachedAt: stale.at, error: '桥未连接(以下为缓存数据)' }
    return { ok: false, groupId: serverId, groupName: name, error: '桥未连接(agent 未在线)' }
  }
  if (!getCapabilities(serverId).includes('host_status')) {
    const stale = CACHE.get(serverId)
    const msg = '主机 agent 未声明 host_status 能力(旧桥);请升级到 v2 桥(agent/v2)'
    if (stale) return { ...stale.data, groupId: serverId, groupName: name, cachedAt: stale.at, error: msg }
    return { ok: false, groupId: serverId, groupName: name, error: msg }
  }

  try {
    const data = await bridge.hostStatus(serverId, refresh)
    const payload = { ok: true, dataSource: 'agent', groupId: serverId, groupName: name, ...data }
    CACHE.set(serverId, { data: payload, at: Date.now() })
    return { ...payload, cachedAt: Date.now() }
  } catch (e) {
    const stale = CACHE.get(serverId)
    if (stale) return { ...stale.data, groupId: serverId, groupName: name, cachedAt: stale.at, error: `查询失败: ${e.message}(以下为缓存数据)` }
    return { ok: false, groupId: serverId, groupName: name, error: `查询失败: ${e.message}` }
  }
}

export function clearHostStatusCache() {
  CACHE.clear()
}

// 供 /api/health 之类的轻量接口复用(不触发桥调用)
export function hostStatusCacheAge(serverId) {
  const hit = CACHE.get(serverId)
  return hit ? Date.now() - hit.at : null
}

export const hostStatusTtlMs = TTL_MS
export const hostStatusConfigHint = { hasSteamProxy: !!config.steamProxy }
