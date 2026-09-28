// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 实例供给(建/删)的收敛层:把 instances 行对齐到"桥侧事实 + 任务终态"。
//
// 三条收敛来源(全部以实例名为键,幂等):
//   ① 平台任务终态(`instance_create` / `instance_delete`;push kind:'job' 或 job_report 到达);
//   ② 桥侧清单对账(instances_report;主机侧 `cs new`/`cs del` 与守护每 5s 的全量 reconcile);
//   ③ 面板确认(`POST /api/instances/:name/confirm` 把「待确认」行转为可分配)。
import { getDb, now } from '../db.js'
import { cacheInstances, instanceRow } from './instances.js'
import { isTerminal } from './jobs.js'

/** 供面板/CLI 参考的供给状态取值。 */
export const PROVISION = {
  creating: 'creating', // 面板/CLI 正在建(不可分配)
  deleting: 'deleting', // 正在删(不可分配)
  failed: 'failed', // 建失败(桥已回滚半成品;行保留供排障)
  unconfirmed: 'unconfirmed', // 主机侧创建、平台待确认(不可分配)
}

// 实例清单变化的观察者(server.js 注册 → admins 频道的 `instances:update` 推送)。
// 面板此前只能 5s 轮询 /api/instances(主机侧 cs new/del 最坏 10s 才可见);有推送后可按需刷新。
let instancesNotify = null

/** 注册实例变化观察者(server.js 启动时调用一次)。 */
export function setInstancesNotifyHandler(fn) {
  instancesNotify = fn
}

/** 通知面板实例清单有变化(路由层手工改行时也用它;无观察者/无变化时是 no-op)。 */
export function notifyInstancesChanged({ serverId = null, added = [], removed = [], updated = [], reason = 'converge' }) {
  if (!instancesNotify) return
  if (!added.length && !removed.length && !updated.length) return
  try {
    instancesNotify({ serverId, added, removed, updated, reason, at: Date.now() })
  } catch (e) {
    console.warn('[provision] instances:update 推送失败:', e.message)
  }
}

/** 该组下一个可用编号(组内 max(idx)+1;缺号不回收)。 */
export function nextIdxFor(groupId) {
  const m = getDb().prepare('SELECT COALESCE(MAX(idx), 0) AS m FROM instances WHERE game_server_id = ?').get(groupId).m
  return Number(m) + 1
}

/**
 * 任务终态 → 收敛实例行(kind 只认 instance_create / instance_delete;其他 kind 直接返回)。
 *
 * 规则:
 *   create  done    → 用桥回读的 port/idx 写回,清供给态(行进入可分配)
 *   create  非 done → **删行**:桥侧失败即回滚半成品(主机上不存在),留行只会变成幽灵实例;
 *                     失败原因保留在 jobs 行(任务列表可见)
 *   delete  done    → 删行(桥已真删)
 *   delete  非 done → 保留行 + provision_state='deleting'(可重试;error 记在 jobs 行)
 */
export function convergeInstanceJob(job) {
  if (!job || !isTerminal(job.status)) return null
  if (job.kind !== 'instance_create' && job.kind !== 'instance_delete') return null
  const db = getDb()
  const name = job.instanceName || job.params?.name || null
  if (!name) return null
  // 变化名(推送给面板;与 DB 实际改动一致 —— changes=0 时不算变化)
  let changed = null
  if (job.kind === 'instance_create') {
    if (job.status === 'done') {
      const r = job.result || {}
      const port = Number(r.port) > 0 ? Number(r.port) : null
      const idx = Number(r.idx) > 0 ? Number(r.idx) : null
      const prev = instanceRow(name)
      const info = db.prepare(
        `UPDATE instances SET port = COALESCE(?, port), idx = COALESCE(?, idx), provision_state = NULL,
           provision_error = NULL, state = 'idle', updated_at = ? WHERE name = ?`,
      ).run(port, idx, now(), name)
      if (info.changes > 0) changed = 'updated'
      console.log(`[provision] 实例 ${name} 创建完成${port ? `(端口 ${port})` : ''}${prev ? '' : '(行不存在,可能已被对账删掉)'}`)
    } else {
      const info = db.prepare("DELETE FROM instances WHERE name = ? AND provision_state = 'creating'").run(name)
      let removedRows = info.changes || 0
      // 幽灵行根治:半成品存在期间守护可能已把它经 instances_report 报成「待确认」行
      // (source='bridge_report');桥侧失败会回滚半成品,该行必须一并清掉 —— 否则 `cs del`
      // 因目录不存在拒绝、面板也没法确认,只能人工删库行(桥侧实例目录检查约定)
      const ghost = db
        .prepare("DELETE FROM instances WHERE name = ? AND provision_state = 'unconfirmed' AND source = 'bridge_report'")
        .run(name)
      removedRows += ghost.changes || 0
      if (removedRows > 0) changed = 'removed'
      console.log(`[provision] 实例 ${name} 创建未成功(${job.status}),已撤回预留行/残留「待确认」行(${removedRows})`)
    }
  } else if (job.status === 'done') {
    const info = db.prepare('DELETE FROM instances WHERE name = ?').run(name)
    if (info.changes > 0) changed = 'removed'
    console.log(`[provision] 实例 ${name} 已删除(桥侧 freedBytes=${job.result?.freedBytes ?? '?'})`)
  } else {
    const info = db.prepare('UPDATE instances SET provision_state = ?, updated_at = ? WHERE name = ?')
      .run(PROVISION.deleting, now(), name)
    if (info.changes > 0) changed = 'updated'
    console.log(`[provision] 实例 ${name} 删除未成功(${job.status}),行保留待重试`)
  }
  cacheInstances()
  if (changed) notifyInstancesChanged({ serverId: job.groupId ?? job.serverId ?? null, [changed]: [name], reason: 'job' })
  return instanceRow(name)
}

/**
 * 桥侧清单对账:按 name 幂等收敛 instances 行。
 *
 *   action='added'(默认)   DB 无该名 → 登记为「待确认」(source='bridge_report',不参与分配);
 *                          DB 有该名 → 只补空缺(port=0 / idx 为空)并刷新端口;端口与 DB 冲突只告警
 *                          (端口真源在 DB;参 实例端口配置约定)
 *   action='removed'       主机侧显式删除(`cs del` 的墓碑)→ 删行(桥是"主机上有什么"的权威)
 *
 * 返回 {added, removed, updated} 计数。
 */
export function convergeInstancesReport(serverId, rows) {
  const db = getDb()
  let added = 0
  let removed = 0
  let updated = 0
  const names = { added: [], removed: [], updated: [] }
  for (const r of rows) {
    const name = typeof r?.name === 'string' ? r.name.trim() : ''
    if (!name) continue
    const action = r.action || 'added'
    if (action === 'removed') {
      const info = db.prepare('DELETE FROM instances WHERE name = ? AND game_server_id = ?').run(name, serverId)
      if (info.changes > 0) {
        removed++
        names.removed.push(name)
        console.log(`[agent] ${serverId} 主机侧已删除实例 ${name},DB 行已收敛`)
      }
      continue
    }
    const port = Number(r.port) > 0 ? Number(r.port) : 0
    const gotv = Number(r.gotvPort) > 0 ? Number(r.gotvPort) : port ? port + 100 : 0
    const idx = Number(r.idx) > 0 ? Number(r.idx) : null
    const cur = db.prepare('SELECT * FROM instances WHERE name = ?').get(name)
    if (!cur) {
      const ts = now()
      db.prepare(
        `INSERT INTO instances (name, port, state, game_server_id, admin_only, idx, provision_state, provision_error, source, created_at, updated_at)
         VALUES (?, ?, 'idle', ?, 0, ?, ?, NULL, 'bridge_report', ?, ?)`,
      ).run(name, port, serverId, idx ?? nextIdxFor(serverId), PROVISION.unconfirmed, ts, ts)
      added++
      names.added.push(name)
      console.log(`[agent] ${serverId} 登记主机侧实例 ${name}(端口 ${port || '未知'},待管理员确认后才参与自动分配)`)
      continue
    }
    // 已登记:只补空缺 + 告警(不改平台的端口/编号决定)
    const patch = {}
    if (!cur.port && port) patch.port = port
    else if (cur.port && port && cur.port !== port) {
      console.warn(`[agent] ${serverId} 实例 ${name} 端口不一致:平台 ${cur.port} / 主机 ${port}(以平台为准,可用面板修正)`)
    }
    if (cur.idx == null && idx != null) patch.idx = idx
    else if (cur.idx != null && idx != null && cur.idx !== idx) {
      console.warn(`[agent] ${serverId} 实例 ${name} 编号不一致:平台 #${cur.idx} / 主机 #${idx}(以平台为准)`)
    }
    // 面板发起的创建在跑:任务终态会清供给态;此处若桥已就位而任务行丢失,兜底放开
    if (cur.provision_state === PROVISION.creating && !activeCreateJob(name)) {
      patch.provision_state = null
      patch.provision_error = null
    }
    if (Object.keys(patch).length > 0) {
      patch.updated_at = now()
      const keys = Object.keys(patch)
      db.prepare(`UPDATE instances SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE name = ?`).run(...keys.map((k) => patch[k]), name)
      updated++
      names.updated.push(name)
    }
  }
  if (added || removed || updated) {
    cacheInstances()
    notifyInstancesChanged({ serverId, ...names, reason: 'report' })
  }
  return { added, removed, updated }
}

/** 是否有该实例的进行中创建任务(对账兜底:任务行丢失时不该把行永久卡在 creating)。 */
function activeCreateJob(name) {
  const rows = getDb()
    .prepare("SELECT params FROM jobs WHERE kind = 'instance_create' AND status IN ('queued','running','cancelling') ORDER BY id DESC LIMIT 20")
    .all()
  return rows.some((r) => {
    try {
      return JSON.parse(r.params || '{}').name === name
    } catch {
      return false
    }
  })
}

/** 面板「确认」待确认实例(转可分配)。返回更新后的行;行不存在或状态不符返回 null。 */
export function confirmInstance(name) {
  const row = instanceRow(name)
  if (!row) return null
  const info = getDb()
    .prepare('UPDATE instances SET provision_state = NULL, provision_error = NULL, updated_at = ? WHERE name = ?')
    .run(now(), name)
  cacheInstances()
  if (info.changes > 0) notifyInstancesChanged({ serverId: row.game_server_id ?? null, updated: [name], reason: 'confirm' })
  return instanceRow(name)
}

/** 任务的实例名(建删任务用;缺 instance_name 时回退 params.name)。 */
export function jobInstanceName(job) {
  if (!job) return null
  return job.instanceName || job.params?.name || null
}
