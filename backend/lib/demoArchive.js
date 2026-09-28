// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 录像定期归档:把实例里 MatchZy/*.dem 定时搬到主机 demo_dir(桥 job kind `demo_collect`,只搬不删)。
//
// 为什么放平台侧(而不是主机 cron):面板能看到任务与结果、时刻可在线改、与"开赛必重启实例"的平台节奏一致;
// 桥侧零改动(复用 M4 已有 job 通道;手动入口 = 面板主机概况卡的「归集录像」/ `cs demo collect`)。
//
// 安全边界(与 game-update 同款判定):
//   · 组内有进行中任务 → 跳过(同组 job 互斥,桥侧也会拒);
//   · 组内任一实例非 idle(in_match/booting/cooling)→ 跳过 —— **正在录的 .dem 不能被搬走**;
//   · 桥未连/旧桥(无 jobs 能力)→ 跳过;
//   · 一天只自动跑一次(demo_archive.lastRun = 'YYYY-MM-DD');到点后若被跳过,下一次巡检继续试。
// 开关与时刻见 lib/settings.js 的 getDemoArchive/setDemoArchive;`DEMO_ARCHIVE=off` 整体停用调度器。
import config from '../config.js'
import { getDb } from '../db.js'
import { listGameServers, serverInstanceNames } from './gameServers.js'
import { agentConnected, hasCapability } from './agentChannel.js'
import { createJob, getJob, updateJob, activeJobOfGroup } from './jobs.js'
import { getDemoArchive, markDemoArchiveRun } from './settings.js'
import { watchStubJob } from '../routes/host.js'
import * as bridge from './bridge.js'

const TICK_MS = Number(process.env.DEMO_ARCHIVE_TICK_MS || 60_000)

/** 本地日键('YYYY-MM-DD') */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 该不该现在跑(纯函数,便于单测/巡检复用):到点(hour 之后)+ 今天还没跑过。 */
export function shouldRunDemoArchive({ now, cfg }) {
  if (!cfg.enabled) return false
  if (now.getHours() < cfg.hour) return false
  return cfg.lastRun !== dayKey(now)
}

/** 组是否空闲到可以归档:无进行中任务 + 所有实例锁态 idle(正在录的 .dem 不能搬)。 */
export function groupIdleForArchive(groupId) {
  if (activeJobOfGroup(groupId)) return { ok: false, reason: '该组已有进行中任务' }
  const names = serverInstanceNames(groupId)
  if (names.length === 0) return { ok: false, reason: '该组没有实例' }
  const rows = getDb()
    .prepare(`SELECT name, state FROM instances WHERE name IN (${names.map(() => '?').join(',')})`)
    .all(...names)
  const busy = rows.filter((r) => r.state && r.state !== 'idle')
  if (busy.length > 0) return { ok: false, reason: `实例非 idle: ${busy.map((b) => `${b.name}=${b.state}`).join(', ')}` }
  return { ok: true }
}

/**
 * 在所有"可归档"的组上各起一个 demo_collect 任务(全量、真搬)。返回逐组结果。
 * 调度器与「立即执行」端点共用;调用方负责决定是否需要(调度器 = shouldRunDemoArchive)。
 */
export async function runDemoArchiveAll(io, { trigger = 'schedule' } = {}) {
  const results = []
  for (const g of listGameServers()) {
    if (!g.is_active) {
      results.push({ groupId: g.id, started: false, reason: '组未激活' })
      continue
    }
    const idle = groupIdleForArchive(g.id)
    if (!idle.ok) {
      results.push({ groupId: g.id, started: false, reason: idle.reason })
      continue
    }
    if (config.bridge.mode !== 'stub') {
      if (!agentConnected(g.id)) {
        results.push({ groupId: g.id, started: false, reason: '桥未连接' })
        continue
      }
      if (!hasCapability(g.id, 'jobs')) {
        results.push({ groupId: g.id, started: false, reason: '桥未声明 jobs 能力(旧桥)' })
        continue
      }
    }
    const params = { all: true, matchId: '', dryRun: false }
    const job = createJob({
      kind: 'demo_collect', serverId: g.id, groupId: g.id, params, createdBy: null, origin: trigger,
    })
    try {
      const r = await bridge.jobStart(g.id, 'demo_collect', params, { jobId: job.id })
      updateJob(job.id, { status: r.status || 'running', progress: 0, step: r.step, stepIndex: r.stepIndex, stepTotal: r.stepTotal })
      watchStubJob(io, g.id, job.id)
      console.log(`[demo-archive] ${trigger}: 组 ${g.id} 已下发归集任务(job ${job.id})`)
      results.push({ groupId: g.id, started: true, job: getJob(job.id) })
    } catch (e) {
      updateJob(job.id, { status: 'failed', error: e.message, finishedAt: Date.now() })
      console.log(`[demo-archive] ${trigger}: 组 ${g.id} 下发失败: ${e.message}`)
      results.push({ groupId: g.id, started: false, reason: `下发失败: ${e.message}` })
    }
  }
  return results
}

/**
 * 启动调度器:每 TICK_MS 巡检一次。到点且"今天没跑过"时对可归档的组下发任务;
 * 只要有任一组成功下发就记当天已跑(其余组今天不再补 —— 面板可手动「立即归档」)。
 */
export function startDemoArchiveScheduler(io) {
  if ((process.env.DEMO_ARCHIVE || '').toLowerCase() === 'off') {
    console.log('[demo-archive] 调度器已停用(DEMO_ARCHIVE=off)')
    return null
  }
  const timer = setInterval(async () => {
    let cfg
    try {
      cfg = getDemoArchive()
    } catch {
      return // DB 不可用等:下个巡检再试
    }
    const now = new Date()
    if (!shouldRunDemoArchive({ now, cfg })) return
    const results = await runDemoArchiveAll(io, { trigger: 'schedule' })
    if (results.some((r) => r.started)) {
      markDemoArchiveRun(dayKey(now))
      console.log(`[demo-archive] 今日归档已触发(${results.filter((r) => r.started).length} 组);其余: ${results.filter((r) => !r.started).map((r) => `${r.groupId}=${r.reason}`).join(', ') || '无'}`)
    } else {
      console.log(`[demo-archive] 到点但未执行: ${results.map((r) => `${r.groupId}=${r.reason}`).join(', ')}`)
    }
  }, TICK_MS)
  timer.unref?.()
  console.log(`[demo-archive] 调度器已启动(巡检 ${TICK_MS}ms;配置见 GET /api/settings/demo-archive)`)
  return timer
}
