// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { Button } from '@/components/winui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Ring } from '@/components/winui/progress'
import { ApiError, api } from '@/lib/api'
import type { InstanceDeleteResponse, InstanceItem, Job } from '@/lib/types'

/**
 * 「删除实例」二次确认弹窗（DELETE /api/instances/:name，body `{confirm:"<实例名>"}`）：
 * 要求**手工输入实例名**（后端也精确校验），文案写明不可恢复 / 不留备份 / 编号不回收。
 * 4xx 一律内联红字（使用中 409 → 提示先停实例，按钮保持可用；400 确认串不匹配不关窗）。
 */
export function InstanceDeleteDialog({
  open,
  instance,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean
  instance: InstanceItem | null
  onOpenChange: (v: boolean) => void
  onSubmitted: (job: Job, instanceName: string) => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const name = instance?.name ?? ''
  const confirmed = text.trim() !== '' && text.trim() === name

  useEffect(() => {
    if (!open) return
    setText('')
    setError('')
    setSubmitting(false)
  }, [open, name])

  const submit = async () => {
    if (!instance || !confirmed) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.del<InstanceDeleteResponse>(`/api/instances/${encodeURIComponent(instance.name)}`, {
        confirm: instance.name,
      })
      onSubmitted(res.task, instance.name)
      onOpenChange(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 使用中（409 in_match/cooling 等）与组内已有任务：按后端原文提示，弹窗不关、按钮仍可用
      const inUse = e instanceof ApiError && e.status === 409 && /使用中|进行中的比赛/.test(msg)
      setError(inUse ? `${msg}——请先停止该实例（或用「锁复位」清理异常锁）后重试` : msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>删除实例 {name}</DialogTitle>
          <DialogDescription>
            主机侧会先停止该实例，再删除<b>实例目录与配置目录</b>（<b>不可恢复、不留备份</b>）；
            <b>共享工坊图不受影响</b>；实例编号<b>作废不回收</b>（后续新建不会复用该编号）。
            删除期间卡片显示「删除中」，任务成功结束后卡片消失。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {instance?.provisionState === 'unconfirmed' && (
            <p className="win-caption text-[var(--caution)]">
              该实例由主机侧创建且尚未确认：删除会直接清掉主机上的实例目录。
            </p>
          )}
          <div className="grid gap-1.5">
            <Label>输入实例名 {name} 以确认</Label>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={name}
              className="font-mono"
              autoFocus
              disabled={submitting}
              onKeyDown={(e) => e.key === 'Enter' && confirmed && submit()}
            />
            <p className="text-[10px] text-muted-foreground">需与实例名完全一致（区分大小写）。</p>
          </div>
          {error && <p className="win-caption break-all text-[var(--critical)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!confirmed || submitting}>
            {submitting && <Ring size={16} />}
            删除实例
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
