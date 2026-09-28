// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { Ring } from '@/components/winui/progress'
import { MarkdownBlocks } from '@/components/layout/markdown'
import { cn } from '@/lib/utils'

export type ContentState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; markdown: string }

/**
 * 首页内容卡：固定头部（可选）+ 内容区内部滚动（不撑长页面）。
 * 内容来自后端（首页内容接口），markdown 子集渲染见 components/layout/markdown.tsx。
 */
export function MarkdownCard({
  className,
  title,
  icon: Icon,
  state,
  onRetry,
}: {
  className?: string
  title?: string
  icon?: LucideIcon
  state: ContentState
  onRetry?: () => void
}) {
  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      {title && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--divider)] px-4 py-3">
          {Icon && <Icon className="size-4 text-[var(--accent-text)]" aria-hidden />}
          <span className="win-body-strong">{title}</span>
        </div>
      )}
      <div className="max-h-[60vh] min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:max-h-none">
        {state.status === 'loading' && (
          <div className="flex h-full items-center justify-center gap-2 py-6 text-muted-foreground">
            <Ring size={20} />
            <span className="win-caption">加载中…</span>
          </div>
        )}
        {state.status === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-6">
            <span className="win-caption text-muted-foreground">内容加载失败</span>
            {onRetry && (
              <Button variant="subtle" size="sm" onClick={onRetry}>
                重试
              </Button>
            )}
          </div>
        )}
        {state.status === 'ok' && state.markdown.trim() !== '' && <MarkdownBlocks source={state.markdown} />}
      </div>
    </Card>
  )
}
