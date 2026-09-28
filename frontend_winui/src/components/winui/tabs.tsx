// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

// WinUI SelectorBar：分段选择器，选中项实心浮起 + 加粗
const Tabs = TabsPrimitive.Root

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex flex-wrap items-center gap-1 rounded-lg border border-[var(--card-stroke)] bg-[var(--subtle-secondary)] p-1',
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'win-body inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-md px-3 whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-[var(--subtle-secondary)] data-[state=active]:bg-[var(--solid-quarternary)] data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-sm disabled:pointer-events-none disabled:text-[var(--text-disabled)]',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('mt-4 outline-none', className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
