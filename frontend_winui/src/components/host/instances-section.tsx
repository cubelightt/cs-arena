// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { InfoBar } from '@/components/winui/info-bar'
import { Ring } from '@/components/winui/progress'
import { InstanceCreateDialog } from '@/components/host/instance-create-dialog'
import { InstanceDeleteDialog } from '@/components/host/instance-delete-dialog'
import { InstanceEditDialog } from '@/components/host/instance-edit-dialog'
import { InstanceSourceBadge, ProvisionBadge, ProvisionErrorLine } from '@/components/host/instance-parts'
import { JobInlineBar } from '@/components/host/job-parts'
import { api, jobIdOf, onJobDone, onJobUpdate, subscribeAdmins } from '@/lib/api'
import { humanBytes } from '@/lib/format'
import {
  INSTANCE_JOB_KINDS,
  PROVISION_META,
  jobResultOf,
  type BulkInstanceOpResult,
  type GameServerGroup,
  type InstanceCreateResult,
  type InstanceDeleteResult,
  type InstanceItem,
  type Job,
  type JobsCurrentResponse,
} from '@/lib/types'
import { useArena } from '@/stores/arena'

/**
 * 管理面板「实例管理」Tab：实例卡片（编号 `#idx` / 供给状态徽章 / 来源徽章 / 供给失败原因）
 * + 工具条「新建实例」与卡片「删除实例」（都走二次确认弹窗）+ 主机侧实例的「确认」入口。
 * 建/删都是任务（job kind `instance_create` / `instance_delete`），进度/日志/取消复用 M4 的任务组件：
 * 卡片内嵌 `JobInlineBar`，完整日志与取消在「更新任务」Tab。
 * 实例清单每 5s 轮询（主机侧 `cs new`/`cs del` 的收敛 ≤5s 内可见）。
 *
 * 2026-09-23 调整（用户需求）：卡片上的「仅管理员可选」与「删除实例」收进「编辑」弹窗
 * （卡片右下角按钮）；工具条加「启动全部 / 停止全部」（`POST /api/instances/{start,stop}-all`，
 * 自动跳过已在目标状态的实例，供给中/维护中的实例跳过并在结果里给出原因）。
 */

/** 实例清单的轮询周期：主机侧建删经 `instances_report` 对账收敛（守护 5s 一次），面板同步跟上 */
const POLL_MS = 5000

interface JobPushPatch {
  id: number
  status?: Job['status']
  step?: string | null
  stepIndex?: number
  stepTotal?: number
  progress?: number
  error?: string | null
  result?: unknown
}

export function InstancesSection({ onOpenJob }: { onOpenJob?: (jobId: number | null) => void }) {
  const [instances, setInstances] = useState<InstanceItem[]>([])
  const [groups, setGroups] = useState<GameServerGroup[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [listError, setListError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createPrefill, setCreatePrefill] = useState('')
  const [deleting, setDeleting] = useState<InstanceItem | null>(null)
  const [editing, setEditing] = useState<InstanceItem | null>(null)
  const [bulkBusy, setBulkBusy] = useState<'start' | 'stop' | null>(null)
  const toast = useArena((s) => s.toast)
  const navigate = useNavigate()

  // 任务列表既进 state（渲染）也进 ref（socket 回调里同步读取，避免依赖渲染时序）
  const jobsRef = useRef<Job[]>([])
  const toastedRef = useRef<Set<number>>(new Set())

  const instanceJobOf = useCallback(
    (inst: InstanceItem) =>
      jobs.find(
        (j) => INSTANCE_JOB_KINDS.includes(j.kind) && (j.instanceName ?? (j.params?.name as string | undefined)) === inst.name,
      ) ?? null,
    [jobs],
  )

  const fetchInstances = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) setLoading(true)
      try {
        const [list, servers] = await Promise.all([
          api.get<InstanceItem[]>('/api/instances'),
          api.get<GameServerGroup[]>('/api/game-servers'),
        ])
        setInstances(list)
        setGroups(servers)
        setListError('')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setListError(msg)
        if (!silent) toast('实例列表加载失败', msg, 'error')
      } finally {
        setLoading(false)
      }
    },
    [toast],
  )

  const loadJobs = useCallback(async () => {
    try {
      const res = await api.get<JobsCurrentResponse>('/api/jobs/current')
      const list = res.jobs ?? []
      jobsRef.current = list
      setJobs(list)
    } catch {
      // 任务接口不可用不影响实例列表本身
    }
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([fetchInstances({ silent: true }), loadJobs()])
    setRefreshing(false)
  }, [fetchInstances, loadJobs])

  useEffect(() => {
    fetchInstances()
    loadJobs()
  }, [fetchInstances, loadJobs])

  /** 合并 socket 推来的任务字段（同步更新 ref，终态回调里能立刻读到 result） */
  const patchJob = useCallback((patch: JobPushPatch) => {
    jobsRef.current = jobsRef.current.map((j) => (j.id === patch.id ? { ...j, ...patch } : j))
    setJobs(jobsRef.current)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeAdmins()
    const offUpdate = onJobUpdate((p) => {
      const id = jobIdOf(p)
      if (id == null) return
      if (!jobsRef.current.some((j) => j.id === id)) {
        loadJobs()
        return
      }
      patchJob({
        id,
        status: p.status,
        step: p.step ?? undefined,
        stepIndex: p.stepIndex,
        stepTotal: p.stepTotal,
        progress: p.progress,
        error: p.error ?? undefined,
        result: p.result,
      })
    })
    const offDone = onJobDone((p) => {
      if (p.jobId == null) return
      const job = jobsRef.current.find((j) => j.id === p.jobId) ?? null
      patchJob({ id: p.jobId, status: p.status })
      if (job && INSTANCE_JOB_KINDS.includes(job.kind) && !toastedRef.current.has(job.id)) {
        toastedRef.current.add(job.id)
        notifyInstanceJob({ ...job, status: p.status }, toast)
      }
      // 终态帧到达时后端已完成收敛（清供给态 / 删行）→ 回源实例清单与任务列表
      loadJobs()
      fetchInstances({ silent: true })
    })
    return () => {
      offUpdate()
      offDone()
      unsubscribe()
    }
  }, [fetchInstances, loadJobs, patchJob, toast])

  // 实例清单轮询：覆盖「主机侧 cs new/cs del 自动出现/消失」与任务推进（页面隐藏时跳过）
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return
      fetchInstances({ silent: true })
      loadJobs()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [fetchInstances, loadJobs])

  const runOp = async (name: string, op: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(`${name}:${op}`)
    try {
      await api.post(`/api/instances/${name}/${op}`)
      toast(`${op} 命令已发送`, `实例 ${name}`, 'success')
      await fetchInstances({ silent: true })
    } catch (e) {
      toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  /** 一键启停全部:后端逐台判定并跳过(已在目标状态 / 供给中 / 组维护中),结果里逐条给原因 */
  const runBulk = async (op: 'start' | 'stop') => {
    if (op === 'stop' && !window.confirm('确定停止全部实例？进行中的比赛会被中断。')) return
    setBulkBusy(op)
    try {
      const res = await api.post<BulkInstanceOpResult>(`/api/instances/${op}-all`)
      const acted = res.acted?.length ?? 0
      const skipped = res.skipped ?? []
      const failed = res.failed ?? []
      const parts = [`已下发 ${acted} 台`]
      if (skipped.length) parts.push(`跳过 ${skipped.length} 台（${skipped.map((x) => `${x.name}：${x.reason}`).join('；')}）`)
      if (failed.length) parts.push(`失败 ${failed.length} 台（${failed.map((x) => `${x.name}：${x.error}`).join('；')}）`)
      toast(op === 'start' ? '启动全部' : '停止全部', parts.join(' · '), failed.length ? 'error' : 'success')
      await fetchInstances({ silent: true })
    } catch (e) {
      toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBulkBusy(null)
    }
  }

  const confirmInstance = async (inst: InstanceItem) => {
    setBusy(`${inst.name}:confirm`)
    try {
      await api.post(`/api/instances/${inst.name}/confirm`)
      toast('实例已确认', `${inst.name} 现在可参与自动分配`, 'success')
      await fetchInstances({ silent: true })
    } catch (e) {
      toast('确认失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const onCreated = async (job: Job, name: string) => {
    toast('创建任务已下发', `实例 ${name} · 任务 #${job.id}（进度见卡片任务条）`, 'success')
    await Promise.all([loadJobs(), fetchInstances({ silent: true })])
  }

  const onDeleted = async (job: Job, name: string) => {
    toast('删除任务已下发', `实例 ${name} · 任务 #${job.id}，成功后退还空间且卡片消失`, 'default')
    await Promise.all([loadJobs(), fetchInstances({ silent: true })])
  }

  const unconfirmed = useMemo(() => instances.filter((i) => i.provisionState === 'unconfirmed'), [instances])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="win-body text-muted-foreground">
            控制单个实例的启动、停止、重启与锁复位（{instances.length} 台）
          </p>
          <p className="win-caption mt-1 text-muted-foreground">
            {loading
              ? '正在读取实例…'
              : `新建 / 删除都是主机侧任务：进度见卡片任务条，日志与取消在「更新任务」Tab · 每 ${POLL_MS / 1000}s 自动刷新`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={bulkBusy !== null || instances.length === 0}
            title="启动所有未运行的实例（已在运行/启动中/供给中的自动跳过）"
            onClick={() => runBulk('start')}
          >
            {bulkBusy === 'start' && <Ring size={14} />}
            启动全部
          </Button>
          <Button
            variant="outline"
            disabled={bulkBusy !== null || instances.length === 0}
            title="停止所有运行中的实例（已停止/供给中的自动跳过；进行中的比赛会被中断）"
            onClick={() => runBulk('stop')}
          >
            {bulkBusy === 'stop' && <Ring size={14} />}
            停止全部
          </Button>
          <Button
            onClick={() => {
              setCreatePrefill('')
              setCreateOpen(true)
            }}
            // 首屏加载中不置灰（弹窗自己会提示「没有可用的服务器组」）
            disabled={!loading && groups.filter((g) => g.isActive).length === 0}
            title={!loading && groups.filter((g) => g.isActive).length === 0 ? '没有已激活的服务器组' : undefined}
          >
            新建实例
          </Button>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Ring size={14} /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </div>
      </div>

      {listError && <InfoBar severity="critical" title="实例列表加载失败" message={listError} />}
      {unconfirmed.length > 0 && (
        <InfoBar
          severity="caution"
          title={`有 ${unconfirmed.length} 台主机侧创建的实例尚未确认`}
          message="确认后才参与自动分配（点卡片上的「确认」）；主机侧 cs new 创建的实例在确认前不可启停。"
        />
      )}

      {instances.length === 0 && !loading ? (
        <Card>
          <p className="win-body p-4 text-muted-foreground">
            暂无实例：点右上角「新建实例」在某个服务器组下创建（需要该组桥在线且已声明 jobs 能力）。
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {instances.map((inst) => {
            const state = STATE_META[inst.state] ?? { label: inst.state, variant: 'secondary' as const }
            const healthMeta = HEALTH_META[inst.health] ?? { label: inst.health, variant: 'secondary' as const }
            const isBusy = busy?.startsWith(inst.name)
            const provision = inst.provisionState
            const provisionHint = provision ? PROVISION_META[provision].hint : undefined
            // 供给中（creating/deleting/failed/unconfirmed）后端一律拒绝启停与分级 —— 面板同步置灰
            const opsDisabled = !!busy || !!provision
            const job = instanceJobOf(inst)
            return (
              <Card key={inst.name}>
                <div className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="win-caption font-mono text-muted-foreground" title="实例编号（删除后作废不回收）">
                        {inst.idx != null ? `#${inst.idx}` : '#—'}
                      </span>
                      <span className="win-body-strong font-mono">{inst.name}</span>
                      <span className="win-caption font-mono text-muted-foreground">
                        {inst.port ? `:${inst.port}` : ':—'}
                      </span>
                      <Badge variant={state.variant}>{state.label}</Badge>
                      <Badge variant={healthMeta.variant} className="font-mono">
                        {healthMeta.label}
                      </Badge>
                      {inst.adminOnly && <Badge variant="info">仅管理员</Badge>}
                      <ProvisionBadge state={provision} error={inst.provisionError} />
                      <InstanceSourceBadge source={inst.source} />
                    </div>
                    <span className="win-caption shrink-0 text-muted-foreground">对局 {inst.matchId ?? '—'}</span>
                  </div>

                  <ProvisionErrorLine error={inst.provisionError} />

                  {job && (
                    <div className="flex flex-col gap-2">
                      <JobInlineBar job={job} />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="win-caption text-muted-foreground">实时日志与取消在「更新任务」Tab</p>
                        {onOpenJob && (
                          <Button variant="link" size="sm" onClick={() => onOpenJob(job.id)}>
                            查看任务 #{job.id}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => navigate(`/admin/console/${inst.name}`)}
                      disabled={opsDisabled || (inst.health !== 'RUNNING' && inst.health !== 'BOOTING')}
                      title={provisionHint}
                    >
                      控制台
                    </Button>
                    {provision === 'unconfirmed' && (
                      <Button size="sm" onClick={() => confirmInstance(inst)} disabled={!!busy} title="确认后参与自动分配">
                        {isBusy && <Ring size={14} />}
                        确认
                      </Button>
                    )}
                    {provision === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        title="用同名重新创建（后端会复用上次失败的预留行）"
                        onClick={() => {
                          setCreatePrefill(inst.name)
                          setCreateOpen(true)
                        }}
                      >
                        重试
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={opsDisabled}
                      title={provisionHint}
                      onClick={() => runOp(inst.name, 'start')}
                    >
                      {isBusy && <Ring size={14} />}
                      启动
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={opsDisabled}
                      title={provisionHint}
                      onClick={() => runOp(inst.name, 'stop', `确定停止实例 ${inst.name}？`)}
                    >
                      {isBusy && <Ring size={14} />}
                      停止
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={opsDisabled}
                      title={provisionHint}
                      onClick={() => runOp(inst.name, 'restart', `确定重启实例 ${inst.name}？`)}
                    >
                      {isBusy && <Ring size={14} />}
                      重启
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[var(--critical)]"
                      disabled={opsDisabled}
                      title={provisionHint}
                      onClick={() => runOp(inst.name, 'reset', `确定复位实例 ${inst.name} 的锁？`)}
                    >
                      {isBusy && <Ring size={14} />}
                      锁复位
                    </Button>
                    {/* 编辑（右下角）：端口 / 仅管理员可选 / 删除实例都在弹窗里 */}
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      disabled={!!busy}
                      title="编辑端口、分级，或删除该实例"
                      onClick={() => setEditing(inst)}
                    >
                      编辑
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <InstanceCreateDialog
        open={createOpen}
        groups={groups}
        defaultName={createPrefill}
        onOpenChange={setCreateOpen}
        onSubmitted={onCreated}
        onOpenJobs={onOpenJob}
      />
      <InstanceEditDialog
        open={!!editing}
        instance={editing}
        onOpenChange={(v) => !v && setEditing(null)}
        onSaved={() => fetchInstances({ silent: true })}
        onRequestDelete={(inst) => {
          setEditing(null)
          setDeleting(inst)
        }}
      />
      <InstanceDeleteDialog
        open={!!deleting}
        instance={deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        onSubmitted={onDeleted}
      />
    </div>
  )
}

/** 建/删任务的终态提示（与任务列表的「已完成/失败」语义一致，含桥回读的端口/编号/释放字节数） */
function notifyInstanceJob(job: Job, toast: (title: string, message?: string, kind?: 'default' | 'success' | 'error') => void) {
  const name = job.instanceName ?? (job.params?.name as string | undefined) ?? '实例'
  const create = job.kind === 'instance_create'
  if (job.status === 'done') {
    if (create) {
      const r = jobResultOf<InstanceCreateResult>(job)
      const bits = [r?.port ? `端口 ${r.port}` : null, r?.idx ? `编号 #${r.idx}` : null].filter(Boolean).join(' · ')
      toast(`实例 ${name} 创建完成`, bits || '端口与编号以主机回读为准', 'success')
    } else {
      const r = jobResultOf<InstanceDeleteResult>(job)
      toast(`实例 ${name} 已删除`, r?.freedBytes ? `释放 ${humanBytes(r.freedBytes)}` : undefined, 'success')
    }
    return
  }
  const label = job.status === 'cancelled' ? '已取消' : '失败'
  toast(`实例${create ? '创建' : '删除'}${label}`, `${name}${job.error ? ` —— ${job.error}` : ''}`, 'error')
}

const STATE_META: Record<string, { label: string; variant: 'success' | 'info' | 'destructive' | 'secondary' }> = {
  idle: { label: '空闲', variant: 'success' },
  booting: { label: '启动中', variant: 'info' },
  in_match: { label: '对局中', variant: 'destructive' },
  cooling: { label: '冷却中', variant: 'secondary' },
}

const HEALTH_META: Record<string, { label: string; variant: 'success' | 'info' | 'destructive' | 'secondary' }> = {
  RUNNING: { label: 'RUNNING', variant: 'success' },
  STOPPED: { label: 'STOPPED', variant: 'secondary' },
  BOOTING: { label: 'BOOTING', variant: 'info' },
  UNKNOWN: { label: 'UNKNOWN', variant: 'secondary' },
  unreachable: { label: '不可达', variant: 'destructive' },
}
