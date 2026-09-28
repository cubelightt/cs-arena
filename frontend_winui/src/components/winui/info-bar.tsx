// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { CircleCheck, Info, TriangleAlert, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type InfoBarSeverity = 'info' | 'success' | 'caution' | 'critical'

const ICONS: Record<InfoBarSeverity, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CircleCheck,
  caution: TriangleAlert,
  critical: XCircle,
}

const ICON_COLOR: Record<InfoBarSeverity, string> = {
  info: 'text-[var(--accent-text)]',
  success: 'text-[var(--success)]',
  caution: 'text-[var(--caution)]',
  critical: 'text-[var(--critical)]',
}

// WinUI InfoBar：语义色底 + 图标 + 标题/正文 + 可选操作与关闭
function InfoBar({
  className,
  severity = 'info',
  title,
  message,
  action,
  trailing,
  onClose,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  severity?: InfoBarSeverity
  title?: React.ReactNode
  message?: React.ReactNode
  action?: React.ReactNode
  /** 最右侧的附加内容（如进行中的 ProgressRing），与关闭按钮同处尾部 */
  trailing?: React.ReactNode
  onClose?: () => void
}) {
  const Icon = ICONS[severity]
  return (
    <div className={cn('win-infobar items-start', className)} data-severity={severity} {...props}>
      <Icon className={cn('mt-0.5 size-5 shrink-0', ICON_COLOR[severity])} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title && <div className="win-body-strong">{title}</div>}
        {/* 正文用主文本色：WinUI 的 InfoBarMessageForeground = TextFillColorPrimaryBrush，
            语义色只落在背景与图标上 —— 正文若降级为淡色，在 success/caution 底色上会糊成一片 */}
        {message && <div className="win-body">{message}</div>}
        {children}
        {action && <div className="mt-1 flex items-center gap-2">{action}</div>}
      </div>
      {trailing && <div className="flex shrink-0 items-center self-center">{trailing}</div>}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="win-btn win-btn-subtle size-6 shrink-0 cursor-pointer justify-center p-0"
          aria-label="关闭通知"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export { InfoBar }
