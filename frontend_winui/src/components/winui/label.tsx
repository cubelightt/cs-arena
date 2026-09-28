// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cn } from '@/lib/utils'

// WinUI 表单标签：Body Strong 字号，位于控件上方
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('win-body-strong block text-foreground peer-disabled:text-muted-foreground', className)}
      {...props}
    />
  )
}

/** 分组小标题（WinUI「设置」式分区标题） */
function SectionLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('win-meta', className)} {...props} />
}

export { Label, SectionLabel }
