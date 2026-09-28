// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { Button } from '@/components/winui/button'
import { Checkbox } from '@/components/winui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Ring } from '@/components/winui/progress'
import { api } from '@/lib/api'
import type { InstanceItem } from '@/lib/types'
import { useArena } from '@/stores/arena'

/**
 * 「编辑实例」弹窗（2026-09-23 用户需求）：把原先散在卡片上的「仅管理员可选」与「删除实例」收进弹窗，
 * 并补上端口编辑（服务器组弹窗不再维护实例列表后，这里是唯一的端口入口）。
 *
 * 契约：`PUT /api/instances/:name` body `{ port?, adminOnly? }`（仅管理员）
 * —— 端口 1~65535，且不得与其他实例的游戏端口 / GOTV 端口（= 端口+100）冲突（同一主机共享端口空间）；
 * 供给中（创建/删除/待确认）不允许改端口（桥侧任务回读会覆盖）。删除仍走既有的二次确认弹窗（输入实例名）。
 */
export function InstanceEditDialog({
  open,
  instance,
  onOpenChange,
  onSaved,
  onRequestDelete,
}: {
  open: boolean
  instance: InstanceItem | null
  onOpenChange: (v: boolean) => void
  onSaved: () => void | Promise<void>
  /** 点「删除实例」：交给外层关闭本弹窗并打开删除确认弹窗（保留输入实例名的二次确认） */
  onRequestDelete: (inst: InstanceItem) => void
}) {
  const toast = useArena((s) => s.toast)
  const [port, setPort] = useState('')
  const [adminOnly, setAdminOnly] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !instance) return
    setPort(instance.port ? String(instance.port) : '')
    setAdminOnly(!!instance.adminOnly)
    setError('')
    setSaving(false)
  }, [open, instance])

  const provisionHint = instance?.provisionState
    ? '供给中（创建/删除/待确认）：完成后才能改端口'
    : undefined

  const save = async () => {
    if (!instance) return
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      setError('端口需为 1~65535 的整数')
      return
    }
    const body: { port?: number; adminOnly?: boolean } = {}
    if (n !== instance.port) body.port = n
    if (adminOnly !== !!instance.adminOnly) body.adminOnly = adminOnly
    if (Object.keys(body).length === 0) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    setError('')
    try {
      await api.put(`/api/instances/${instance.name}`, body)
      toast('实例已更新', `${instance.name}${body.port ? ` · 端口 ${body.port}` : ''}`, 'success')
      await onSaved()
      onOpenChange(false)
    } catch (e) {
      // 4xx 内联展示（端口冲突/供给中），留在弹窗便于改
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>编辑实例 {instance?.name ?? ''}</DialogTitle>
          <DialogDescription>端口与分级即时生效；删除实例不可恢复（需二次确认）。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>实例名</Label>
            <Input value={instance?.name ?? ''} readOnly disabled className="font-mono" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="inst-edit-port">端口 *</Label>
            <Input
              id="inst-edit-port"
              className="w-32 font-mono"
              value={port}
              inputMode="numeric"
              disabled={!!instance?.provisionState}
              title={provisionHint}
              onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))}
            />
            <p className="win-caption text-muted-foreground">
              GOTV 端口自动跟随（端口 + 100）；主机侧 <code className="font-mono">server.conf</code> 需同步改端口
            </p>
          </div>
          <div className="grid gap-1.5">
            <label className="flex w-fit cursor-pointer select-none items-center gap-2">
              <Checkbox checked={adminOnly} disabled={saving} onChange={(e) => setAdminOnly(e.target.checked)} />
              <span className="win-body-strong">仅管理员可选</span>
            </label>
            <p className="win-caption text-muted-foreground">开启后该实例不参与普通房主的自动分配与手动选择</p>
          </div>
          {error && <p className="win-caption text-[var(--critical)]">{error}</p>}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            className="text-[var(--critical)]"
            disabled={saving || !instance || instance?.provisionState === 'creating' || instance?.provisionState === 'deleting'}
            onClick={() => instance && onRequestDelete(instance)}
          >
            删除实例
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving || !!instance?.provisionState}>
              {saving && <Ring size={16} />}
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
