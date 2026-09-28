// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import * as React from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * WinUI NumberBox（整数版）：右侧内联微调按钮（SpinButtonPlacementMode=Inline）。
 * - 规格取自 microsoft-ui-xaml：UpSpinButton/DownSpinButton 并排两列、各 MinWidth 32，
 *   分隔线用 NumberBoxSpinButtonBorderThickness(0,1,1,1)
 * - 提交时机 = 失焦 / 回车 / 微调按钮 / ↑↓ 键；非法输入（空、非数字）回退到上一次的值，
 *   越界夹取到 [min,max]（对应 WinUI 的 ValidationMode=InvalidInputOverwritten）
 * - 微调按钮不进 Tab 序（与输入框的 ↑↓ 键等价），避免键盘用户多两次 Tab 停留
 * - spinButtons=false 为无微调按钮的紧凑变体（纯输入框，↑↓ 键仍可步进）；
 *   配合 win-numberbox--sm（24px 高）用于与行内文字混排的场景
 */
function NumberBox({
  className,
  value,
  onValueChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  disabled,
  id,
  spinButtons = true,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'> & {
  value: number
  /** 提交时回调（值已取整并夹取到 [min,max]） */
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** 是否显示右侧内联微调按钮（默认显示；关闭后为纯输入框紧凑变体） */
  spinButtons?: boolean
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))
  const [text, setText] = React.useState(String(value))

  // 外部值变化（含回滚/服务端回读）时同步显示，但不打断正在编辑的输入
  const [editing, setEditing] = React.useState(false)
  React.useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])

  const commit = (raw: string) => {
    const n = Number(raw.trim())
    const next = raw.trim() === '' || !Number.isFinite(n) ? value : clamp(n)
    setText(String(next))
    if (next !== value) onValueChange(next)
    return next
  }

  const bump = (delta: number) => {
    // 注意不能用 `Number(text) || value`：0 是合法值但 falsy
    const typed = Number(text.trim())
    const base = text.trim() !== '' && Number.isFinite(typed) ? typed : value
    const next = clamp(base + delta)
    setText(String(next))
    if (next !== value) onValueChange(next)
  }

  return (
    <div className={cn('win-numberbox', !spinButtons && 'win-numberbox--plain', className)}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        role="spinbutton"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        className="win-field font-mono"
        value={text}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setEditing(false)
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value)
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setText(String(value))
            e.currentTarget.blur()
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            bump(step)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            bump(-step)
          }
        }}
        {...props}
      />
      {spinButtons && (
        <div className="win-numberbox-spin">
          <button
            type="button"
            tabIndex={-1}
            aria-label="增加"
            disabled={disabled || value >= max}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bump(step)}
          >
            <ChevronUp className="size-3" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="减少"
            disabled={disabled || value <= min}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bump(-step)}
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}

export { NumberBox }
