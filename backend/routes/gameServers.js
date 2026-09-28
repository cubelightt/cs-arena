// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 服务器组管理(仅管理员)
// game_servers 表 + 其下实例;添加/编辑桥模式强制 http
// 改动即时生效(桥/实例/分组读取均为 DB 驱动)
import { Router } from 'express'
import { getDb, now } from '../db.js'
import { requireAdmin } from '../lib/auth.js'
import { listGameServers, getGameServer } from '../lib/gameServers.js'
import { cacheInstances } from '../lib/instances.js'
import { agentConnectedMap, disconnectAgent, getReportedInstances } from '../lib/agentChannel.js'

const BRIDGE_MODES = ['http'] // 面板强制 http

function serverJson(row, connected = false) {
  return {
    id: row.id,
    name: row.name,
    hostIp: row.host_ip,
    region: row.region,
    bridgeUrl: row.bridge_url,
    bridgeToken: row.bridge_token,
    bridgeMode: row.bridge_mode,
    isActive: !!row.is_active,
    connected,
    // 桥 hello 上报的实例名清单(首次连接种子 + 交叉校验用;null = 桥未连接/未上报)
    reportedInstances: getReportedInstances(row.id),
    // 实例清单(M5:补 idx/state/provisionState/source,面板按 idx 展示与排序)
    instances: getDb()
      .prepare('SELECT name, port, idx, state, provision_state, source FROM instances WHERE game_server_id = ? ORDER BY (idx IS NULL), idx, rowid')
      .all(row.id)
      .map((i) => ({
        name: i.name,
        port: i.port,
        idx: i.idx ?? null,
        state: i.state,
        provisionState: i.provision_state ?? null,
        source: i.source ?? null,
      })),
  }
}

// 交叉校验(仅警告,不阻断):桥在线且上报过清单时,列出不在主机上的实例名
function syncWarnings(id, instanceNames) {
  if (!agentConnectedMap()[id]) return []
  const reported = getReportedInstances(id)
  if (!Array.isArray(reported)) return []
  return instanceNames
    .filter((n) => !reported.includes(n))
    .map((n) => `实例 ${n} 主机桥未上报,可能未加入主机 config.json 的 instances(仅警告)`)
}

// bridge_token 全局唯一(防 reverse 模式下两组合用一 token 导致连接互相顶替)
function tokenConflict(token, excludeId = null) {
  const row = getDb().prepare('SELECT id FROM game_servers WHERE bridge_token = ?').get(token)
  return row && row.id !== excludeId ? row.id : null
}

function validateBody(body) {
  const errors = []
  if (!body || typeof body !== 'object') return { errors: ['缺少请求体'] }
  if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name 必填')
  if (typeof body.hostIp !== 'string' || !body.hostIp.trim()) errors.push('hostIp 必填')
  if (typeof body.region !== 'string' || !body.region.trim()) errors.push('region 必填')
  // bridgeUrl 可选:reverse 模式下桥主动连后端,可留空;http 模式需填写(面板/文档提示)
  if (body.bridgeUrl !== undefined && body.bridgeUrl !== '' && typeof body.bridgeUrl === 'string' && !/^https?:\/\//.test(body.bridgeUrl)) {
    errors.push('bridgeUrl 需以 http(s):// 开头')
  }
  if (typeof body.bridgeToken !== 'string' || !body.bridgeToken.trim()) errors.push('bridgeToken 必填')
  if (body.bridgeMode !== undefined && !BRIDGE_MODES.includes(body.bridgeMode)) errors.push('bridgeMode 仅支持 http')
  // instances 可选(reverse 新建可空,连接后经 PUT 添加);存在时校验条目格式
  if (body.instances !== undefined && !Array.isArray(body.instances)) {
    errors.push('instances 需为数组')
  } else {
    for (const inst of body.instances ?? []) {
      if (!inst || typeof inst.name !== 'string' || !inst.name.trim()) errors.push('实例 name 必填')
      if (!inst || !Number.isInteger(Number(inst.port)) || Number(inst.port) <= 0) errors.push('实例 port 非法')
    }
  }
  return { errors }
}

export function createGameServersRouter() {
  const router = Router()
  const admin = requireAdmin()

  // 列表(含 bridge_token 明文与连接状态,面板编辑用;仅管理员)
  router.get('/', admin, (req, res) => {
    const connectedMap = agentConnectedMap()
    res.json(listGameServers().map((row) => serverJson(row, !!connectedMap[row.id])))
  })

  // 新增服务器组(强制 bridgeMode=http;id 缺省自动生成 gN)
  router.post('/', admin, (req, res) => {
    const { errors } = validateBody(req.body)
    if (errors.length) return res.status(400).json({ error: errors.join('; ') })
    const b = req.body
    const db = getDb()

    let id = b.id
    if (id == null || id === '') {
      const max = db
        .prepare("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) AS m FROM game_servers WHERE id GLOB 'g[0-9]*'")
        .get().m
      id = `g${(max || 0) + 1}`
    } else if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) {
      return res.status(400).json({ error: 'id 需为字母数字/下划线/点/连字符' })
    }
    if (db.prepare('SELECT id FROM game_servers WHERE id = ?').get(id)) {
      return res.status(409).json({ error: `服务器组 ${id} 已存在` })
    }
    if (tokenConflict(b.bridgeToken.trim())) {
      return res.status(409).json({ error: 'bridgeToken 已被其他服务器组使用' })
    }
    for (const inst of (b.instances || [])) {
      if (db.prepare('SELECT name FROM instances WHERE name = ?').get(inst.name)) {
        return res.status(409).json({ error: `实例名 ${inst.name} 已存在` })
      }
    }

    db.prepare(
      'INSERT INTO game_servers (id, name, host_ip, region, bridge_url, bridge_token, bridge_mode, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, b.name.trim(), b.hostIp.trim(), b.region.trim(), (b.bridgeUrl || "").trim(), b.bridgeToken.trim(), b.bridgeMode ?? 'http', b.isActive === false ? 0 : 1, now())
    const insertInst = db.prepare(
      'INSERT INTO instances (name, port, state, game_server_id, admin_only, idx, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    let idx = 1
    for (const inst of (b.instances || [])) {
      const ts = now()
      insertInst.run(inst.name.trim(), Number(inst.port), 'idle', id, 0, idx++, 'panel', ts, ts)
    }
    cacheInstances()
    res.status(201).json(serverJson(db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id)))
  })

  // 编辑服务器组(实例清单**差量更新**;强制 bridgeMode=http)
  router.put('/:id', admin, (req, res) => {
    const { id } = req.params
    const db = getDb()
    const existing = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id)
    if (!existing) return res.status(404).json({ error: '服务器组不存在' })
    const { errors } = validateBody(req.body)
    if (errors.length) return res.status(400).json({ error: errors.join('; ') })
    const b = req.body
    if (tokenConflict(b.bridgeToken.trim(), id)) {
      return res.status(409).json({ error: 'bridgeToken 已被其他服务器组使用' })
    }
    // instances 为**可选**字段(2026-09-23):面板「编辑服务器组」不再维护实例列表(实例增删改走「实例管理」),
    // 不提供时一律不动 instances 表;显式提供数组时仍走下面的差量更新(兼容旧客户端/脚本)
    const wantsInstances = Array.isArray(b.instances)
    if (wantsInstances) {
      for (const inst of b.instances) {
        const dup = db.prepare('SELECT name FROM instances WHERE name = ? AND game_server_id != ?').get(inst.name, id)
        if (dup) return res.status(409).json({ error: `实例名 ${inst.name} 已被其他服务器组占用` })
      }
    }
    // 差量更新(差量更新可保留实例状态):原先"整表删+重插"会把 idx/provision_state/
    // source/created_at 等列重置为默认值、并把实例锁抹成 idle —— 改为按 name 增/改/删:
    //   已存在 → 只改端口(编号/来源/锁/供给列原样保留);新增 → 组内 max(idx)+1,source='panel';
    //   移除 → 仅当空闲且不在供给流程中才允许,否则 409(防把在用/部署中的实例悄悄摘掉)
    const rows = db.prepare('SELECT * FROM instances WHERE game_server_id = ?').all(id)
    const byName = new Map(rows.map((r) => [r.name, r]))
    const want = new Map(wantsInstances ? b.instances.map((i) => [i.name.trim(), Number(i.port)]) : [])
    const busy = wantsInstances ? rows.filter((r) => !want.has(r.name) && (r.state !== 'idle' || r.provision_state != null)) : []
    if (busy.length > 0) {
      return res.status(409).json({ error: `实例 ${busy.map((r) => r.name).join(', ')} 使用中或正在部署,无法从组内移除` })
    }
    db.prepare(
      'UPDATE game_servers SET name = ?, host_ip = ?, region = ?, bridge_url = ?, bridge_token = ?, bridge_mode = ?, is_active = ? WHERE id = ?',
    ).run(b.name.trim(), b.hostIp.trim(), b.region.trim(), (b.bridgeUrl || "").trim(), b.bridgeToken.trim(), b.bridgeMode ?? 'http', b.isActive === false ? 0 : 1, id)
    let nextIdx = Number(db.prepare('SELECT COALESCE(MAX(idx), 0) AS m FROM instances WHERE game_server_id = ?').get(id).m) + 1
    const updPort = db.prepare('UPDATE instances SET port = ?, updated_at = ? WHERE name = ?')
    const insertInst = db.prepare(
      'INSERT INTO instances (name, port, state, game_server_id, admin_only, idx, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    if (wantsInstances) {
      for (const [name, port] of want) {
        if (byName.has(name)) {
          updPort.run(port, now(), name)
        } else {
          const ts = now()
          insertInst.run(name, port, 'idle', id, 0, nextIdx++, 'panel', ts, ts)
        }
      }
      for (const r of rows) {
        if (!want.has(r.name)) db.prepare('DELETE FROM instances WHERE name = ?').run(r.name)
      }
      cacheInstances()
    }
    const payload = serverJson(db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id))
    // 交叉校验(仅警告):实例名不在桥上报清单 → 附 warnings,不阻断(未提供 instances 时按库内现有清单校对)
    const warnings = syncWarnings(
      id,
      wantsInstances ? b.instances.map((i) => i.name.trim()) : rows.map((r) => r.name),
    )
    if (warnings.length > 0) payload.warnings = warnings
    res.json(payload)
  })

  // 激活/停用
  router.post('/:id/:action', admin, (req, res) => {
    const { id, action } = req.params
    if (!['activate', 'deactivate'].includes(action)) return res.status(400).json({ error: 'action 仅支持 activate/deactivate' })
    const active = action === 'activate' ? 1 : 0
    const db = getDb()
    const existing = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id)
    if (!existing) return res.status(404).json({ error: '服务器组不存在' })
    db.prepare('UPDATE game_servers SET is_active = ? WHERE id = ?').run(active, id)
    res.json(serverJson(db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id)))
  })

  // 删除服务器组(实例使用中拒删;删除时断开桥连接)
  router.delete('/:id', admin, (req, res) => {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(req.params.id)
    if (!existing) return res.status(404).json({ error: '服务器组不存在' })
    const busy = db
      .prepare("SELECT name FROM instances WHERE game_server_id = ? AND state IN ('booting', 'in_match', 'cooling')")
      .all(req.params.id)
    if (busy.length > 0) {
      return res.status(409).json({ error: `实例 ${busy.map((i) => i.name).join(', ')} 使用中,无法删除` })
    }
    disconnectAgent(req.params.id)
    db.prepare('DELETE FROM instances WHERE game_server_id = ?').run(req.params.id)
    db.prepare('DELETE FROM game_servers WHERE id = ?').run(req.params.id)
    cacheInstances()
    res.json({ ok: true })
  })

  return router
}
