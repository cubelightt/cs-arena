// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 实例管理(状态查看 + 桥命令透传 + 锁复位 + 分级 + M5 建/删实例)
// 写操作(启停/重置/分级/建删)仅管理员;状态查看:普通用户仅可见普通实例,管理员可见全部
import { Router } from 'express'
import { getDb, now } from '../db.js'
import { requireAuth, requireAdmin, isAdmin } from '../lib/auth.js'
import {
  listInstances, resetAllInstances, resetInstance, setInstanceAdminOnly, cacheInstances, instanceRow, provisioningMessage,
} from '../lib/instances.js'
import { maintenanceMessage, createJob, getJob, updateJob, activeJobOfGroup } from '../lib/jobs.js'
import { confirmInstance, nextIdxFor, PROVISION, notifyInstancesChanged } from '../lib/provisioning.js'
import { agentConnected, hasCapability } from '../lib/agentChannel.js'
import { getGameServer } from '../lib/gameServers.js'
import { watchStubJob } from './host.js'
import config from '../config.js'
import * as bridge from '../lib/bridge.js'

export function createInstancesRouter() {
  const router = Router()
  const auth = requireAuth()
  const admin = requireAdmin()

  router.get('/', auth, async (req, res) => {
    const adm = isAdmin(req.user.steam_id)
    const states = await Promise.all(
      listInstances()
        .filter((i) => adm || !i.adminOnly)
        .map(async (inst) => {
          let health = 'unknown'
          try {
            health = await bridge.instanceStatus(inst.name)
          } catch {
            health = 'unreachable'
          }
          return { ...inst, health }
        }),
    )
    res.json(states)
  })

  /**
   * 新建实例。
   * 流程:校验 → 落行(provision_state='creating',预留编号)→ 建任务(instance_create)→ 调桥 job_start;
   * 桥侧任务完成由 push/job_report 的**终态帧**(带 result) 收敛:回读 port/idx 并清供给态。
   */
  router.post('/', admin, async (req, res) => {
    const b = req.body || {}
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!/^[\w.-]{1,32}$/.test(name)) {
      return res.status(400).json({ error: '实例名非法(1~32 位字母/数字/下划线/点/连字符)' })
    }
    const groupId = typeof b.gameServerId === 'string' ? b.gameServerId.trim() : (typeof b.groupId === 'string' ? b.groupId.trim() : '')
    if (!groupId) return res.status(400).json({ error: '缺少 gameServerId(所属服务器组)' })
    const group = getGameServer(groupId)
    if (!group) return res.status(404).json({ error: '服务器组不存在' })
    if (!group.is_active) return res.status(409).json({ error: '服务器组未激活' })
    // 端口:缺省/空串 = 由 msm 自动分配;给了就必须合法且组内不冲突(提前报错,免得桥侧跑到一半才失败)
    let port = null
    if (b.port !== undefined && b.port !== null && b.port !== '') {
      const p = Number(b.port)
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return res.status(400).json({ error: '端口非法(1~65535 的整数;留空 = 由主机自动分配)' })
      }
      port = p
    }
    // 模板实例(msm clone 的来源):必须在本组内、可克隆状态;错名字在这里就 404,不等桥侧前置检查
    const cloneFrom = typeof b.cloneFrom === 'string' && b.cloneFrom.trim() ? b.cloneFrom.trim() : null
    if (cloneFrom) {
      if (cloneFrom === name) return res.status(400).json({ error: '模板实例不能是新实例自身' })
      const src = instanceRow(cloneFrom)
      if (!src || src.game_server_id !== groupId) {
        return res.status(404).json({ error: `模板实例 ${cloneFrom} 不在该服务器组内` })
      }
      if (src.provision_state) {
        return res.status(409).json({ error: `模板实例 ${cloneFrom} 正在创建/删除中或上次失败,暂不可作为模板` })
      }
    }
    const existing = instanceRow(name)
    if (existing && existing.provision_state !== PROVISION.failed) {
      return res.status(409).json({ error: `实例名 ${name} 已存在` })
    }
    if (port) {
      const clash = getDb()
        .prepare('SELECT name FROM instances WHERE port = ? AND game_server_id = ? AND name != ? LIMIT 1')
        .get(port, groupId, name)
      if (clash) return res.status(409).json({ error: `端口 ${port} 已被实例 ${clash.name} 占用` })
    }
    const active = activeJobOfGroup(groupId)
    if (active) return res.status(409).json({ error: `该服务器组已有进行中任务(job ${active.id})` })
    // stub 模式没有真实 agent:任务由进程内假 job 承担(联调用),不做连接/能力门禁
    if (config.bridge.mode !== 'stub') {
      if (!agentConnected(groupId)) return res.status(502).json({ error: '主机桥未连接,无法下发建实例任务' })
      if (!hasCapability(groupId, 'jobs')) {
        return res.status(502).json({ error: '主机 agent 未声明 jobs 能力(旧桥);请升级到 v2 桥(agent/v2)' })
      }
    }
    const ts = now()
    if (existing) {
      // 上次失败的预留行:复用(支持面板「重试」)
      getDb()
        .prepare("UPDATE instances SET provision_state = ?, provision_error = NULL, port = COALESCE(?, port), updated_at = ? WHERE name = ?")
        .run(PROVISION.creating, port ?? 0, ts, name)
    } else {
      getDb()
        .prepare(
          `INSERT INTO instances (name, port, state, game_server_id, admin_only, idx, provision_state, source, created_at, updated_at)
           VALUES (?, ?, 'idle', ?, 0, ?, ?, 'panel', ?, ?)`,
        )
        .run(name, port || 0, groupId, nextIdxFor(groupId), PROVISION.creating, ts, ts)
    }
    cacheInstances()
    notifyInstancesChanged({ serverId: groupId, ...(existing ? { updated: [name] } : { added: [name] }), reason: 'panel_create' })
    const params = { name, ...(cloneFrom ? { cloneFrom } : {}), ...(port ? { port } : {}) }
    const job = createJob({
      kind: 'instance_create', serverId: groupId, groupId, instanceName: name, params,
      createdBy: req.user?.steam_id ?? null, origin: 'panel',
    })
    try {
      const r = await bridge.jobStart(groupId, 'instance_create', params, { jobId: job.id })
      updateJob(job.id, { status: r.status || 'running', progress: 0, step: r.step, stepIndex: r.stepIndex, stepTotal: r.stepTotal })
      watchStubJob(req.app.get('io'), groupId, job.id)
      res.status(201).json({ ok: true, instance: listInstances().find((i) => i.name === name) ?? null, task: getJob(job.id) })
    } catch (e) {
      // 下发失败:桥侧什么都没做 —— 失败的预留行标记 failed(可重试),新预留行撤回
      updateJob(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() })
      if (existing) {
        getDb().prepare('UPDATE instances SET provision_state = ?, provision_error = ?, updated_at = ? WHERE name = ?')
          .run(PROVISION.failed, e.message, now(), name)
      } else {
        getDb().prepare("DELETE FROM instances WHERE name = ? AND provision_state = ?").run(name, PROVISION.creating)
      }
      cacheInstances()
      notifyInstancesChanged({ serverId: groupId, ...(existing ? { updated: [name] } : { removed: [name] }), reason: 'panel_create_failed' })
      res.status(502).json({ error: `下发失败: ${e.message}`, task: getJob(job.id) })
    }
  })

  /**
   * 删除实例。
   * 守卫:使用中(state≠idle)/ 有进行中比赛 / 组内有任务 / 桥不可达;桥任务成功才删行。
   */
  router.delete('/:name', admin, async (req, res) => {
    const { name } = req.params
    const confirm = req.body?.confirm
    if (confirm !== name) {
      return res.status(400).json({ error: `删除实例需要二次确认(body.confirm 必须精确等于实例名 ${name})` })
    }
    const row = instanceRow(name)
    if (!row) return res.status(404).json({ error: '实例不存在' })
    if (row.provision_state === PROVISION.creating) {
      return res.status(409).json({ error: '该实例正在创建中,请等任务结束或取消后再删' })
    }
    if (row.state && row.state !== 'idle') {
      return res.status(409).json({ error: `实例 ${name} 使用中(${row.state}),请先停止或等冷却结束` })
    }
    const live = getDb()
      .prepare("SELECT id FROM matches WHERE instance_name = ? AND status NOT IN ('ended','aborted') LIMIT 1")
      .get(name)
    if (live) return res.status(409).json({ error: `实例 ${name} 有进行中的比赛(match ${live.id})` })
    const groupId = row.game_server_id
    const active = activeJobOfGroup(groupId)
    if (active) return res.status(409).json({ error: `该服务器组已有进行中任务(job ${active.id})` })
    if (config.bridge.mode !== 'stub') {
      if (!agentConnected(groupId)) return res.status(502).json({ error: '主机桥未连接,无法下发删除任务' })
      if (!hasCapability(groupId, 'jobs')) {
        return res.status(502).json({ error: '主机 agent 未声明 jobs 能力(旧桥);请升级到 v2 桥(agent/v2)' })
      }
    }
    getDb().prepare('UPDATE instances SET provision_state = ?, updated_at = ? WHERE name = ?').run(PROVISION.deleting, now(), name)
    cacheInstances()
    notifyInstancesChanged({ serverId: groupId, updated: [name], reason: 'panel_delete' })
    const params = { name, confirm: name }
    const job = createJob({
      kind: 'instance_delete', serverId: groupId, groupId, instanceName: name, params,
      createdBy: req.user?.steam_id ?? null, origin: 'panel',
    })
    try {
      const r = await bridge.jobStart(groupId, 'instance_delete', params, { confirm: name, jobId: job.id })
      updateJob(job.id, { status: r.status || 'running', progress: 0, step: r.step, stepIndex: r.stepIndex, stepTotal: r.stepTotal })
      watchStubJob(req.app.get('io'), groupId, job.id)
      res.json({ ok: true, task: getJob(job.id) })
    } catch (e) {
      // 下发失败 = 桥没动手:撤回供给态(行保持可用),任务置 failed
      updateJob(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() })
      getDb().prepare('UPDATE instances SET provision_state = NULL, provision_error = ?, updated_at = ? WHERE name = ?')
        .run(e.message, now(), name)
      cacheInstances()
      notifyInstancesChanged({ serverId: groupId, updated: [name], reason: 'panel_delete_failed' })
      res.status(502).json({ error: `下发失败: ${e.message}`, task: getJob(job.id) })
    }
  })

  // 实例分级(仅管理员):普通(0)可被自动分配;仅管理员(1)只可管理员选择
  // 编辑实例(仅管理员):端口 / 仅管理员可选(2026-09-23 面板「编辑」弹窗;
  // 端口校验 = 1~65535 且不得与其他实例的端口或 GOTV 端口(= 端口+100)冲突 —— 同一主机共享端口空间)
  router.put('/:name', admin, (req, res) => {
    const { name } = req.params
    const row = instanceRow(name)
    if (!row) return res.status(404).json({ error: '实例不存在' })
    const patch = {}
    if (req.body?.port !== undefined) {
      const port = Number(req.body.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: '端口需为 1~65535 的整数' })
      }
      const clash = listInstances().find(
        (i) => i.name !== name && i.port && (i.port === port || i.port + 100 === port || i.port === port + 100),
      )
      if (clash) {
        return res.status(409).json({ error: `端口 ${port} 与实例 ${clash.name}(游戏 ${clash.port} / GOTV ${clash.port + 100})冲突` })
      }
      patch.port = port
    }
    if (req.body?.adminOnly !== undefined) patch.admin_only = req.body.adminOnly === true ? 1 : 0
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: '没有需要修改的字段(port / adminOnly)' })
    if (patch.port !== undefined) {
      // 供给中(创建/删除/待确认)不允许改端口:桥侧任务回读会把端口写回,改了会被覆盖
      if (row.provision_state) return res.status(409).json({ error: provisioningMessage(row) })
      getDb().prepare('UPDATE instances SET port = ?, updated_at = ? WHERE name = ?').run(patch.port, now(), name)
    }
    if (patch.admin_only !== undefined) setInstanceAdminOnly(name, patch.admin_only === 1)
    cacheInstances()
    notifyInstancesChanged({ serverId: row.game_server_id, updated: [name], reason: 'edit' })
    res.json({ ok: true, instance: listInstances().find((i) => i.name === name) })
  })

  // 一键启停全部(仅管理员,2026-09-23 用户需求):自动跳过「已在目标状态」的实例;
  // 供给中(创建/删除/待确认)与所在组维护中的实例也跳过,并逐条给出原因(skipped)
  const bulkOp = (op) => async (req, res) => {
    const want = op === 'start' ? 'RUNNING' : 'STOPPED'
    const acted = []
    const skipped = []
    const failed = []
    for (const inst of listInstances()) {
      let health = 'unknown'
      try {
        health = await bridge.instanceStatus(inst.name)
      } catch {
        health = 'unreachable'
      }
      if (health === want) {
        skipped.push({ name: inst.name, reason: want === 'RUNNING' ? '已在运行' : '已停止' })
        continue
      }
      if (health === 'BOOTING' && op === 'start') {
        skipped.push({ name: inst.name, reason: '启动中' })
        continue
      }
      if (inst.provisionState) {
        skipped.push({ name: inst.name, reason: '供给中(创建/删除/待确认)' })
        continue
      }
      const maint = maintenanceMessage(inst.gameServerId)
      if (maint) {
        skipped.push({ name: inst.name, reason: maint })
        continue
      }
      try {
        await bridge.rawCommandPublic(inst.name, op)
        acted.push(inst.name)
      } catch (e) {
        failed.push({ name: inst.name, error: e.message })
      }
    }
    res.json({ ok: failed.length === 0, action: op, acted, skipped, failed })
  }
  router.post('/start-all', admin, bulkOp('start'))
  router.post('/stop-all', admin, bulkOp('stop'))

  // 单个实例锁复位(仅管理员,强停/异常后清理;须在 /:name/:op 之前注册)
  router.post('/:name/reset', admin, (req, res) => {
    const { name } = req.params
    const exists = listInstances().some((i) => i.name === name)
    if (!exists) return res.status(404).json({ error: '实例不存在' })
    resetInstance(name)
    res.json({ ok: true, instance: { name, state: 'idle' } })
  })

  // 确认主机侧创建的实例(「待确认」→ 可分配;仅管理员)
  router.post('/:name/confirm', admin, (req, res) => {
    const { name } = req.params
    const row = instanceRow(name)
    if (!row) return res.status(404).json({ error: '实例不存在' })
    if (row.provision_state !== PROVISION.unconfirmed) return res.status(409).json({ error: '该实例无需确认' })
    const next = confirmInstance(name)
    res.json({ ok: true, instance: listInstances().find((i) => i.name === name) ?? next })
  })

  // 启/停/重启(仅管理员;系统不自动唤醒,管理员手动启动)
  router.post('/:name/:op', admin, async (req, res) => {
    const { name, op } = req.params
    if (!['start', 'stop', 'restart'].includes(op)) return res.status(400).json({ error: 'invalid op' })
    // 供给守卫:正在创建/删除/待确认的实例不可启停
    {
      const row = instanceRow(name)
      if (row?.provision_state) return res.status(409).json({ error: provisioningMessage(row) })
    }
    // 维护守卫(决策 8):该组维护中 → 组内**全部实例**的启停/重启一律拒绝(更新任务自身走 job 框架,不经此接口)
    {
      const row = getDb().prepare('SELECT game_server_id FROM instances WHERE name = ?').get(name)
      const maint = row ? maintenanceMessage(row.game_server_id) : null
      if (maint) return res.status(409).json({ error: maint })
    }
    try {
      await bridge.rawCommandPublic(name, op)
      res.json({ ok: true })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // 全局锁复位(仅管理员)
  router.post('/reset', admin, (req, res) => {
    resetAllInstances()
    res.json({ ok: true, instances: listInstances() })
  })

  return router
}
