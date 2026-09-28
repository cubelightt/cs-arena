// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/winui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { InfoBar } from '@/components/winui/info-bar'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Ring } from '@/components/winui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/winui/select'
import { ApiError, api } from '@/lib/api'
import {
  INSTANCE_NAME_HINT,
  INSTANCE_NAME_RE,
  type GameServerGroup,
  type InstanceCreateResponse,
  type Job,
} from '@/lib/types'

/**
 * 「新建实例」弹窗（POST /api/instances）：实例名 + 所属组（仅激活组）+ 端口（留空 = 主机自动分配）
 * + 模板实例（留空 = 桥侧默认 main，下拉列该组实例）。
 * 4xx/5xx 一律落在弹窗内联红字（非法名/重名/组未激活不关窗；组内已有任务给「查看任务」入口；
 * 旧桥 502 追加升级指引），不弹全局错误。
 */

/** Radix Select 不接受空字符串 value：用哨兵表示「留空 = 默认」 */
const DEFAULT_OPTION = '__default__'

export function InstanceCreateDialog({
  open,
  groups,
  defaultName,
  onOpenChange,
  onSubmitted,
  onOpenJobs,
}: {
  open: boolean
  /** 服务器组清单（GET /api/game-servers，含未激活组；弹窗只列 isActive） */
  groups: GameServerGroup[]
  /** 预填实例名（失败卡片「重试」用：同名提交会被后端复用预留行） */
  defaultName?: string
  onOpenChange: (v: boolean) => void
  onSubmitted: (job: Job, instanceName: string) => void
  /** 组内已有进行中任务（409）时的「查看任务」入口 */
  onOpenJobs?: (jobId: number | null) => void
}) {
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState('')
  const [port, setPort] = useState('')
  const [cloneFrom, setCloneFrom] = useState(DEFAULT_OPTION)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const activeGroups = useMemo(() => groups.filter((g) => g.isActive), [groups])
  const group = activeGroups.find((g) => g.id === groupId) ?? null

  // 用于打开弹窗时选默认组：列表经 5s 轮询刷新，不该冲掉用户已填内容 —— 故只读不依赖
  const activeGroupsRef = useRef(activeGroups)
  activeGroupsRef.current = activeGroups

  // 模板实例：该组内可用作克隆源的实例（供给中的不能用；同名实例本身要排除）
  const templates = useMemo(
    () => (group?.instances ?? []).filter((i) => i.provisionState == null && i.name !== name.trim()),
    [group, name],
  )

  useEffect(() => {
    if (!open) return
    setName(defaultName ?? '')
    setGroupId(activeGroupsRef.current[0]?.id ?? '')
    setPort('')
    setCloneFrom(DEFAULT_OPTION)
    setError('')
    setSubmitting(false)
  }, [open, defaultName])

  const trimmedName = name.trim()
  const nameInvalid = trimmedName !== '' && !INSTANCE_NAME_RE.test(trimmedName)
  const portInvalid = port.trim() !== '' && !(Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535)
  const canSubmit = trimmedName !== '' && INSTANCE_NAME_RE.test(trimmedName) && !!groupId && !portInvalid

  const submit = async () => {
    if (!canSubmit) {
      setError(
        trimmedName === ''
          ? '请填写实例名'
          : !INSTANCE_NAME_RE.test(trimmedName)
            ? `实例名非法（${INSTANCE_NAME_HINT}）`
            : !groupId
              ? '请选择所属服务器组'
              : `端口需为 1~65535 的整数（留空表示由主机自动分配）`,
      )
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await api.post<InstanceCreateResponse>('/api/instances', {
        name: trimmedName,
        gameServerId: groupId,
        ...(port.trim() ? { port: Number(port) } : {}),
        ...(cloneFrom !== DEFAULT_OPTION ? { cloneFrom } : {}),
      })
      onSubmitted(res.task, trimmedName)
      onOpenChange(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 旧桥（502）额外给升级指引；其余按后端原文提示（重名/组未激活/名字非法都留在弹窗内）
      const legacy = e instanceof ApiError && e.status === 502 && msg.includes('未声明 jobs 能力')
      setError(legacy ? `${msg}——升级到 v2 桥（见 backend/agent/v2）后可用` : msg)
    } finally {
      setSubmitting(false)
    }
  }

  const jobConflict = error.match(/已有进行中任务(?:\(job (\d+)\))?/)

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建实例</DialogTitle>
          <DialogDescription>
            主机侧按 7 步创建（前置检查 → msm clone → 清 SwiftlyS2 → 拷插件树 → 共享 steamapps →
            回读端口 + 写编号 → 完成）。创建期间卡片显示「创建中」且不可启停/删除，端口与编号由主机回读。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>实例名</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="arena1"
              className="font-mono"
              autoFocus
              disabled={submitting}
              onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
            />
            <p className="text-[10px] text-muted-foreground">
              必填，规则 <code className="font-mono">{INSTANCE_NAME_HINT}</code>；重名（除上次失败的同名行）会被拒绝。
            </p>
            {nameInvalid && (
              <p className="win-caption text-[var(--critical)]">实例名非法：{INSTANCE_NAME_HINT}</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>所属组</Label>
            {activeGroups.length === 0 ? (
              <InfoBar severity="caution" message="没有可用的服务器组：只有已激活（isActive）的组可以新建实例。" />
            ) : (
              <Select value={groupId} onValueChange={setGroupId} disabled={submitting}>
                <SelectTrigger>
                  <SelectValue placeholder="选择服务器组" />
                </SelectTrigger>
                <SelectContent>
                  {activeGroups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}（{g.id}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>端口（可选）</Label>
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="留空 = 由主机自动分配"
              className="font-mono"
              inputMode="numeric"
              disabled={submitting}
            />
            {portInvalid && (
              <p className="win-caption text-[var(--critical)]">端口需为 1~65535 的整数（留空表示由主机自动分配）</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>模板实例（可选）</Label>
            <Select value={cloneFrom} onValueChange={setCloneFrom} disabled={submitting || !group}>
              <SelectTrigger>
                <SelectValue placeholder="默认 main" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_OPTION}>默认（main）</SelectItem>
                {templates.map((i) => (
                  <SelectItem key={i.name} value={i.name}>
                    {i.idx != null ? `#${i.idx} ` : ''}
                    {i.name}
                    {i.port ? ` :${i.port}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              留空 = 由主机用默认实例 {group ? `（该组当前 ${templates.length} 个可用作模板）` : 'main'}。
            </p>
          </div>

          {error && (
            <div className="flex flex-col gap-2">
              <p className="win-caption break-all text-[var(--critical)]">{error}</p>
              {jobConflict && onOpenJobs && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    onOpenChange(false)
                    onOpenJobs(jobConflict[1] ? Number(jobConflict[1]) : null)
                  }}
                >
                  查看任务
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit || submitting}>
            {submitting && <Ring size={16} />}
            创建实例
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
