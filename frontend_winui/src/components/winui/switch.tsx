// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { cn } from '@/lib/utils'

// WinUI ToggleSwitch：轨道 40×20、旋钮 12px；渲染为 checkbox 以复用原生行为
function Switch({ className, ...props }: React.ComponentProps<'input'>) {
  return <input type="checkbox" className={cn('win-switch', className)} {...props} />
}

function Checkbox({ className, ...props }: React.ComponentProps<'input'>) {
  return <input type="checkbox" className={cn('win-checkbox', className)} {...props} />
}

function Radio({ className, ...props }: React.ComponentProps<'input'>) {
  return <input type="radio" className={cn('win-radio', className)} {...props} />
}

export { Switch, Checkbox, Radio }
