// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import {
  PROVISION_META,
  instanceSourceLabel,
  type InstanceSource,
  type ProvisionState,
} from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * 实例的共用渲染件：供给状态徽章 / 来源徽章 / 失败原因行。
 * 「实例管理」Tab 的卡片与「服务器组」Tab 的实例清单共用，字段定义见 src/lib/types.ts。
 */

/** 供给状态徽章（null = 正常，无徽章）；`error` 非空时用原生 title 悬浮出原因 */
export function ProvisionBadge({
  state,
  error,
  className,
}: {
  state: ProvisionState | null
  error?: string | null
  className?: string
}) {
  if (!state) return null
  const meta = PROVISION_META[state]
  return (
    <Badge
      variant={meta.variant}
      className={className}
      title={error ? `${meta.hint}\n${error}` : meta.hint}
      data-provision={state}
    >
      {meta.label}
    </Badge>
  )
}

/** 实例来源徽章（面板创建 / 主机侧创建 / 首次种子）；未知来源不渲染 */
export function InstanceSourceBadge({
  source,
  className,
}: {
  source: InstanceSource | null
  className?: string
}) {
  const label = instanceSourceLabel(source)
  if (!label) return null
  return (
    <Badge variant={source === 'bridge_report' ? 'info' : 'secondary'} className={cn('font-normal', className)}>
      {label}
    </Badge>
  )
}

/** 供给失败原因行（provisionError 非空时红字；卡片与服务器组清单共用） */
export function ProvisionErrorLine({ error, className }: { error: string | null; className?: string }) {
  if (!error) return null
  return (
    <p className={cn('win-caption flex items-start gap-1.5 text-[var(--critical)]', className)} title={error}>
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span className="break-all">{error}</span>
    </p>
  )
}
