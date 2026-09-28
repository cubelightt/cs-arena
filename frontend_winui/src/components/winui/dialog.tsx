// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

// WinUI ContentDialog：Tertiary 实心底 + 8px 圆角 + 30% 遮罩，标题 Subtitle 字号
const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn('fixed inset-0 z-[60] win-overlay', className)} {...props} />
}

function DialogContent({
  className,
  children,
  size = 'default',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { size?: 'default' | 'wide' }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'win-dialog win-anim-dialog fixed left-1/2 top-1/2 z-[60] grid max-h-[85vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto p-6 shadow-2xl',
          size === 'wide' ? 'max-w-[720px]' : 'max-w-[548px]',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="win-btn win-btn-subtle absolute right-4 top-4 size-8 cursor-pointer justify-center p-0 text-muted-foreground">
          <X className="size-4" />
          <span className="sr-only">关闭</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 pr-10', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end', className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('win-subtitle', className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('win-body text-muted-foreground', className)} {...props} />
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
