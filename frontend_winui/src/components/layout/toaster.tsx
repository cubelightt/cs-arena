// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { CircleCheck, Info, XCircle } from 'lucide-react'
import { useArena } from '@/stores/arena'
import { cn } from '@/lib/utils'

const SEVERITY = {
  default: { icon: Info, color: 'var(--accent-text)' },
  success: { icon: CircleCheck, color: 'var(--success)' },
  error: { icon: XCircle, color: 'var(--critical)' },
} as const

// 通知栈：WinUI 风格的实心卡片 + 语义色图标，点击即关
export function Toaster() {
  const toasts = useArena((s) => s.toasts)
  const dismiss = useArena((s) => s.dismissToast)

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const { icon: Icon, color } = SEVERITY[t.variant] ?? SEVERITY.default
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className="win-dialog win-anim-toast pointer-events-auto flex cursor-pointer items-start gap-3 p-3 text-left shadow-xl"
          >
            <Icon className={cn('mt-0.5 size-5 shrink-0')} style={{ color }} />
            <span className="min-w-0 flex-1">
              <span className="win-body-strong block">{t.title}</span>
              {t.description && (
                <span className="win-caption mt-0.5 block break-all text-muted-foreground">{t.description}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
