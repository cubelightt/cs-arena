// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { cn } from '@/lib/utils'

// WinUI 卡片：CardBackgroundFillColorDefault + CardStrokeColorDefault + 8px 圆角
function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('win-card', className)} {...props} />
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-5', className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('win-body-strong', className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('win-caption text-muted-foreground', className)} {...props} />
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-2 p-5 pt-0', className)} {...props} />
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
