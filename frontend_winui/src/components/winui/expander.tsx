// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// WinUI Expander：头部一行可点，展开后显示内容；受控/非受控均可
function Expander({
  className,
  header,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: Omit<React.ComponentProps<'div'>, 'onChange'> & {
  header: React.ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [internal, setInternal] = React.useState(defaultOpen)
  const isOpen = open ?? internal

  const toggle = () => {
    const next = !isOpen
    if (open === undefined) setInternal(next)
    onOpenChange?.(next)
  }

  return (
    <div className={cn('win-card overflow-hidden', className)} {...props}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        className="win-tile flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150', isOpen && 'rotate-90')}
        />
        <div className="min-w-0 flex-1">{header}</div>
      </button>
      {isOpen && <div className="border-t border-[var(--divider)] px-4 py-4">{children}</div>}
    </div>
  )
}

export { Expander }
