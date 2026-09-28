// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

// WinUI ComboBox：控件填充底 + 底部描边，选中项左侧强调色指示条
const Select = SelectPrimitive.Root
const SelectGroup = SelectPrimitive.Group

// 取值文本需可伸缩：flex 容器里必须 min-w-0 + flex-1，否则 truncate 会把宽度压成 0（表现为空下拉框）
function SelectValue({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value className={cn('min-w-0 flex-1 truncate text-left', className)} {...props} />
}

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'win-field flex cursor-pointer items-center justify-between gap-2 text-left whitespace-nowrap disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={4}
        // z-[70]：浮出层必须高于 ContentDialog(z-[60])，否则对话框内的 ComboBox 展开会被盖住
        // （层级表见 styles/winui.css「覆盖层」注释）
        // min-w 跟随触发器宽度：WinUI 的 ComboBox 下拉至少与控件同宽（条目更长时按内容撑开）
        className={cn(
          'win-flyout win-anim-flyout z-[70] max-h-80 min-w-[8rem] min-w-[var(--radix-select-trigger-width)] overflow-hidden shadow-xl',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="flex flex-col">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn('win-flyout-item relative pr-8 outline-none select-none', className)}
      {...props}
    >
      <span className="absolute left-0 top-1/2 hidden h-4 w-[3px] -translate-y-1/2 rounded-sm bg-[var(--accent)] data-[state=checked]:block" />
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4 text-[var(--accent-text)]" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem }
