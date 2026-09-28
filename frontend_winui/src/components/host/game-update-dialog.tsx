// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { InfoBar } from '@/components/winui/info-bar'
import { Button } from '@/components/winui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Ring } from '@/components/winui/progress'
import { ApiError, api } from '@/lib/api'
import { humanBytes } from '@/lib/format'
import { GAME_UPDATE_STEPS, UPDATE_CONFIRM, type HostStatus, type Job } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * 「更新游戏」二次确认弹窗（POST /api/host/game-update）：计划预览 + 当前版本对比 +
 * **手工输入 UPDATE** 才能提交（后端也精确校验该串）。
 * 4xx/5xx 一律落在弹窗内联红字（确认串错不关窗、组内已有任务/实例在用/旧桥升级指引按原文提示），
 * 不弹全局错误。
 */
export function GameUpdateDialog({
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
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setConfirmText('')
      setError('')
      setSubmitting(false)
    }
  }, [open])

  const installed = group?.game?.installed?.build ?? null
  const latest = group?.game?.latest?.build ?? null
  const disk = group?.disk
  const confirmed = confirmText.trim() === UPDATE_CONFIRM

  const submit = async () => {
    if (!group || !confirmed) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.post<{ ok: boolean; job: Job }>('/api/host/game-update', {
        groupId: group.groupId,
        confirm: UPDATE_CONFIRM,
      })
      onSubmitted(res.job)
      onOpenChange(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 旧桥（502）额外给升级指引；其余按后端原文提示
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
          <DialogTitle>更新游戏{group ? `（${group.groupName}）` : ''}</DialogTitle>
          <DialogDescription>
            该组全部实例会被停止 → 更新 → 重新启动；更新期间该组
            <b>不可开赛、不可启停实例</b>（其他组不受影响），任务结束（成功/失败/取消）后自动解除维护。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--card-stroke)] bg-[var(--subtle-tertiary)] p-3">
            <p className="win-meta">计划（7 步）</p>
            <ol className="win-caption flex flex-col gap-1 text-muted-foreground">
              {GAME_UPDATE_STEPS.map((s, i) => (
                <li key={s} className="flex gap-2">
                  <span className="font-mono">{i + 1}.</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="grid gap-1.5 rounded-lg border border-[var(--card-stroke)] bg-[var(--subtle-tertiary)] p-3">
            <p className="win-meta">版本对比</p>
            <p className="win-caption text-muted-foreground">
              本地已装 <span className="font-mono text-foreground">{installed ?? '未知'}</span>
              {' → 官方最新 '}
              <span className="font-mono text-foreground">{latest ?? '未知'}</span>
              {installed && latest && installed !== latest ? '（更新后应对齐）' : ''}
            </p>
            {disk && (
              <p className={cn('win-caption', disk.warn ? 'text-[var(--critical)]' : 'text-muted-foreground')}>
                磁盘剩余 <span className="font-mono">{humanBytes(disk.freeBytes)}</span>
                {disk.warn ? `，低于更新阈值（${humanBytes(disk.minFreeBytes)}）—— 任务会在前置检查步骤失败` : ''}
              </p>
            )}
          </div>

          {disk?.warn && (
            <InfoBar
              severity="caution"
              title="磁盘余量不足"
              message="低于更新阈值时任务会在「前置检查」步骤直接失败（维护会自动解除）。建议先清理残留再更新。"
            />
          )}

          <div className="grid gap-1.5">
            <Label>输入 {UPDATE_CONFIRM} 以确认</Label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={UPDATE_CONFIRM}
              className="font-mono"
              autoFocus
              disabled={submitting}
              onKeyDown={(e) => e.key === 'Enter' && confirmed && submit()}
            />
            <p className="text-[10px] text-muted-foreground">
              更新会消耗较长时间（steamcmd 可能几十分钟），期间可任务面板查看进度或取消。
            </p>
          </div>

          {error && <p className="win-caption break-all text-[var(--critical)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={!confirmed || submitting}>
            {submitting && <Ring size={16} />}
            触发更新
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
