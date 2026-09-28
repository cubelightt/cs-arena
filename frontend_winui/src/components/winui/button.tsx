// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// WinUI 按钮语义：Standard（默认）/ Accent（强调，主操作）/ Subtle（无边框）/ Hyperlink
const buttonVariants = cva('win-btn cursor-pointer', {
  variants: {
    variant: {
      default: 'win-btn-accent',
      accent: 'win-btn-accent',
      secondary: '',
      outline: '',
      ghost: 'win-btn-subtle',
      subtle: 'win-btn-subtle',
      destructive: 'win-btn-danger',
      link: 'win-btn-link',
    },
    size: {
      default: '',
      sm: 'min-h-6 px-2 py-0.5 text-xs leading-4',
      lg: 'min-h-10 px-4 py-2',
      icon: 'w-8 min-h-8 p-0',
      'icon-sm': 'w-6 min-h-6 p-0',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
})

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
