// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 任务与维护模式(仅管理员):任务列表/详情/日志兜底/取消;C 能力的 REST 面。
//
// 任务真源在桥侧(状态与日志),平台 jobs 表是镜像(由 push kind:'job' / job_report 更新);
// 因此 `GET /api/jobs/:id?refresh=1` 可以回源桥的 job_status/job_log(排障与兜底),
// 面板日常用 socket 的 `job:*` 事件(admin 频道)即可。
import { Router } from 'express'
import { requireAdmin } from '../lib/auth.js'
import { getJob, listJobs, updateJob, isTerminal, activeJobs, listMaintenance, clearMaintenanceByJob } from '../lib/jobs.js'
import { agentConnected, hasCapability } from '../lib/agentChannel.js'
import * as bridge from '../lib/bridge.js'
import { instanceServer } from '../lib/gameServers.js'
import config from '../config.js'

// stub 模式没有真实 agent:任务由桥侧 stub 假 job 承担(联调用),不做连接/能力门禁
const canReach = (serverId) =>
  config.bridge.mode === 'stub' || (agentConnected(serverId) && hasCapability(serverId, 'jobs'))

export function createJobsRouter() {
  const router = Router()
  const admin = requireAdmin()

  // 任务列表(新 → 旧;?groupId= 过滤,?limit= 限制条数)
  router.get('/', admin, (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200))
    const groupId = typeof req.query.groupId === 'string' ? req.query.groupId : null
    res.json({ ok: true, jobs: listJobs({ limit, groupId }), active: activeJobs(), maintenance: listMaintenance() })
  })

  // 当前进行中的任务(面板任务条用)
  router.get('/current', admin, (req, res) => {
    res.json({ ok: true, jobs: activeJobs(), maintenance: listMaintenance() })
  })

  // 任务详情;?offset= 拉日志增量,?refresh=1 回源桥(排障)
  router.get('/:id', admin, async (req, res) => {
    const id = Number(req.params.id)
    let job = getJob(id)
    if (!job) return res.status(404).json({ error: '任务不存在' })
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true'
    if (refresh && job.serverId && canReach(job.serverId)) {
      try {
        const r = await bridge.jobStatus(job.serverId, id)
        if (r.job) {
          job = updateJob(id, {
            status: r.job.status, step: r.job.step, stepIndex: r.job.stepIndex,
            stepTotal: r.job.stepTotal, progress: r.job.progress,
            error: r.job.error || undefined,
            result: r.job.result ?? undefined,
            finishedAt: r.job.finishedAt || undefined,
          }) || job
          if (isTerminal(job.status)) clearMaintenanceByJob(id)
        }
      } catch (e) {
        job = { ...job, refreshError: e.message }
      }
    }
    if (req.query.offset !== undefined) {
      const offset = Math.max(0, Number(req.query.offset) || 0)
      try {
        const r = await bridge.jobLog(job.serverId, id, { offset })
        return res.json({ ok: true, job, offset: r.offset ?? offset, lines: r.lines || [] })
      } catch (e) {
        return res.status(502).json({ ok: false, job, error: e.message })
      }
    }
    let lines = []
    if (job.serverId && canReach(job.serverId)) {
      try {
        const r = await bridge.jobLog(job.serverId, id, { lines: Math.max(1, Math.min(Number(req.query.lines || 200), 2000)) })
        lines = r.lines || []
      } catch {
        lines = []
      }
    }
    res.json({ ok: true, job, lines })
  })

  // 取消(默认 A 语义:步骤边界;force=true 走 B:立即 kill 进程组,需二次确认 body.confirm==="FORCE")
  router.post('/:id/cancel', admin, async (req, res) => {
    const id = Number(req.params.id)
    const job = getJob(id)
    if (!job) return res.status(404).json({ error: '任务不存在' })
    if (isTerminal(job.status)) return res.status(409).json({ error: `任务已结束(job ${id},${job.status})` })
    const force = req.body?.force === true
    if (force && req.body?.confirm !== 'FORCE') {
      return res.status(400).json({ error: '强制取消会 kill 进程组(可能留下半更新目录),需要 confirm:"FORCE"' })
    }
    if (!canReach(job.serverId)) return res.status(502).json({ error: '主机桥未连接或未声明 jobs 能力' })
    try {
      const r = await bridge.jobCancel(job.serverId, id, force)
      const updated = updateJob(id, { status: r.status || 'cancelling', error: force ? '强制取消:游戏目录可能处于半更新状态,请随后执行 cs update 或 msm validate' : undefined })
      res.json({ ok: true, job: updated, maintenance: listMaintenance() })
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  // 某实例的当前任务(实例卡片"该实例在跑什么任务"用;M5 建删实例复用)
  router.get('/by-instance/:name', admin, (req, res) => {
    const serverId = instanceServer(req.params.name)?.id
    if (!serverId) return res.status(404).json({ error: '实例不存在' })
    const jobs = listJobs({ limit: 200 }).filter((j) => j.serverId === serverId || j.instanceName === req.params.name)
    res.json({ ok: true, jobs })
  })

  return router
}
