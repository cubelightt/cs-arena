// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { InfoBar } from '@/components/winui/info-bar'
import { Button } from '@/components/winui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { NumberBox } from '@/components/winui/number-box'
import { Ring } from '@/components/winui/progress'
import { Switch } from '@/components/winui/switch'
import { ApiError, api } from '@/lib/api'
import { humanBytes } from '@/lib/format'
import { CLEANUP_CONFIRM, CLEANUP_PATTERNS, HOST_CLEANUP_STEPS, type HostStatus, type Job } from '@/lib/types'

/**
 * 「磁盘清理」弹窗（POST /api/host/cleanup）：白名单模式 + **默认先预览**（dry-run，只列将删项）。
 * 勾掉「先预览」＝真删，必须手工输入 CLEAN（后端也精确校验该串）。
 * 卡片里能看到的残留口径（录像/备份/MSM 日志/工坊/归档）是同一份 `residual`，这里把选中的模式
 * 与对应残留量并列，便于判断该清哪个。`.dem` 不在白名单 —— 录像不会被删。
 */
export function HostCleanupDialog({
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
  const [picked, setPicked] = useState<string[]>(['backup:old'])
  const [maxAgeDays, setMaxAgeDays] = useState(30)
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setPreview(true)
      setPicked(['backup:old'])
      setMaxAgeDays(30)
      setConfirmText('')
      setError('')
      setSubmitting(false)
    }
  }, [open])

  // 只有 backup:old / logs:rotate 看保留天数;小工具类(unused)不需要
  const ageMatters = picked.some((p) => p === 'backup:old' || p === 'logs:rotate')
  const confirmed = confirmText.trim() === CLEANUP_CONFIRM
  const canSubmit = picked.length > 0 && (preview || confirmed) && !submitting

  const residual = group?.residual
  const residualHint = (id: string): string => {
    if (id === 'backup:old') {
      const r = residual?.backup
      return r ? `当前备份 ${humanBytes(r.bytes)} / ${r.files} 个文件` : ''
    }
    if (id === 'logs:rotate') {
      const r = residual?.msmLog
      return r ? `当前 MSM 日志 ${humanBytes(r.bytes)} / ${r.files} 个文件` : ''
    }
    if (id === 'stale-instance-dirs') {
      const stale = (residual?.staleInstanceDirs ?? []).filter(Boolean)
      return stale.length ? `残留目录：${stale.join('、')}` : '无残留目录'
    }
    return ''
  }

  const toggle = (id: string) => {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  const submit = async () => {
    if (!group || !canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.post<{ ok: boolean; job: Job; dryRun: boolean }>('/api/host/cleanup', {
        groupId: group.groupId,
        patterns: picked,
        maxAgeDays,
        dryRun: preview,
        ...(preview ? {} : { confirm: CLEANUP_CONFIRM }),
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
          <DialogTitle>磁盘清理{group ? `（${group.groupName}）` : ''}</DialogTitle>
          <DialogDescription>
            只删白名单里的<b>旧</b>文件（备份/日志/残留目录），<b>不碰实例、游戏文件、平台数据与录像</b>。
            建议先预览看清将删什么，再执行真删 —— 真删不可回退。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--card-stroke)] bg-[var(--subtle-tertiary)] p-3">
            <p className="win-meta">计划（1 步）</p>
            <ol className="win-caption flex flex-col gap-1 text-muted-foreground">
              {HOST_CLEANUP_STEPS.map((s, i) => (
                <li key={s} className="flex gap-2">
                  <span className="font-mono">{i + 1}.</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="grid gap-2">
            <Label>清理模式（白名单）</Label>
            {CLEANUP_PATTERNS.map((p) => {
              const hint = residualHint(p.id)
              return (
                <label key={p.id} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="win-checkbox mt-0.5"
                    checked={picked.includes(p.id)}
                    onChange={() => toggle(p.id)}
                    disabled={submitting}
                  />
                  <span className="win-caption flex flex-col">
                    <span className="text-foreground">
                      {p.label} <span className="font-mono text-muted-foreground">{p.id}</span>
                    </span>
                    <span className="text-muted-foreground">{p.desc}</span>
                    {hint && <span className="text-muted-foreground">{hint}</span>}
                  </span>
                </label>
              )
            })}
            {picked.length === 0 && <p className="win-caption text-[var(--critical)]">至少选一种模式</p>}
          </div>

          {ageMatters && (
            <div className="grid gap-1.5">
              <Label>保留天数（早于该天数的才删；每个备份根永远保留最新一份）</Label>
              <NumberBox value={maxAgeDays} onValueChange={setMaxAgeDays} min={0} max={3650} disabled={submitting} />
            </div>
          )}

          <label className="flex items-center gap-2">
            <Switch checked={preview} onChange={(e) => setPreview(e.target.checked)} disabled={submitting} />
            <span className="win-caption">先预览（dry-run）：只列将删项与合计大小，不删任何文件</span>
          </label>

          {!preview && (
            <>
              <InfoBar
                severity="caution"
                title="将真的删除文件"
                message="真删不可回退（白名单内、早于保留天数的旧件）。录像（.dem）不在白名单内，不会被删。"
              />
              <div className="grid gap-1.5">
                <Label>输入 {CLEANUP_CONFIRM} 以确认</Label>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={CLEANUP_CONFIRM}
                  className="font-mono"
                  autoFocus
                  disabled={submitting}
                  onKeyDown={(e) => e.key === 'Enter' && confirmed && submit()}
                />
              </div>
            </>
          )}

          {error && <p className="win-caption break-all text-[var(--critical)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting && <Ring size={16} />}
            {preview ? '预览' : '执行清理'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
