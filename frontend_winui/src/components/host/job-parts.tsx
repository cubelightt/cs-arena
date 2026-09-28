// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Pause, Play, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Progress, Ring } from '@/components/winui/progress'
import { humanBytes } from '@/lib/format'
import { JOB_KIND_LABELS, JOB_STATUS_META, isJobActive, type Job } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * 任务（job）的共用渲染件：任务条 / 日志视图 / 状态徽章。
 * 「更新任务」Tab 与主机概况卡片的组任务条共用，字段定义见 src/lib/types.ts。
 */

export const jobKindLabel = (kind: string) => JOB_KIND_LABELS[kind] ?? kind

export function JobStatusBadge({ job, className }: { job: Job; className?: string }) {
  const meta = JOB_STATUS_META[job.status] ?? { label: job.status, variant: 'secondary' as const }
  return (
    <Badge variant={meta.variant} className={className}>
      {meta.label}
    </Badge>
  )
}

/** 发起者：面板发起显示 steamId；主机侧 cs 命令发起标「主机侧发起」 */
export function JobOriginCell({ job }: { job: Job }) {
  if (job.origin === 'cli') {
    return (
      <span className="flex items-center gap-1.5">
        <Badge variant="info">主机侧发起</Badge>
        {job.createdBy && <span className="font-mono text-muted-foreground">{job.createdBy}</span>}
      </span>
    )
  }
  return <span className="font-mono text-muted-foreground">{job.createdBy ?? '面板'}</span>
}

/**
 * 任务条：步骤名 + stepIndex/stepTotal + 进度条。
 * `cancelling` 用「正在取消（等待当前步骤结束）」文案（steamcmd 可能几十分钟）。
 */
export function JobProgress({ job, className, clamp = false }: { job: Job; className?: string; clamp?: boolean }) {
  const pct = Math.min(100, Math.max(0, job.progress ?? 0))
  const cancelling = job.status === 'cancelling'
  const failed = job.status === 'failed'
  const stepText = job.step || (job.status === 'queued' ? '排队中（等待主机侧受理）' : '—')
  const fullText = cancelling ? `正在取消（等待当前步骤结束）· ${stepText}` : stepText
  // 终态时主机侧可能把 stepIndex 记成 total+1（收尾步）——展示侧夹取，避免出现「8/7」
  const stepIndex = job.stepTotal ? Math.min(job.stepIndex ?? 0, job.stepTotal) : (job.stepIndex ?? 0)
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span
          className={cn('win-caption min-w-0 text-foreground', clamp ? 'truncate' : 'break-all')}
          title={clamp ? fullText : undefined}
        >
          {fullText}
        </span>
        <span className="win-caption shrink-0 font-mono text-muted-foreground">
          {job.stepTotal ? `${stepIndex}/${job.stepTotal} · ` : ''}
          {pct}%
        </span>
      </div>
      <Progress
        value={pct}
        className={failed ? 'win-progress-critical' : cancelling ? 'win-progress-caution' : undefined}
      />
    </div>
  )
}

/** 失败 / 强制取消的半更新警示：红色一行（任务条下方或列表内）；
 *  `clamp` = 列表/卡片用单行省略（完整原因在详情里看，完整文本放在 title 悬浮提示） */
export function JobErrorLine({ job, className, clamp = false }: { job: Job; className?: string; clamp?: boolean }) {
  if (!job.error) return null
  return (
    <p
      className={cn('win-caption flex gap-1.5 text-[var(--critical)]', clamp ? 'items-center' : 'items-start', className)}
      title={clamp ? job.error : undefined}
    >
      <TriangleAlert className={cn('size-3.5 shrink-0', !clamp && 'mt-px')} />
      <span className={cn('min-w-0', clamp ? 'truncate' : 'break-all')}>{job.error}</span>
    </p>
  )
}

/**
 * 终态 `result` 的**一行摘要**（列表行 / 卡片任务条用）：`clamp` 时超长省略（完整值在 title 与详情里）。
 * 未知 kind 回退为紧凑 JSON —— 列表里会被省略号截断，详情（JobResultBlock）给完整内容。
 */
export function JobResultLine({ job, className, clamp = false }: { job: Job; className?: string; clamp?: boolean }) {
  const summary = jobResultSummary(job)
  if (!summary) return null
  return (
    <p className={cn('win-caption text-muted-foreground', clamp ? 'truncate' : 'break-all', className)} title={summary}>
      <span className="text-foreground">结果：</span>
      {summary}
    </p>
  )
}

/**
 * 终态 `result` 的**完整内容**（任务详情用）：已知 kind 先给一行摘要，再按需附完整 JSON
 * （紧凑结果只留摘要；结构化/长结果给可滚动的 `pre`，不撑破页面也不丢数据）。
 */
export function JobResultBlock({ job, className }: { job: Job; className?: string }) {
  const summary = jobResultSummary(job)
  const pretty = jobResultPretty(job)
  if (!summary && !pretty) return null
  // 摘要已经很完整（建删实例/更新的口径）：不必再铺一层 JSON
  const showJson = !!pretty && (!summary || pretty.length > 160)
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <p className="win-meta">结果</p>
      {summary && (
        <p className="win-caption break-all">
          <span className="text-muted-foreground">摘要：</span>
          {summary}
        </p>
      )}
      {showJson && (
        <pre className="max-h-64 overflow-auto rounded-lg border border-[var(--card-stroke)] bg-[var(--subtle-tertiary)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">
          {pretty}
        </pre>
      )}
    </div>
  )
}

/** result 取成对象（非对象/数组/null 一律 null） */
function resultObject(job: Job): Record<string, unknown> | null {
  const r = job.result
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  return r as Record<string, unknown>
}

/** 已知 kind 的中文一行摘要；未知 kind 回退为紧凑 JSON。无 result / 空对象返回 null */
function jobResultSummary(job: Job): string | null {
  const o = resultObject(job)
  if (!o) return null
  const dry = o.dryRun === true ? '（dry-run，未实际执行）' : ''
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  if (job.kind === 'instance_create') {
    const bits = [
      typeof o.name === 'string' ? `实例 ${o.name}` : null,
      num(o.idx) > 0 ? `编号 #${o.idx}` : null,
      num(o.port) > 0 ? `端口 ${o.port}` : null,
      num(o.gotvPort) > 0 ? `GOTV ${o.gotvPort}` : null,
    ].filter(Boolean)
    return bits.length ? bits.join(' · ') : null
  }
  if (job.kind === 'instance_delete') {
    const removed = Array.isArray(o.removed) ? o.removed.length : 0
    const bits = [
      typeof o.name === 'string' ? `实例 ${o.name}` : null,
      num(o.freedBytes) > 0 ? `释放 ${humanBytes(num(o.freedBytes))}` : null,
      removed ? `删除 ${removed} 个目录（不可恢复）` : null,
    ].filter(Boolean)
    return bits.length ? bits.join(' · ') : null
  }
  if (job.kind === 'game_update') {
    const bits = [typeof o.build === 'string' ? `已装构建 ${o.build}` : null].filter(Boolean)
    return bits.length ? bits.join(' · ') + dry : null
  }
  // M6 的三种主机侧任务：结果里都有一大串明细（items/targets/entries），列表只给合计
  if (job.kind === 'host_cleanup') {
    const items = Array.isArray(o.items) ? o.items.length : 0
    return `${dry ? '待清理' : '清理'} ${items} 项 · 合计 ${humanBytes(num(o.totalBytes))}${dry}`
  }
  if (job.kind === 'plugin_sync') {
    const targets = Array.isArray(o.targets) ? o.targets.length : 0
    const files = num(o.files)
    return `${dry ? '待同步' : '同步'} ${targets} 个目标 · ${files} 个文件 · ${humanBytes(num(o.bytes))}${dry}`
  }
  if (job.kind === 'plugin_deploy') {
    const targets = Array.isArray(o.targets) ? o.targets.length : 0
    return [
      typeof o.name === 'string' ? `部署 ${o.name}` : '部署插件',
      `${num(o.files)} 个文件`,
      targets ? `${targets} 个目标` : null,
      typeof o.backupDir === 'string' ? `备份到 ${o.backupDir}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (job.kind === 'demo_collect') {
    const bits = [
      `${dry ? '待归集' : '归集'} ${num(o.moved)} 个录像`,
      num(o.skipped) > 0 ? `跳过 ${num(o.skipped)}` : null,
      num(o.freedFromInstanceBytes) > 0 ? `释放 ${humanBytes(num(o.freedFromInstanceBytes))}` : null,
    ].filter(Boolean)
    return bits.join(' · ') + dry
  }
  const json = JSON.stringify(o)
  return json && json !== '{}' ? json : null
}

/** 详情用的完整 result（缩进 JSON）；无 result / 空对象返回 null */
function jobResultPretty(job: Job): string | null {
  const o = resultObject(job)
  if (!o) return null
  try {
    const json = JSON.stringify(o, null, 2)
    return json && json !== '{}' ? json : null
  } catch {
    return null
  }
}

/**
 * 任务日志：等宽字体（样式口径与实例控制台一致）+ 自动滚底（用户上滚暂停）+ 手动暂停。
 * 行来自 socket 的 `job:output`；重连后由调用方按 offset/尾段补齐（见 JobsSection）。
 */
export function JobLogView({
  lines,
  loading,
  className,
}: {
  lines: string[]
  loading?: boolean
  className?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const [paused, setPaused] = useState(false)

  // 暂停期间不自动滚底（但仍累积行），恢复时立刻到底
  useEffect(() => {
    if (paused || !autoScrollRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, paused])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const resume = () => {
    setPaused(false)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="win-meta">任务日志</p>
        <div className="flex items-center gap-2">
          {paused && <span className="win-caption text-[var(--caution)]">已暂停（仍在接收）</span>}
          {paused ? (
            <Button variant="outline" size="sm" onClick={resume}>
              <Play className="size-3.5" />
              继续
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPaused(true)}
              disabled={lines.length === 0}
            >
              <Pause className="size-3.5" />
              暂停
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const el = scrollRef.current
              if (el) el.scrollTop = el.scrollHeight
              autoScrollRef.current = true
            }}
            title="滚到底部"
          >
            <ArrowDownToLine className="size-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-72 overflow-y-auto rounded-lg border border-[var(--card-stroke)] bg-[#0a0a0a] p-3 font-mono text-xs leading-relaxed text-[#6ccb5f]"
      >
        {loading && lines.length === 0 ? (
          <div className="flex items-center gap-2 text-[#9d9d9d]">
            <Ring size={14} />
            正在读取任务日志…
          </div>
        ) : lines.length === 0 ? (
          <p className="text-[#9d9d9d]">暂无日志输出</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line || '\u00A0'}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** 组卡片内的紧凑任务条（主机概况用）：一行进度 + 终态提示 */
export function JobInlineBar({ job }: { job: Job }) {
  const meta = JOB_STATUS_META[job.status] ?? { label: job.status, variant: 'secondary' as const }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--card-stroke)] bg-[var(--subtle-tertiary)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="win-caption flex items-center gap-2">
          <span className="win-body-strong">任务 #{job.id}</span>
          <span className="text-muted-foreground">{jobKindLabel(job.kind)}</span>
          {isJobActive(job.status) && <Ring size={12} />}
        </span>
        <Badge variant={meta.variant}>{meta.label}</Badge>
      </div>
      <JobProgress job={job} clamp />
      <JobErrorLine job={job} clamp />
      <JobResultLine job={job} clamp />
    </div>
  )
}
