// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, Film, RefreshCw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { InfoBar } from '@/components/winui/info-bar'
import { Progress, Ring } from '@/components/winui/progress'
import { GameUpdateDialog } from '@/components/host/game-update-dialog'
import { DemoCollectDialog } from '@/components/host/demo-collect-dialog'
import { HostCleanupDialog } from '@/components/host/host-cleanup-dialog'
import { JobInlineBar } from '@/components/host/job-parts'
import { ApiError, api, onJobDone, subscribeAdmins } from '@/lib/api'
import { formatClock, formatDateTime, formatPct, formatUptime, humanBytes } from '@/lib/format'
import {
  CAPABILITY_LABELS,
  INSTANCES_SOURCE_LABELS,
  RESIDUAL_LABELS,
  RESIDUAL_ORDER,
  type HostStatus,
  type HostStatusDisk,
  type HostStatusGame,
  type HostStatusInstance,
  type HostStatusMemory,
  type HostStatusResidual,
  type HostStatusResidualEntry,
  type HostStatusResponse,
  type Job,
  type JobsCurrentResponse,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useArena } from '@/stores/arena'

/**
 * 管理面板「主机概况」Tab（仅管理员）：GET /api/host/status。
 * 一屏看每台游戏主机：磁盘余量（含 warn 阈值）、CS2 版本（与官方最新对比）、四个实例的
 * 端口/运行态、磁盘残留占用、维护态。全部只读——清理/更新/建删实例是后续里程碑。
 * 旧桥/无缓存降级只落在本组卡片上，
 * 不弹全局错误、不影响其它 Tab。
 */

/** 自动轮询间隔：不带 refresh，命中服务端 30s 缓存（开销是一次内存读取） */
const AUTO_POLL_MS = 30000

/** 旧桥降级（未声明 host_status 能力）单独给升级指引，不与一般查询失败混同 */
function isLegacyBridge(error: string | null | undefined): boolean {
  return !!error && (error.includes('未声明 host_status') || error.includes('v2 桥'))
}

function isResidualEntry(v: unknown): v is HostStatusResidualEntry {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 区块外壳：与卡片同级但不抢焦点的小标题 + 可选右上角内容（min-w-0 防 nowrap 路径撑破栅格） */
function Block({ title, trailing, children }: { title: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-[var(--card-stroke)] bg-[var(--subtle-tertiary)] p-3.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="win-meta">{title}</p>
        {trailing}
      </div>
      {children}
    </div>
  )
}

/* ---------------- 磁盘 / 内存 ---------------- */

function DiskBlock({ disk, memory }: { disk?: HostStatusDisk; memory?: HostStatusMemory }) {
  if (!disk) {
    return (
      <Block title="磁盘">
        <p className="win-caption text-muted-foreground">主机未上报磁盘信息</p>
      </Block>
    )
  }
  const usedPct = Math.min(100, Math.max(0, disk.usedPct ?? 0))
  return (
    <Block
      title="磁盘"
      trailing={
        disk.warn ? <Badge variant="destructive">空间不足</Badge> : <Badge variant="secondary">空间充足</Badge>
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={cn('win-body-strong font-mono', disk.warn && 'text-[var(--critical)]')}>
          已用 {formatPct(disk.usedPct)}
        </span>
        <span className="win-caption text-muted-foreground">
          剩余{' '}
          <b className={cn('font-mono', disk.warn ? 'text-[var(--critical)]' : 'text-foreground')}>
            {humanBytes(disk.freeBytes)}
          </b>
          {' / 共 '}
          {humanBytes(disk.totalBytes)}
        </span>
      </div>
      <Progress value={usedPct} className={disk.warn ? 'win-progress-critical' : undefined} />
      <p className={cn('win-caption', disk.warn ? 'text-[var(--critical)]' : 'text-muted-foreground')}>
        {disk.warn
          ? `低于更新阈值（${humanBytes(disk.minFreeBytes)}）—— 版本更新前需先清理残留`
          : `更新阈值：剩余不低于 ${humanBytes(disk.minFreeBytes)}`}
      </p>
      {memory && (
        <p className="win-caption text-muted-foreground">
          内存：可用 <span className="font-mono text-foreground">{humanBytes(memory.availableBytes)}</span> / 共{' '}
          {humanBytes(memory.totalBytes)}
        </p>
      )}
    </Block>
  )
}

/* ---------------- CS2 版本 ---------------- */

function GameBlock({ game }: { game?: HostStatusGame }) {
  if (!game) {
    return (
      <Block title="CS2 版本">
        <p className="win-caption text-muted-foreground">主机未上报版本信息</p>
      </Block>
    )
  }
  const installed = game.installed
  const latest = game.latest
  const latestError = latest?.error ?? ''
  const buildsEqual = !!installed?.build && !!latest?.build && installed.build === latest.build

  // 三态：查询失败（灰）→ 有更新（橙）→ 已是最新（绿）
  const status: { label: string; variant: 'success' | 'caution' | 'secondary' } = latestError
    ? { label: '查询失败', variant: 'secondary' }
    : game.updateAvailable
      ? { label: `有更新：${installed?.build ?? '未知'} → ${latest?.build ?? '未知'}`, variant: 'caution' }
      : buildsEqual
        ? { label: '已是最新', variant: 'success' }
        : { label: '无法对比', variant: 'secondary' }

  return (
    <Block title="CS2 版本" trailing={<Badge variant={status.variant}>{status.label}</Badge>}>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="flex flex-col gap-0.5">
          <span className="win-caption text-muted-foreground">本地已装</span>
          <span className="win-body-strong font-mono">{installed?.build ?? '未检测到'}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="win-caption text-muted-foreground">官方最新</span>
          <span className="win-body-strong font-mono">{latest?.build ?? '未知'}</span>
        </div>
      </div>
      {latestError ? (
        // 官方版本查询失败：只提示版本对比不可用，不影响其它区块
        <p className="win-caption text-muted-foreground">官方版本查询失败：{latestError}</p>
      ) : (
        <p className="win-caption text-muted-foreground">
          {latest?.build
            ? `官方版本查询于 ${formatDateTime(latest.queriedAt)}${latest.source ? `（${latest.source}）` : ''}`
            : '尚无官方版本查询结果'}
        </p>
      )}
      <p className="win-caption truncate text-muted-foreground" title={installed?.steamInfPath ?? undefined}>
        清单：<span className="font-mono">{installed?.steamInfPath ?? '—'}</span>
        {installed?.mtime ? `（${formatDateTime(installed.mtime * 1000)}）` : ''}
      </p>
    </Block>
  )
}

/* ---------------- 实例表 ---------------- */

function instanceRunMeta(inst: HostStatusInstance): { label: string; variant: 'success' | 'info' | 'secondary' } {
  if (inst.health === 'RUNNING' || (!inst.health && inst.process?.running)) return { label: 'RUNNING', variant: 'success' }
  if (inst.health && inst.health !== 'STOPPED' && inst.health !== 'UNKNOWN') return { label: inst.health, variant: 'info' }
  return { label: 'STOPPED', variant: 'secondary' }
}

function InstanceTable({ instances, source }: { instances: HostStatusInstance[]; source?: string }) {
  if (instances.length === 0) {
    return (
      <p className="win-caption text-muted-foreground">
        主机未上报实例清单{source === 'none' ? '（instancesSource: none —— 桥未下发实例清单）' : ''}
      </p>
    )
  }
  const th = 'border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap'
  const td = 'border-b border-[var(--divider)] px-2 py-2 align-top'
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse">
        <thead>
          <tr className="win-caption text-left text-muted-foreground">
            <th className={th}>#</th>
            <th className={th}>名称</th>
            <th className={th}>端口 / GOTV</th>
            <th className={th}>运行态</th>
            <th className={th}>运行时长</th>
            <th className={th}>日志</th>
            <th className={th}>addons / demo</th>
          </tr>
        </thead>
        <tbody>
          {instances.map((inst) => {
            const run = instanceRunMeta(inst)
            return (
              <tr key={inst.name} className="win-caption">
                <td className={cn(td, 'font-mono text-muted-foreground')}>{inst.idx}</td>
                <td className={td}>
                  <span className="font-mono font-semibold text-foreground">{inst.name}</span>
                  {inst.platformState && <span className="ml-2 text-muted-foreground">锁：{inst.platformState}</span>}
                  {typeof inst.matchId === 'number' && <span className="ml-2 text-muted-foreground">对局 {inst.matchId}</span>}
                </td>
                <td className={cn(td, 'font-mono whitespace-nowrap')}>
                  {inst.port || '—'} / {inst.gotvPort || '—'}
                </td>
                <td className={td}>
                  <Badge variant={run.variant} className="font-mono">
                    {run.label}
                  </Badge>
                  {inst.process?.pid ? (
                    <span className="ml-2 text-muted-foreground" title={inst.process.tmuxSession ?? undefined}>
                      pid {inst.process.pid}
                    </span>
                  ) : null}
                </td>
                <td className={cn(td, 'whitespace-nowrap')}>{formatUptime(inst.process?.uptimeSec)}</td>
                <td className={cn(td, 'whitespace-nowrap')} title={inst.logPath ?? undefined}>
                  <span className="font-mono">{humanBytes(inst.logBytes)}</span>
                  {inst.logPath && (
                    <span className="ml-2 font-mono text-muted-foreground">{inst.logPath.split('/').pop()}</span>
                  )}
                </td>
                <td className={cn(td, 'whitespace-nowrap')}>
                  <span className="font-mono">{humanBytes(inst.addonsBytes)}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="font-mono">{humanBytes(inst.demBytes)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- 残留占用 ---------------- */

function ResidualBlock({ residual }: { residual?: HostStatusResidual }) {
  const entries: Array<[string, HostStatusResidualEntry]> = []
  for (const key of RESIDUAL_ORDER) {
    const v = residual?.[key]
    if (isResidualEntry(v)) entries.push([key, v])
  }
  for (const key of Object.keys(residual ?? {})) {
    if (key === 'staleInstanceDirs' || RESIDUAL_ORDER.includes(key)) continue
    const v = residual?.[key]
    if (isResidualEntry(v)) entries.push([key, v])
  }
  const stale = (residual?.staleInstanceDirs ?? []).filter(Boolean)
  const totalBytes = entries.reduce((sum, [, e]) => sum + (e.bytes || 0), 0)

  return (
    <Block
      title="磁盘残留（只读）"
      trailing={<Badge variant="secondary">合计 {humanBytes(totalBytes)}</Badge>}
    >
      {entries.length === 0 ? (
        <p className="win-caption text-muted-foreground">无残留占用</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse">
            <thead>
              <tr className="win-caption text-left text-muted-foreground">
                <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">名称</th>
                <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal">路径</th>
                <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">大小</th>
                <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">文件数</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([key, e]) => (
                <tr key={key} className="win-caption">
                  <td className="border-b border-[var(--divider)] px-2 py-2 whitespace-nowrap text-foreground">
                    {RESIDUAL_LABELS[key] ?? key}
                  </td>
                  <td className="border-b border-[var(--divider)] px-2 py-2">
                    <span className="font-mono break-all text-muted-foreground" title={e.path}>
                      {e.path}
                    </span>
                  </td>
                  <td className="border-b border-[var(--divider)] px-2 py-2 font-mono whitespace-nowrap">{humanBytes(e.bytes)}</td>
                  <td className="border-b border-[var(--divider)] px-2 py-2 font-mono whitespace-nowrap">{e.files}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {stale.length > 0 && (
        <p className="win-caption text-[var(--critical)]">已删实例残留目录：{stale.join('、')}</p>
      )}
      <p className="win-caption text-muted-foreground">清理入口在本卡「磁盘清理」按钮（白名单 + 默认先预览；录像不在白名单内）</p>
    </Block>
  )
}

/* ---------------- 组卡片 ---------------- */

function HostGroupCard({
  group,
  ttlMs,
  busy,
  activeJob,
  onRefresh,
  onUpdate,
  onDemoCollect,
  onCleanup,
}: {
  group: HostStatus
  ttlMs: number
  busy: boolean
  /** 该组进行中的更新任务（有则在卡片内显示任务条，并置灰「更新游戏」） */
  activeJob: Job | null
  onRefresh: () => void
  onUpdate: () => void
  onDemoCollect: () => void
  onCleanup: () => void
}) {
  const legacy = isLegacyBridge(group.error)
  const maintenance = (group.maintenance ?? []).find((m) => m.enabled) ?? null
  const capabilities = group.host?.capabilities ?? []
  const instances = group.instances ?? []
  // 维护中 / 该组已有进行中任务 → 不能再触发更新（后端也会 409，这里提前置灰）
  const updateDisabledReason = maintenance
    ? `该组维护中${maintenance.reason ? `：${maintenance.reason}` : ''}`
    : activeJob
      ? `该组已有进行中任务（job ${activeJob.id}）`
      : ''
  // 归集/清理也走 job 框架（同组同一时刻只能有一个任务）→ 只有「组内已有任务」这一条置灰理由
  const jobBusyReason = activeJob ? `该组已有进行中任务（job ${activeJob.id}）` : ''

  return (
    <Card>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="win-body-strong">{group.groupName}</span>
              <Badge variant="outline" className="font-mono">
                {group.groupId}
              </Badge>
              {group.connected ? (
                <Badge variant="success">已连接</Badge>
              ) : (
                <Badge variant="secondary">桥未连接</Badge>
              )}
              {group.dataSource === 'stub' && <Badge variant="info">本地夹具数据</Badge>}
              {maintenance && (
                <Badge variant="destructive">维护中{maintenance.reason ? `：${maintenance.reason}` : ''}</Badge>
              )}
              {group.instancesSource && group.instancesSource !== 'backend' && (
                <Badge variant="caution">{INSTANCES_SOURCE_LABELS[group.instancesSource] ?? group.instancesSource}</Badge>
              )}
            </div>
            <p className="win-caption flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              {group.host && (
                <span className="font-mono">
                  {group.host.name ?? '主机'}
                  {group.host.ip ? ` · ${group.host.ip}` : ''}
                  {group.host.agentVersion ? ` · agent ${group.host.agentVersion}` : ''}
                </span>
              )}
              {group.cachedAt ? <span>数据时间 {formatClock(group.cachedAt)}</span> : null}
              <span>服务端缓存 {Math.round((ttlMs || 0) / 1000)}s</span>
            </p>
            {capabilities.length > 0 && (
              <p className="win-caption flex flex-wrap items-center gap-1.5 text-muted-foreground">
                桥能力：
                {capabilities.map((c) => (
                  <span key={c} className="rounded-[4px] bg-[var(--subtle-secondary)] px-1.5 py-px font-mono">
                    {CAPABILITY_LABELS[c] ?? c}
                  </span>
                ))}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
              {busy ? <Ring size={14} /> : <RefreshCw className="size-3.5" />}
              刷新
            </Button>
            <Button
              size="sm"
              onClick={onUpdate}
              disabled={!!updateDisabledReason}
              title={updateDisabledReason || `对 ${group.groupName} 触发游戏更新`}
            >
              <Download className="size-3.5" />
              更新游戏
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onDemoCollect}
              disabled={!!jobBusyReason}
              title={jobBusyReason || `把 ${group.groupName} 实例里的录像归集到归档目录`}
            >
              <Film className="size-3.5" />
              归集录像
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onCleanup}
              disabled={!!jobBusyReason}
              title={jobBusyReason || `清理 ${group.groupName} 主机的旧备份/日志残留(白名单)`}
            >
              <Trash2 className="size-3.5" />
              磁盘清理
            </Button>
          </div>
        </div>

        {/* 该组进行中的更新任务：步骤 + 进度（详情/日志在「更新任务」Tab） */}
        {activeJob && <JobInlineBar job={activeJob} />}

        {/* 降级态（§4 状态机）：ok=false 无数据；ok=true + error 是「有缓存但可能过期」 */}
        {group.ok === false ? (
          <InfoBar
            severity={legacy ? 'caution' : 'critical'}
            title={legacy ? '主机 agent 能力不足（旧 Python 桥）' : '无法获取该组主机数据'}
            message={
              <>
                <span>{group.error || '未知错误'}</span>
                {legacy && (
                  <span className="mt-1 block text-muted-foreground">
                    升级到 v2 桥（见 backend/agent/v2）后本 Tab 才有数据；当前不影响其它 Tab 与接口。
                  </span>
                )}
              </>
            }
          />
        ) : group.error ? (
          <InfoBar
            severity="caution"
            title="数据可能过期"
            message={
              <>
                <span>{group.error}</span>
                <span className="mt-1 block text-muted-foreground">
                  数据时间 {formatClock(group.cachedAt)}（显示的是最后一次成功查询的缓存）
                </span>
              </>
            }
          />
        ) : null}

        {group.ok !== false && (
          <>
            <div className="grid gap-3 lg:grid-cols-2">
              <DiskBlock disk={group.disk} memory={group.memory} />
              <GameBlock game={group.game} />
            </div>
            <Block title="实例">
              <InstanceTable instances={instances} source={group.instancesSource} />
            </Block>
            <ResidualBlock residual={group.residual} />
          </>
        )}
      </div>
    </Card>
  )
}

/* ---------------- Tab 主体 ---------------- */

export function HostStatusSection() {
  const toast = useArena((s) => s.toast)
  const [groups, setGroups] = useState<HostStatus[]>([])
  const [ttlMs, setTtlMs] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'all' | string | null>(null)
  const [listError, setListError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [activeJobs, setActiveJobs] = useState<Job[]>([])
  const [updateFor, setUpdateFor] = useState<HostStatus | null>(null)
  const [demoFor, setDemoFor] = useState<HostStatus | null>(null)
  const [cleanupFor, setCleanupFor] = useState<HostStatus | null>(null)
  const busyRef = useRef<'all' | string | null>(null)

  const loadAll = useCallback(
    async ({ refresh = false, silent = false }: { refresh?: boolean; silent?: boolean } = {}) => {
      if (!silent) setBusy('all')
      busyRef.current = 'all'
      try {
        const res = await api.get<HostStatusResponse>(`/api/host/status${refresh ? '?refresh=1' : ''}`)
        setGroups(res.groups ?? [])
        if (res.ttlMs) setTtlMs(res.ttlMs)
        setUpdatedAt(Date.now())
        setListError('')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setListError(msg)
        if (!silent) toast('主机概况加载失败', msg, 'error')
      } finally {
        busyRef.current = null
        setLoading(false)
        if (!silent) setBusy(null)
      }
    },
    [toast],
  )

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // 该组进行中的更新任务：进 Tab 拉一次 + 终态/新任务时刷新（详情与日志在「更新任务」Tab）
  const loadJobs = useCallback(async () => {
    try {
      const res = await api.get<JobsCurrentResponse>('/api/jobs/current')
      setActiveJobs(res.jobs ?? [])
    } catch {
      // 任务接口不可用不影响主机概况本身
    }
  }, [])

  useEffect(() => {
    loadJobs()
  }, [loadJobs])

  useEffect(() => {
    const unsubscribe = subscribeAdmins()
    const offDone = onJobDone(() => {
      // 任务终态：维护解除 + 磁盘/版本可能已变 → 强制回源一次
      loadJobs()
      loadAll({ refresh: true, silent: true })
    })
    return () => {
      offDone()
      unsubscribe()
    }
  }, [loadAll, loadJobs])

  // 轮询：不带 refresh（命中服务端缓存）；页面隐藏时跳过，避免无谓请求
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden || busyRef.current) return
      loadAll({ silent: true })
    }, AUTO_POLL_MS)
    return () => clearInterval(id)
  }, [loadAll])

  const refreshGroup = useCallback(
    async (groupId: string) => {
      setBusy(groupId)
      busyRef.current = groupId
      try {
        const res = await api.get<HostStatusResponse>(
          `/api/host/status?groupId=${encodeURIComponent(groupId)}&refresh=1`,
        )
        const next = res.groups?.[0]
        if (next) setGroups((prev) => prev.map((g) => (g.groupId === groupId ? next : g)))
        setUpdatedAt(Date.now())
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          // 显式指定组时才会出现（组刚被删除）；只落在这张卡片上
          setGroups((prev) => prev.map((g) => (g.groupId === groupId ? { ...g, ok: false, error: '服务器组不存在' } : g)))
          toast('服务器组不存在', groupId, 'error')
        } else {
          toast('刷新失败', e instanceof Error ? e.message : String(e), 'error')
        }
      } finally {
        busyRef.current = null
        setBusy(null)
      }
    },
    [toast],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="win-body text-muted-foreground">
            主机侧只读盘点：磁盘余量 / CS2 版本 / 实例端口与运行态 / 磁盘残留（数据来自 v2 桥）
          </p>
          <p className="win-caption mt-1 text-muted-foreground">
            {loading
              ? '正在读取主机概况…'
              : `${updatedAt ? `数据时间 ${formatClock(updatedAt)} · ` : ''}每 ${Math.round(AUTO_POLL_MS / 1000)} 秒自动刷新（手动刷新绕过服务端缓存）`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => loadAll({ refresh: true })} disabled={busy !== null}>
          {busy === 'all' ? <Ring size={14} /> : <RefreshCw className="size-3.5" />}
          刷新
        </Button>
      </div>

      {listError && <InfoBar severity="critical" title="无法加载主机概况" message={listError} />}

      {!loading && groups.length === 0 && !listError && (
        <div className="win-body rounded-lg border border-dashed border-[var(--card-stroke)] py-10 text-center text-muted-foreground">
          暂无服务器组
        </div>
      )}

      {groups.map((g) => (
        <HostGroupCard
          key={g.groupId}
          group={g}
          ttlMs={ttlMs}
          busy={busy === g.groupId}
          activeJob={activeJobs.find((j) => (j.groupId ?? j.serverId) === g.groupId) ?? null}
          onRefresh={() => refreshGroup(g.groupId)}
          onUpdate={() => setUpdateFor(g)}
          onDemoCollect={() => setDemoFor(g)}
          onCleanup={() => setCleanupFor(g)}
        />
      ))}

      <GameUpdateDialog
        open={!!updateFor}
        group={updateFor}
        onOpenChange={(v) => !v && setUpdateFor(null)}
        onSubmitted={(job) => {
          toast('更新任务已下发', `任务 #${job.id}：${job.step ?? '排队中'}`, 'success')
          loadJobs()
          loadAll({ refresh: true, silent: true })
        }}
      />

      <DemoCollectDialog
        open={!!demoFor}
        group={demoFor}
        onOpenChange={(v) => !v && setDemoFor(null)}
        onSubmitted={(job) => {
          toast('录像归集任务已下发', `任务 #${job.id}：${job.step ?? '排队中'}`, 'success')
          loadJobs()
          loadAll({ refresh: true, silent: true })
        }}
      />

      <HostCleanupDialog
        open={!!cleanupFor}
        group={cleanupFor}
        onOpenChange={(v) => !v && setCleanupFor(null)}
        onSubmitted={(job) => {
          toast('磁盘清理任务已下发', `任务 #${job.id}：${job.step ?? '排队中'}`, 'success')
          loadJobs()
          loadAll({ refresh: true, silent: true })
        }}
      />
    </div>
  )
}
