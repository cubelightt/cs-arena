// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { cn } from '@/lib/utils'

// WinUI TextBox：32px 高、4px 圆角、聚焦时底边强调色描边
function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn('win-field', className)} {...props} />
}

function PasswordInput({ className, ...props }: React.ComponentProps<'input'>) {
  return <input type="password" className={cn('win-field', className)} {...props} />
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn('win-field', className)} {...props} />
}

export { Input, PasswordInput, Textarea }
