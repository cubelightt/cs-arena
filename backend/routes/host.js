// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 主机概况(仅管理员):GET /api/host/status?groupId=g1&refresh=1
// 数据源是桥的 host_status op(v2 桥专属,旧桥降级返回 error)。
import { Router } from 'express'
import { getDb } from '../db.js'
import { requireAdmin, requireAuth } from '../lib/auth.js'
import { getHostStatus, clearHostStatusCache, hostStatusTtlMs } from '../lib/hostinfo.js'
import { listGameServers, serverInstanceNames } from '../lib/gameServers.js'
import { agentConnected, agentConnectedMap, hasCapability } from '../lib/agentChannel.js'
import * as bridge from '../lib/bridge.js'
import {
  createJob, getJob, updateJob, activeJobOfGroup, setMaintenance, getMaintenance, listMaintenance,
  clearMaintenanceByJob, isTerminal,
} from '../lib/jobs.js'
import { convergeInstanceJob } from '../lib/provisioning.js'
import { listAlerts, bridgeStatuses, backendInfo } from '../lib/alerts.js'
import config from '../config.js'

/**
 * stub 模式的任务进度轮询:stub 桥没有真实推送,平台在这里按 <STUB_UPDATE_MS> 回源 job_status,
 * 让面板/前端在没有真机时也能看到进度条推进与终态(与真机 push kind:'job' 等价的效果)。
 */
export function watchStubJob(io, serverId, jobId) {
  if (config.bridge.mode !== 'stub') return
  const tick = Number(process.env.STUB_UPDATE_MS || 400)
  const timer = setInterval(async () => {
    let job
    try {
      const r = await bridge.jobStatus(serverId, jobId)
      job = r.job
    } catch {
      clearInterval(timer)
      return
    }
    if (!job) {
      clearInterval(timer)
      return
    }
    updateJob(jobId, {
      status: job.status, step: job.step, stepIndex: job.stepIndex, stepTotal: job.stepTotal,
      progress: job.progress, error: job.error || undefined,
      // stub 假任务的终态 result 也要落库(建删实例靠它收敛 port/idx/freedBytes)
      ...(job.result ? { result: job.result } : {}),
      finishedAt: isTerminal(job.status) ? Date.now() : undefined,
    })
    io?.to('admins').emit('job:update', { serverId, kind: 'job', ...job })
    if (isTerminal(job.status)) {
      clearMaintenanceByJob(jobId)
      // 建/删实例的假任务同样收敛 instances 行(与真机 push 路径一致)
      convergeInstanceJob(getJob(jobId))
      io?.to('admins').emit('job:done', { serverId, jobId, status: job.status })
      clearInterval(timer)
    }
  }, tick)
  timer.unref?.()
}

// 磁盘清理的白名单模式(与桥的 cleanupPattern 一一对应;新增模式时两边同步)。
const CLEANUP_PATTERNS = ['backup:old', 'logs:rotate', 'sniper:stubs', 'stale-instance-dirs', 'bridge:old']

/**
 * 任务型主机操作的公共前置检查(组存在且激活 → 该组没有进行中任务 → 真机还需桥在线 + 声明 jobs 能力)。
 * 通过返回 { ok:true, groupId };否则**已写好响应**(400/404/409/502)并返回 { ok:false }。
 * (game-update 另有"实例占用/进行中比赛"两道更严的检查,故它保留自己的内联实现。)
 */
function preflightHostJob(req, res) {
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId : null
  if (!groupId) {
    res.status(400).json({ error: '缺少 groupId' })
    return { ok: false }
  }
  const group = listGameServers().find((g) => g.id === groupId)
  if (!group) {
    res.status(404).json({ error: '服务器组不存在' })
    return { ok: false }
  }
  if (!group.is_active) {
    res.status(409).json({ error: '服务器组未激活' })
    return { ok: false }
  }
  const active = activeJobOfGroup(groupId)
  if (active) {
    res.status(409).json({ error: `该服务器组已有进行中任务(job ${active.id})` })
    return { ok: false }
  }
  if (config.bridge.mode !== 'stub') {
    if (!agentConnected(groupId)) {
      res.status(502).json({ error: '主机桥未连接,无法下发任务' })
      return { ok: false }
    }
    if (!hasCapability(groupId, 'jobs')) {
      res.status(502).json({ error: '主机 agent 未声明 jobs 能力(旧桥);请升级到 v2 桥(agent/v2)' })
      return { ok: false }
    }
  }
  return { ok: true, groupId }
}

export function createHostRouter() {
  const router = Router()
  const auth = requireAuth()
  const admin = requireAdmin()

  // 平台在线告警:
  // 面板首页/主机概况拿它渲染红条;`/api/health` 里也带同一份(前端已 5s 轮询,零额外成本)
  router.get('/alerts', admin, (req, res) => {
    res.json({ ok: true, alerts: listAlerts(), bridges: bridgeStatuses(), backend: backendInfo() })
  })

  // 主机概况:默认返回所有活跃组(面板一屏看多组);?groupId= 只取一组
  router.get('/status', admin, async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true'
    const only = typeof req.query.groupId === 'string' ? req.query.groupId : null
    const groups = listGameServers().filter((g) => (only ? g.id === only : true))
    if (only && groups.length === 0) return res.status(404).json({ error: '服务器组不存在' })

    const connected = agentConnectedMap()
    const out = []
    for (const g of groups) {
      const data = await getHostStatus(g.id, { refresh })
      // 维护态以**平台 maintenance 表**为准(权威在平台);桥侧自报的维护态仅作参考
      const m = getMaintenance(g.id)
      out.push({
        ...data,
        connected: !!connected[g.id],
        maintenance: [{ groupId: g.id, enabled: !!m.enabled, reason: m.reason ?? null, jobId: m.jobId ?? null }],
      })
    }
    res.json({ ok: true, ttlMs: hostStatusTtlMs, groups: out })
  })

  // 触发游戏更新
  router.post('/game-update', admin, async (req, res) => {
    const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId : null
    const confirm = req.body?.confirm
    if (!groupId) return res.status(400).json({ error: '缺少 groupId' })
    if (confirm !== 'UPDATE') return res.status(400).json({ error: '二次确认串不匹配(需要 confirm:"UPDATE")' })
    const group = listGameServers().find((g) => g.id === groupId)
    if (!group) return res.status(404).json({ error: '服务器组不存在' })
    if (!group.is_active) return res.status(409).json({ error: '服务器组未激活' })

    const active = activeJobOfGroup(groupId)
    if (active) return res.status(409).json({ error: `该服务器组已有进行中任务(job ${active.id})` })

    // 该组有 live 比赛 → 拒绝(实例锁/比赛表双重判定)
    const names = serverInstanceNames(groupId)
    const busy = names.length
      ? getDb()
          .prepare(
            `SELECT COUNT(*) AS c FROM instances WHERE name IN (${names.map(() => '?').join(',')}) AND state != 'idle'`,
          )
          .get(...names).c
      : 0
    if (busy > 0) return res.status(409).json({ error: '该服务器组有实例正在使用中(比赛/启动/冷却),暂不能更新' })
    const live = names.length
      ? getDb()
          .prepare(
            `SELECT COUNT(*) AS c FROM matches WHERE instance_name IN (${names.map(() => '?').join(',')}) AND status NOT IN ('ended','aborted')`,
          )
          .get(...names).c
      : 0
    if (live > 0) return res.status(409).json({ error: '该服务器组有进行中的比赛,暂不能更新' })

    // stub 模式没有真实 agent:任务由进程内假 job 承担(联调用),不做连接/能力门禁
    if (config.bridge.mode !== 'stub') {
      if (!agentConnected(groupId)) return res.status(502).json({ error: '主机桥未连接,无法下发更新任务' })
      if (!hasCapability(groupId, 'jobs')) {
        return res.status(502).json({ error: '主机 agent 未声明 jobs 能力(旧桥);请升级到 v2 桥(agent/v2)' })
      }
    }

    const job = createJob({
      kind: 'game_update',
      serverId: groupId,
      groupId,
      params: {},
      createdBy: req.user?.steamId ?? null,
      origin: 'panel',
    })
    const maint = setMaintenance(groupId, { enabled: true, reason: `游戏更新(job ${job.id})`, jobId: job.id, by: req.user?.steamId ?? 'panel' })
    try {
      // 平台编号下发给桥:桥日志文件名与平台行号同名;桥在内部把该组白名单实例全部 stop → update → start
      const r = await bridge.jobStart(groupId, 'game_update', {}, { confirm: 'UPDATE', jobId: job.id })
      updateJob(job.id, { status: r.status || 'running', progress: 0, step: r.step, stepIndex: r.stepIndex, stepTotal: r.stepTotal })
      watchStubJob(req.app.get('io'), groupId, job.id)
      res.status(202).json({ ok: true, job: getJob(job.id), maintenance: maint })
    } catch (e) {
      // 桥拒绝(参数/组锁/msm 不可用):任务立即置 failed,并清除刚开的维护
      updateJob(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() })
      setMaintenance(groupId, { enabled: false })
      res.status(502).json({ error: `下发失败: ${e.message}`, job: getJob(job.id) })
    }
  })

  // 录像归集(仅管理员;M6 面板入口):把实例 MatchZy/*.dem 归集到 host 的 demo_dir。
  // 非破坏性(dem 只是搬家),但**默认 dry-run**;要真归集需显式传 dryRun:false。
  router.post('/demo-collect', admin, async (req, res) => {
    const all = req.body?.all === true
    const matchId = typeof req.body?.matchId === 'string' ? req.body.matchId.trim() : ''
    if (!all && !matchId) return res.status(400).json({ error: '需要 matchId(单场次)或 all:true(全量)' })
    const pre = preflightHostJob(req, res)
    if (!pre.ok) return
    const dryRun = req.body?.dryRun !== false // 默认只预览
    const params = { all: all || !matchId, matchId, dryRun }

    const job = createJob({
      kind: 'demo_collect', serverId: pre.groupId, groupId: pre.groupId, params,
      createdBy: req.user?.steamId ?? null, origin: 'panel',
    })
    try {
      const r = await bridge.jobStart(pre.groupId, 'demo_collect', params, { jobId: job.id })
      updateJob(job.id, { status: r.status || 'running', progress: 0, step: r.step, stepIndex: r.stepIndex, stepTotal: r.stepTotal })
      watchStubJob(req.app.get('io'), pre.groupId, job.id)
      res.status(202).json({ ok: true, job: getJob(job.id), dryRun })
    } catch (e) {
      updateJob(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() })
      res.status(502).json({ error: `下发失败: ${e.message}`, job: getJob(job.id) })
    }
  })

  // 磁盘清理(仅管理员;M6 面板入口):白名单模式 + **默认 dry-run**;真删必须 confirm:"CLEAN"
  // (与 CLI `cs host cleanup` 同一套语义;.dem 永不在白名单内,不会删录像)。
  router.post('/cleanup', admin, async (req, res) => {
    const raw = Array.isArray(req.body?.patterns) ? req.body.patterns.map((p) => String(p)) : []
    const patterns = [...new Set(raw)]
    if (patterns.length === 0) return res.status(400).json({ error: '需要指定清理 patterns 白名单' })
    const bad = patterns.filter((p) => !CLEANUP_PATTERNS.includes(p))
    if (bad.length) {
      return res.status(400).json({ error: `未知清理模式: ${bad.join(', ')}(白名单: ${CLEANUP_PATTERNS.join(' / ')})` })
    }
    const maxAgeDays = Number.isFinite(Number(req.body?.maxAgeDays)) ? Math.max(0, Math.trunc(Number(req.body.maxAgeDays))) : 30
    const dryRun = req.body?.dryRun !== false // 默认只预览
    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : ''
    if (!dryRun && confirm !== 'CLEAN') {
      return res.status(400).json({ error: '实际清理需要二次确认(confirm 必须精确等于 "CLEAN")' })
    }
    const pre = preflightHostJob(req, res)
    if (!pre.ok) return
    const params = { patterns, maxAgeDays, dryRun }
    if (!dryRun) params.confirm = confirm

    const job = createJob({
      kind: 'host_cleanup', serverId: pre.groupId, groupId: pre.groupId, params,
      createdBy: req.user?.steamId ?? null, origin: 'panel',
    })
    try {
      const r = await bridge.jobStart(pre.groupId, 'host_cleanup', params, {
        confirm: dryRun ? '' : confirm, jobId: job.id,
      })
      updateJob(job.id, { status: r.status || 'running', progress: 0, step: r.step, stepIndex: r.stepIndex, stepTotal: r.stepTotal })
      watchStubJob(req.app.get('io'), pre.groupId, job.id)
      res.status(202).json({ ok: true, job: getJob(job.id), dryRun })
    } catch (e) {
      updateJob(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() })
      res.status(502).json({ error: `下发失败: ${e.message}`, job: getJob(job.id) })
    }
  })

  // 维护模式手动开/关
  router.post('/maintenance', admin, (req, res) => {
    const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId : null
    if (!groupId) return res.status(400).json({ error: '缺少 groupId' })
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔值' })
    if (!listGameServers().some((g) => g.id === groupId)) return res.status(404).json({ error: '服务器组不存在' })
    const reason = req.body.enabled ? String(req.body?.reason || '管理员手动维护') : null
    const m = setMaintenance(groupId, { enabled: req.body.enabled, reason, jobId: null, by: req.user?.steamId ?? null })
    res.json({ ok: true, maintenance: m, all: listMaintenance() })
  })

  // 缓存清理(排障;不触发桥调用)
  router.post('/status/cache/clear', admin, (req, res) => {
    clearHostStatusCache()
    res.json({ ok: true })
  })

  // 任意登录:轻量组状态(供房间页/服务器页显示"该组是否可用",不暴露主机细节)
  router.get('/groups', auth, (req, res) => {
    const connected = agentConnectedMap()
    res.json(
      listGameServers().map((g) => ({
        id: g.id,
        name: g.name,
        region: g.region,
        isActive: !!g.is_active,
        connected: !!connected[g.id],
      })),
    )
  })

  return router
}
