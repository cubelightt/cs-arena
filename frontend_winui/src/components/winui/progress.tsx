// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { cn } from '@/lib/utils'

// WinUI ProgressBar：4px 轨道 + 强调色填充；indeterminate 时滑块来回扫过
function Progress({
  className,
  value = 0,
  indeterminate = false,
  ...props
}: React.ComponentProps<'div'> & { value?: number; indeterminate?: boolean }) {
  const clamped = Math.min(100, Math.max(0, value))
  return (
    <div
      className={cn('win-progress', indeterminate && 'win-progress-indeterminate', className)}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : clamped}
      {...props}
    >
      {indeterminate && <span className="win-progress-dot" />}
      <span style={indeterminate ? undefined : { width: `${clamped}%` }} />
    </div>
  )
}

/**
 * WinUI ProgressRing：环形不确定进度。
 * 浅灰轨道 + 强调色圆弧，圆弧边转圈边伸缩（WinUI 的不确定环就是「一小段弧扫过并生长/收回」，
 * 而不是等长弧原地旋转）。用 SVG 描边实现：viewBox 固定 20×20，`size` 只改渲染尺寸。
 */
function Ring({ className, size = 20, ...props }: Omit<React.ComponentProps<'svg'>, 'width' | 'height'> & { size?: number }) {
  return (
    <svg
      className={cn('win-ring', className)}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      role="progressbar"
      aria-label="进行中"
      {...props}
    >
      <circle className="win-ring-track" cx="10" cy="10" r="8.5" fill="none" strokeWidth="2" />
      <circle className="win-ring-arc" cx="10" cy="10" r="8.5" fill="none" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export { Progress, Ring }
