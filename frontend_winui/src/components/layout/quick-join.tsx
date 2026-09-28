// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Button } from '@/components/winui/button'
import { Input } from '@/components/winui/input'
import { useArena } from '@/stores/arena'

/** 房间码加入表单（导航栏命令区 / 首页共用），WinUI 输入框 + 标准按钮 */
export function JoinCodeForm({ size = 'default', className }: { size?: 'default' | 'lg'; className?: string }) {
  const joinRoom = useArena((s) => s.joinRoom)
  const navigate = useNavigate()
  const [code, setCode] = useState('')

  const handleJoin = async () => {
    if (!code.trim()) return
    const roomId = await joinRoom(code.trim())
    if (roomId) navigate(`/room/${roomId}`)
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        className={cn(
          'text-center font-mono uppercase tracking-[0.2em]',
          size === 'lg' && 'h-10 py-2 tracking-[0.25em]',
        )}
        placeholder="房间码"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
        maxLength={6}
      />
      <Button size={size === 'lg' ? 'lg' : 'default'} onClick={handleJoin}>
        加入
      </Button>
    </div>
  )
}
