// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/winui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Radio } from '@/components/winui/switch'
import type { MatchType, RoomModeAvailability } from '@/lib/types'
import { api } from '@/lib/api'
import { useArena } from '@/stores/arena'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 建房模式：custom/duel 为普通房间；botmode=增强人机（提交时 matchType=custom + botMode:true）
type CreateMode = MatchType | 'botmode'

const TYPES: { value: CreateMode; title: string; desc: string }[] = [
  {
    value: 'custom',
    title: '自定义竞技',
    desc: '默认 5v5，房主可在房间设置中分别调整双方人数，支持 BO1/BO3 与 BP 选图',
  },
  {
    value: 'duel',
    title: '单挑对决',
    desc: '1v1 对战，支持设置观战席',
  },
  {
    value: 'botmode',
    title: '增强人机',
    desc: '与修改后的职业BOT对战，仅部分实例可用',
  },
]

const DEFAULT_MODE_AVAILABILITY: RoomModeAvailability = { custom: true, duel: true, botMode: true }

function modeIsAvailable(availability: RoomModeAvailability, mode: CreateMode) {
  return availability[mode === 'botmode' ? 'botMode' : mode]
}

export function CreateRoomDialog({ open, onOpenChange }: Props) {
  const createRoom = useArena((s) => s.createRoom)
  const currentUser = useArena((s) => s.currentUser)
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [createMode, setCreateMode] = useState<CreateMode>('custom')
  const [modeAvailability, setModeAvailability] = useState(DEFAULT_MODE_AVAILABILITY)
  const isAdmin = currentUser?.isAdmin === true

  // 打开弹窗时默认填入「玩家昵称的房间」，可修改
  useEffect(() => {
    if (open) {
      setName(currentUser ? `${currentUser.name}的房间` : '')
    }
  }, [open, currentUser])

  useEffect(() => {
    if (!open) return
    let active = true
    api
      .get<RoomModeAvailability>('/api/settings/room-modes')
      .then((settings) => active && setModeAvailability(settings))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (isAdmin || modeIsAvailable(modeAvailability, createMode)) return
    const firstAvailable = TYPES.find((t) => modeIsAvailable(modeAvailability, t.value))
    if (firstAvailable) setCreateMode(firstAvailable.value)
  }, [createMode, isAdmin, modeAvailability])

  const canSubmit = name.trim().length > 0 && (isAdmin || modeIsAvailable(modeAvailability, createMode))

  const handleCreate = async () => {
    if (!canSubmit) return
    try {
      const room = await createRoom(
        createMode === 'botmode'
          ? { name: name.trim(), matchType: 'custom', botMode: true }
          : { name: name.trim(), matchType: createMode },
      )
      onOpenChange(false)
      setName('')
      setCreateMode('custom')
      navigate(`/room/${room.id}`)
    } catch {
      /* 错误已由统一 toast 提示 */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建房间</DialogTitle>
          <DialogDescription>填入房间名称并选择比赛类型，其余设置可在房间内修改</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="room-name">房间名称</Label>
            <Input
              id="room-name"
              placeholder="例如：周末 5v5 开黑"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>

          <div className="grid gap-2">
            <Label>比赛类型</Label>
            <div className="flex flex-col gap-2" role="radiogroup">
              {TYPES.map((t) => {
                const active = createMode === t.value
                const disabled = !isAdmin && !modeIsAvailable(modeAvailability, t.value)
                return (
                  <label
                    key={t.value}
                    className={cn(
                      'win-tile flex items-start gap-3 p-3',
                      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                      active && 'bg-[var(--subtle-secondary)]',
                    )}
                  >
                    <Radio
                      name="create-mode"
                      className="mt-0.5"
                      checked={active}
                      disabled={disabled}
                      onChange={() => !disabled && setCreateMode(t.value)}
                    />
                    <span className="min-w-0">
                      <span className="win-body-strong block">{t.title}</span>
                      <span className="win-caption mt-0.5 block text-muted-foreground">{t.desc}</span>
                      {disabled && <span className="win-caption mt-1 block text-[var(--critical)]">管理员已关闭此模式</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleCreate} disabled={!canSubmit}>
            创建房间
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
