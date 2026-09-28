// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 任务与维护模式:jobs / maintenance 表的读写 + 守卫判定。
//
// 分工:
//   - **任务真源在桥侧**(jobs/<id>.log 与状态);平台这里记"谁在什么时间发起了什么 + 当前状态",
//     状态由桥的 push kind:'job' / job_report 更新(实时),REST 兜底可回源 job_status 查;
//   - **维护态的权威在平台**(maintenance 表):更新期间该组全实例不可分配/不可开赛/不可启停,
//     其他组不受影响;任务终态自动解除。
import { getDb } from '../db.js'

export const JOB_TERMINAL = ['done', 'failed', 'cancelled']
export const JOB_ACTIVE = ['queued', 'running', 'cancelling']

function parseJSON(raw, def) {
  if (!raw) return def
  try {
    return JSON.parse(raw)
  } catch {
    return def
  }
}

function jobRow(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    serverId: row.server_id,
    groupId: row.group_id,
    instanceName: row.instance_name,
    status: row.status,
    step: row.step,
    stepIndex: row.step_index,
    stepTotal: row.step_total,
    progress: row.progress,
    params: parseJSON(row.params, {}),
    result: parseJSON(row.result, null),
    error: row.error,
    origin: row.origin,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

// ---- 任务 ------------------------------------------------------------------

export function createJob({ kind, serverId = null, groupId = null, instanceName = null, params = {}, createdBy = null, origin = 'panel', id = null }) {
  const now = Date.now()
  const stmt = id
    ? getDb()
        .prepare(
          `INSERT INTO jobs (id, kind, server_id, group_id, instance_name, status, params, origin, created_by, created_at, started_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
    : getDb()
        .prepare(
          `INSERT INTO jobs (kind, server_id, group_id, instance_name, status, params, origin, created_by, created_at, started_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
  const args = id
    ? [id, kind, serverId, groupId, instanceName, JSON.stringify(params), origin, createdBy, now, now]
    : [kind, serverId, groupId, instanceName, JSON.stringify(params), origin, createdBy, now, now]
  const info = stmt.run(...args)
  return getJob(Number(info.lastInsertRowid))
}

export function getJob(id) {
  return jobRow(getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id)))
}

// 任务列表(新的在前)。
export function listJobs({ limit = 50, groupId = null } = {}) {
  const rows = groupId
    ? getDb().prepare('SELECT * FROM jobs WHERE group_id = ? ORDER BY id DESC LIMIT ?').all(groupId, limit)
    : getDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(jobRow)
}

// 该组当前进行中的任务(queued/running/cancelling)。
export function activeJobOfGroup(groupId) {
  const rows = getDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 200').all().map(jobRow)
  return rows.find((j) => j.groupId === groupId && JOB_ACTIVE.includes(j.status)) || null
}

// 全局进行中的任务(面板"当前任务"用)。
export function activeJobs() {
  return getDb().prepare('SELECT * FROM jobs').all().map(jobRow).filter((j) => JOB_ACTIVE.includes(j.status))
}

export function updateJob(id, patch) {
  const cur = getJob(id)
  if (!cur) return null
  const next = { ...cur, ...patch }
  getDb()
    .prepare(
      `UPDATE jobs SET status = ?, step = ?, step_index = ?, step_total = ?, progress = ?, result = ?,
       error = ?, started_at = ?, finished_at = ? WHERE id = ?`,
    )
    .run(
      next.status,
      next.step ?? null,
      next.stepIndex ?? null,
      next.stepTotal ?? null,
      next.progress ?? 0,
      next.result ? JSON.stringify(next.result) : null,
      next.error ?? null,
      next.startedAt ?? null,
      next.finishedAt ?? null,
      Number(id),
    )
  return getJob(id)
}

export function isTerminal(status) {
  return JOB_TERMINAL.includes(status)
}

// ---- 维护模式(按组)--------------------------------------------------------

export function setMaintenance(groupId, { enabled, reason = null, jobId = null, by = null }) {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO maintenance (group_id, enabled, reason, job_id, started_at, by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET enabled = excluded.enabled, reason = excluded.reason,
         job_id = excluded.job_id, started_at = excluded.started_at, by = excluded.by`,
    )
    .run(groupId, enabled ? 1 : 0, reason, jobId, now, by)
  return getMaintenance(groupId)
}

export function getMaintenance(groupId) {
  const row = getDb().prepare('SELECT * FROM maintenance WHERE group_id = ?').get(groupId)
  if (!row) return { groupId, enabled: false, reason: null, jobId: null }
  return {
    groupId: row.group_id,
    enabled: !!row.enabled,
    reason: row.reason,
    jobId: row.job_id,
    startedAt: row.started_at,
    by: row.by,
  }
}

// 全部"生效中"的维护组(校验/前端提示用)。
export function listMaintenance() {
  return getDb()
    .prepare('SELECT * FROM maintenance WHERE enabled = 1')
    .all()
    .map((row) => ({
      groupId: row.group_id,
      enabled: true,
      reason: row.reason,
      jobId: row.job_id,
      startedAt: row.started_at,
      by: row.by,
    }))
}

export function isGroupInMaintenance(groupId) {
  if (!groupId) return false
  const row = getDb().prepare('SELECT enabled FROM maintenance WHERE group_id = ?').get(groupId)
  return !!(row && row.enabled)
}

// 任务终态:清掉它开的维护(只清"由该 job 开启"的那一行,避免误清管理员手动开的维护)。
export function clearMaintenanceByJob(jobId) {
  if (!jobId) return 0
  const info = getDb().prepare('UPDATE maintenance SET enabled = 0, reason = NULL, job_id = NULL WHERE job_id = ?').run(Number(jobId))
  return info.changes || 0
}

// 该组的维护提示文案(守卫 409 用)。
export function maintenanceMessage(groupId) {
  const m = getMaintenance(groupId)
  if (!m.enabled) return null
  return `该服务器组维护中${m.reason ? ':' + m.reason : ''}`
}
