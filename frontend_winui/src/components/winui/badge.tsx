// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// WinUI 徽章：4px 圆角 + Caption 字号（对齐 InfoBadge 语气，不做药丸形）
const badgeVariants = cva('win-badge', {
  variants: {
    variant: {
      default: 'win-badge-accent',
      secondary: '',
      outline: 'bg-transparent',
      success: 'win-badge-success',
      caution: 'win-badge-caution',
      /** 实心警示底：与柔和 caution 徽章并存时用于区分（如实例「待确认」vs「删除中」） */
      cautionSolid: 'win-badge-caution-solid',
      destructive: 'win-badge-critical',
      info: 'bg-transparent text-[var(--accent-text)] border-[var(--accent)]/30',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
