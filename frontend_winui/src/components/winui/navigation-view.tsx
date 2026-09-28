// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { cn } from '@/lib/utils'

/** WinUI NavigationViewItem：36px 高、4px 圆角、选中时左侧 3×16 强调色指示条 */
function NavigationItem({
  className,
  active = false,
  icon,
  children,
  ...props
}: React.ComponentProps<'div'> & { active?: boolean; icon?: React.ReactNode }) {
  return (
    <div data-active={active} className={cn('win-nav-item outline-none', className)} {...props}>
      {icon && <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  )
}

/** 导航分组标题 */
function NavigationHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('win-meta px-3 pt-4 pb-2', className)} {...props} />
}

export { NavigationItem, NavigationHeader }
