// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { InfoBar } from '@/components/winui/info-bar'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Ring } from '@/components/winui/progress'
import { JobErrorLine, JobLogView, JobOriginCell, JobProgress, JobResultBlock, JobResultLine, JobStatusBadge, jobKindLabel } from '@/components/host/job-parts'
import { api, jobIdOf, onJobDone, onJobOutput, onJobUpdate, subscribeAdmins } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import {
  FORCE_CANCEL_CONFIRM,
  isJobActive,
  type Job,
  type JobDetailResponse,
  type JobsResponse,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useArena } from '@/stores/arena'

/**
 * 管理面板「更新任务」Tab（仅管理员）：任务列表 + 当前任务条 + 实时日志 + 取消（常规 A / 强制 B）。
 * 实时性靠 socket 的 admins 频道（`job:update` / `job:output` / `job:done`）；REST 用于列表与详情兜底，
 * 断线重连后按 `?offset=`（后端给 offset 时）或尾段重读补齐日志，不丢行。
 * 主机侧 `cs` 发起的任务（origin=cli）同样在这里展示。
 */

/** 日志缓冲上限（与实例控制台一致的 5000 行口径，防长任务吃内存） */
const MAX_LOG_LINES = 5000
/** 有进行中任务时的兜底轮询（socket 不可用/丢事件时不至于停在旧状态） */
const POLL_MS = 5000

export function JobsSection({
  focusJob,
  onFocusApplied,
}: {
  /** 从实例卡片的「查看任务」跳进来时要选中的任务（seq 保证同一任务再次跳转也生效） */
  focusJob?: { id: number; seq: number } | null
  /** 消费完 focusJob 后通知父级清空：否则再次进入本 Tab 会被旧值重新选中 */
  onFocusApplied?: () => void
}) {
  const toast = useArena((s) => s.toast)
  const [jobs, setJobs] = useState<Job[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<Job | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [forceOpen, setForceOpen] = useState(false)
  const [listError, setListError] = useState('')
  // 增量日志偏移：后端在尾段读返回 offset/size 时用它续拉；拿不到就靠尾段重读补齐
  const offsetRef = useRef<number | null>(null)
  const selectedRef = useRef<number | null>(null)

  selectedRef.current = selectedId

  const active = useMemo(() => jobs.filter((j) => isJobActive(j.status)), [jobs])
  const selected = detail ?? jobs.find((j) => j.id === selectedId) ?? null

  const appendLines = useCallback((incoming: string[]) => {
    if (incoming.length === 0) return
    setLines((prev) => {
      const merged = [...prev, ...incoming]
      return merged.length > MAX_LOG_LINES ? merged.slice(merged.length - MAX_LOG_LINES) : merged
    })
  }, [])

  /**
   * 尾段重读的合并（拿不到 offset 时的补齐路径）：任务日志是**追加式**的，
   * 新旧两份尾段必有重叠 —— 取最长重叠 k，只追加 `tail.slice(k)`；无重叠（两次之间新增
   * 行数超过尾段窗口）则整段追加，宁可多几行也不丢行。**不能**整段无脑追加（会×N 重复）。
   */
  const appendTail = useCallback((tail: string[]) => {
    if (tail.length === 0) return
    setLines((prev) => {
      let k = 0
      const max = Math.min(prev.length, tail.length)
      for (let n = max; n > 0 && k === 0; n--) {
        let match = true
        for (let i = 0; i < n; i++) {
          if (prev[prev.length - n + i] !== tail[i]) {
            match = false
            break
          }
        }
        if (match) k = n
      }
      const merged = [...prev, ...tail.slice(k)]
      return merged.length > MAX_LOG_LINES ? merged.slice(merged.length - MAX_LOG_LINES) : merged
    })
  }, [])

  const mergeJob = useCallback((patch: Partial<Job> & { id: number }) => {
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === patch.id)
      if (idx === -1) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], ...patch }
      return next
    })
    setDetail((prev) => (prev && prev.id === patch.id ? { ...prev, ...patch } : prev))
  }, [])

  const loadList = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) setLoading(true)
      try {
        const res = await api.get<JobsResponse>('/api/jobs?limit=50')
        setJobs(res.jobs ?? [])
        setListError('')
        // 默认选中：第一个进行中任务，否则最新一条
        setSelectedId((cur) => {
          if (cur != null && (res.jobs ?? []).some((j) => j.id === cur)) return cur
          const act = (res.active ?? [])[0]
          return act ? act.id : ((res.jobs ?? [])[0]?.id ?? null)
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setListError(msg)
        if (!silent) toast('任务列表加载失败', msg, 'error')
      } finally {
        setLoading(false)
      }
    },
    [toast],
  )

  const loadDetail = useCallback(
    async (id: number, { keepLog = false }: { keepLog?: boolean } = {}) => {
      setLogLoading(true)
      try {
        const res = await api.get<JobDetailResponse>(`/api/jobs/${id}?lines=200`)
        setDetail(res.job)
        const off = res.offset ?? res.size
        offsetRef.current = typeof off === 'number' ? off : null
        if (!keepLog) setLines([])
        appendLines(res.lines ?? [])
      } catch (e) {
        toast('任务详情加载失败', e instanceof Error ? e.message : String(e), 'error')
      } finally {
        setLogLoading(false)
      }
    },
    [appendLines, toast],
  )

  /** 断线/终态后的补齐：有 offset 走增量（服务端只回新行），否则重读尾段并按重叠合并 */
  const catchUp = useCallback(
    async (id: number) => {
      try {
        const hasOffset = offsetRef.current != null
        const q = hasOffset ? `offset=${offsetRef.current}` : 'lines=200'
        const res = await api.get<JobDetailResponse>(`/api/jobs/${id}?${q}`)
        setDetail(res.job)
        const off = res.offset ?? res.size
        if (typeof off === 'number') offsetRef.current = off
        if (hasOffset) appendLines(res.lines ?? [])
        else appendTail(res.lines ?? [])
      } catch {
        // 补齐失败不打扰用户：下一次事件/轮询会再试
      }
    },
    [appendLines, appendTail],
  )

  useEffect(() => {
    loadList()
  }, [loadList])

  // 从实例卡片的「查看任务」跳进来：选中指定任务，并立刻通知父级清空（一次性语义）
  useEffect(() => {
    if (!focusJob) return
    setSelectedId(focusJob.id)
    onFocusApplied?.()
  }, [focusJob, onFocusApplied])

  // 选中变化：换任务时重置日志与偏移
  useEffect(() => {
    if (selectedId == null) {
      setDetail(null)
      setLines([])
      offsetRef.current = null
      return
    }
    loadDetail(selectedId)
  }, [selectedId, loadDetail])

  // admins 频道：job:update / job:output / job:done
  useEffect(() => {
    const unsubscribe = subscribeAdmins()
    const offUpdate = onJobUpdate((p) => {
      const id = jobIdOf(p)
      if (id == null) return
      const known = jobs.some((j) => j.id === id)
      if (!known) {
        loadList({ silent: true })
        return
      }
      mergeJob({
        id,
        status: p.status,
        step: p.step ?? undefined,
        stepIndex: p.stepIndex,
        stepTotal: p.stepTotal,
        progress: p.progress,
        error: p.error ?? undefined,
      })
      if (p.line) appendLines([p.line])
    })
    const offOutput = onJobOutput((p) => {
      if (p.jobId == null || p.jobId !== selectedRef.current) return
      appendLines([p.line])
    })
    const offDone = onJobDone((p) => {
      if (p.jobId == null) return
      mergeJob({ id: p.jobId, status: p.status })
      loadList({ silent: true })
      if (p.jobId === selectedRef.current) catchUp(p.jobId)
    })
    return () => {
      offUpdate()
      offOutput()
      offDone()
      unsubscribe()
    }
  }, [appendLines, catchUp, jobs, loadList, mergeJob])

  // 有进行中任务时的兜底轮询（列表 + 选中任务的日志偏移补齐）
  useEffect(() => {
    if (active.length === 0) return
    const timer = setInterval(() => {
      if (document.hidden) return
      loadList({ silent: true })
      if (selectedRef.current != null) catchUp(selectedRef.current)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [active.length, catchUp, loadList])

  const refresh = async () => {
    setRefreshing(true)
    await loadList({ silent: true })
    if (selectedRef.current != null) await loadDetail(selectedRef.current, { keepLog: true })
    setRefreshing(false)
  }

  const cancel = async (force: boolean) => {
    if (!selected) return
    setBusy(true)
    try {
      const res = await api.post<{ ok: boolean; job: Job }>(`/api/jobs/${selected.id}/cancel`, {
        force,
        confirm: force ? FORCE_CANCEL_CONFIRM : undefined,
      })
      mergeJob(res.job)
      toast(force ? '已强制取消' : '已请求取消', force ? '可能留下半更新目录，请随后执行 cs update 或 msm validate' : `任务 #${selected.id}（等待当前步骤结束）`, force ? 'error' : 'default')
      setForceOpen(false)
      loadList({ silent: true })
    } catch (e) {
      toast('取消失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="win-body text-muted-foreground">
            主机侧任务（更新 / 同步 / 建删实例等）：进度、日志与取消；主机上用 <code className="font-mono">cs</code>{' '}
            发起的任务同样在此展示
          </p>
          <p className="win-caption mt-1 text-muted-foreground">
            {loading
              ? '正在读取任务…'
              : `共 ${jobs.length} 条${active.length ? ` · 进行中 ${active.length}` : ''} · 实时推送 ${active.length ? `中（兜底 ${POLL_MS / 1000}s 轮询）` : '已就绪'}`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Ring size={14} /> : <RefreshCw className="size-3.5" />}
          刷新
        </Button>
      </div>

      {listError && <InfoBar severity="critical" title="无法加载任务列表" message={listError} />}

      {/* 任务列表 */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <p className="win-meta">任务列表</p>
          {jobs.length === 0 && !loading ? (
            <p className="win-caption text-muted-foreground">
              暂无任务。可在「主机概况」Tab 对某个服务器组触发「更新游戏」。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] border-collapse">
                <thead>
                  <tr className="win-caption text-left text-muted-foreground">
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal">#</th>
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">类型</th>
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">组</th>
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">实例</th>
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">状态</th>
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal">步骤</th>
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">进度</th>
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">发起</th>
                    <th className="border-b border-[var(--divider)] px-2 py-1.5 font-normal whitespace-nowrap">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr
                      key={j.id}
                      onClick={() => setSelectedId(j.id)}
                      className={cn(
                        'win-caption cursor-pointer align-top transition-colors hover:bg-[var(--subtle-secondary)]',
                        j.id === selectedId && 'bg-[var(--subtle-secondary)]',
                      )}
                    >
                      <td className="border-b border-[var(--divider)] px-2 py-2 font-mono">{j.id}</td>
                      <td className="border-b border-[var(--divider)] px-2 py-2 whitespace-nowrap">{jobKindLabel(j.kind)}</td>
                      <td className="border-b border-[var(--divider)] px-2 py-2 font-mono whitespace-nowrap">{j.groupId ?? '—'}</td>
                      <td className="border-b border-[var(--divider)] px-2 py-2 font-mono whitespace-nowrap">
                        {j.instanceName ?? (j.params?.name as string | undefined) ?? '—'}
                      </td>
                      <td className="border-b border-[var(--divider)] px-2 py-2 whitespace-nowrap">
                        <JobStatusBadge job={j} />
                      </td>
                      {/* 步骤/错误/结果在列表里一律单行省略（长结果曾把整行撑成整屏，见 〇-29）；
                          完整内容在下方详情（选中该行即显示）——悬浮提示给出未截断的原文 */}
                      <td className="max-w-[360px] border-b border-[var(--divider)] px-2 py-2">
                        <div className="truncate" title={j.step ?? ''}>
                          {j.step ?? '—'}
                        </div>
                        {j.status === 'failed' && j.error && <JobErrorLine job={j} className="mt-1" clamp />}
                        <JobResultLine job={j} className="mt-1" clamp />
                      </td>
                      <td className="border-b border-[var(--divider)] px-2 py-2 font-mono whitespace-nowrap">
                        {j.stepTotal ? `${Math.min(j.stepIndex ?? 0, j.stepTotal)}/${j.stepTotal} · ` : ''}
                        {j.progress ?? 0}%
                      </td>
                      <td className="border-b border-[var(--divider)] px-2 py-2 whitespace-nowrap">
                        <JobOriginCell job={j} />
                      </td>
                      <td className="border-b border-[var(--divider)] px-2 py-2 whitespace-nowrap text-muted-foreground">
                        {formatDateTime(j.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* 任务详情 */}
      {selected && (
        <Card>
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="win-body-strong">任务 #{selected.id}</span>
                <Badge variant="outline">{jobKindLabel(selected.kind)}</Badge>
                <Badge variant="secondary" className="font-mono">
                  {selected.groupId ?? '—'}
                </Badge>
                {(selected.instanceName ?? (selected.params?.name as string | undefined)) && (
                  <Badge variant="secondary" className="font-mono">
                    实例 {selected.instanceName ?? (selected.params?.name as string | undefined)}
                  </Badge>
                )}
                <JobStatusBadge job={selected} />
                {selected.origin === 'cli' && <Badge variant="info">主机侧发起</Badge>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="win-caption text-muted-foreground">
                  开始 {formatDateTime(selected.startedAt ?? selected.createdAt)}
                  {selected.finishedAt ? ` · 结束 ${formatDateTime(selected.finishedAt)}` : ''}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cancel(false)}
                  disabled={busy || !isJobActive(selected.status)}
                  title="当前步骤结束后停止（steamcmd 可能几十分钟）"
                >
                  {busy && <Ring size={14} />}
                  取消
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-[var(--critical)]"
                  onClick={() => setForceOpen(true)}
                  disabled={busy || !isJobActive(selected.status)}
                  title="立即 kill 进程组，可能留下半更新目录"
                >
                  强制取消
                </Button>
              </div>
            </div>

            <JobProgress job={selected} />
            <JobErrorLine job={selected} />
            <JobResultBlock job={selected} />
            <JobLogView lines={lines} loading={logLoading} />
          </div>
        </Card>
      )}

      {/* 强制取消的二次确认（输入 FORCE） */}
      <Dialog open={forceOpen} onOpenChange={(v) => !busy && setForceOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>强制取消任务 #{selected?.id}</DialogTitle>
            <DialogDescription>
              立即 kill 进程组（不等当前步骤结束）。<b>可能留下半更新目录</b>，需随后在主机执行{' '}
              <code className="font-mono">cs update</code> 或 <code className="font-mono">msm validate</code>{' '}
              修复；该组的维护态随任务终态解除。
            </DialogDescription>
          </DialogHeader>
          <ForceCancelInput busy={busy} onConfirm={() => cancel(true)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setForceOpen(false)} disabled={busy}>
              返回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 强制取消的确认串输入（输入 FORCE 才允许确认） */
function ForceCancelInput({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const [text, setText] = useState('')
  const ok = text.trim() === FORCE_CANCEL_CONFIRM
  return (
    <div className="grid gap-2">
      <Label>输入 {FORCE_CANCEL_CONFIRM} 以确认</Label>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={FORCE_CANCEL_CONFIRM}
        className="font-mono"
        autoFocus
        disabled={busy}
        onKeyDown={(e) => e.key === 'Enter' && ok && onConfirm()}
      />
      <Button variant="outline" className="text-[var(--critical)]" onClick={onConfirm} disabled={!ok || busy}>
        {busy && <Ring size={16} />}
        强制取消
      </Button>
    </div>
  )
}
