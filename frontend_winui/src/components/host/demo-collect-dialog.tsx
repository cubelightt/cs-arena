// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { InfoBar } from '@/components/winui/info-bar'
import { Button } from '@/components/winui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Ring } from '@/components/winui/progress'
import { Switch } from '@/components/winui/switch'
import { ApiError, api } from '@/lib/api'
import { humanBytes } from '@/lib/format'
import { DEMO_COLLECT_STEPS, type HostStatus, type Job } from '@/lib/types'

/**
 * 「归集录像」弹窗（POST /api/host/demo-collect）：把实例 MatchZy/*.dem 搬到主机的 demo_dir。
 * 录像只是**搬家**、不会被删除，所以不需要二次确认串；但**默认先预览**（dry-run，只列清单），
 * 勾掉「先预览」才会真搬。4xx/5xx 内联红字（组内已有任务/桥未连接/旧桥升级指引）。
 */
export function DemoCollectDialog({
  open,
  group,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean
  group: HostStatus | null
  onOpenChange: (v: boolean) => void
  onSubmitted: (job: Job) => void
}) {
  const [preview, setPreview] = useState(true)
  const [all, setAll] = useState(true)
  const [matchId, setMatchId] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setPreview(true)
      setAll(true)
      setMatchId('')
      setError('')
      setSubmitting(false)
    }
  }, [open])

  const needMatch = !all && matchId.trim() === ''
  const demo = group?.residual?.demos ?? null
  const demoDir = demo?.path ?? null

  const submit = async () => {
    if (!group || needMatch) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.post<{ ok: boolean; job: Job; dryRun: boolean }>('/api/host/demo-collect', {
        groupId: group.groupId,
        all: all || matchId.trim() === '',
        matchId: matchId.trim(),
        dryRun: preview,
      })
      onSubmitted(res.job)
      onOpenChange(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const legacy = e instanceof ApiError && e.status === 502 && msg.includes('未声明 jobs 能力')
      setError(legacy ? `${msg}——升级到 v2 桥（见 backend/agent/v2）后可用` : msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>归集录像{group ? `（${group.groupName}）` : ''}</DialogTitle>
          <DialogDescription>
            把实例 <span className="font-mono">MatchZy/*.dem</span> 搬到主机的录像目录
            {demoDir ? (
              <>
                （<span className="font-mono">{demoDir}</span>）
              </>
            ) : null}
            ，按「实例/日期」分目录。<b>只搬不删</b>；实例 MatchZy 里被搬走的文件就到归档目录里找。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5 rounded-lg border border-[var(--card-stroke)] bg-[var(--subtle-tertiary)] p-3">
            <p className="win-meta">计划（1 步）</p>
            <ol className="win-caption flex flex-col gap-1 text-muted-foreground">
              {DEMO_COLLECT_STEPS.map((s, i) => (
                <li key={s} className="flex gap-2">
                  <span className="font-mono">{i + 1}.</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
            {demoDir && (
              <p className="win-caption text-muted-foreground">
                归档目录 <span className="font-mono">{demoDir}</span>
                {demo ? `（现有 ${humanBytes(demo.bytes)} / ${demo.files} 个文件）` : ''}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label>范围</Label>
            <label className="win-caption flex items-center gap-2 text-muted-foreground">
              <input
                type="radio"
                className="win-radio"
                checked={all}
                onChange={() => setAll(true)}
                disabled={submitting}
              />
              全部实例的未归集录像
            </label>
            <label className="win-caption flex items-center gap-2 text-muted-foreground">
              <input
                type="radio"
                className="win-radio"
                checked={!all}
                onChange={() => setAll(false)}
                disabled={submitting}
              />
              指定场次（按文件名匹配比赛号）
            </label>
            {!all && (
              <Input
                value={matchId}
                onChange={(e) => setMatchId(e.target.value)}
                placeholder="比赛号，如 match-94"
                className="font-mono"
                disabled={submitting}
              />
            )}
          </div>

          <label className="flex items-center gap-2">
            <Switch checked={preview} onChange={(e) => setPreview(e.target.checked)} disabled={submitting} />
            <span className="win-caption">先预览（dry-run）：只列将搬哪些文件，不动盘</span>
          </label>

          {!preview && (
            <InfoBar
              severity="caution"
              title="将真的搬动文件"
              message="录像会从实例 MatchZy 目录移到归档目录（不删除）。任务失败/取消时已搬的保留在归档里，重跑会跳过已存在的目标文件。"
            />
          )}

          {error && <p className="win-caption break-all text-[var(--critical)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || needMatch}>
            {submitting && <Ring size={16} />}
            {preview ? '预览' : '开始归集'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
