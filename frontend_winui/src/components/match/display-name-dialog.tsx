// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { Button } from '@/components/winui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input } from '@/components/winui/input'
import { DISPLAY_NAME_MAX, type Player, type Room } from '@/lib/types'
import { useArena } from '@/stores/arena'

interface Props {
  room: Room
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 改名目标：自己（需房间开启「允许玩家修改局内ID」）或管理员选中的房内玩家 */
  target: Player | null
}

/**
 * 「修改战局内显示的ID」ContentDialog：只有标题 + 一个 TextBox（WinUI 版式）+ 底部按钮。
 *
 * - 初值：从后端房间数据取 displayNames[steamId] —— **改过才回填**；没改过留空，
 *   此时框内以灰色占位符显示该玩家的 Steam 名（即「留空则用 Steam 名」的默认语义）
 * - 占位符＝目标玩家的账号昵称（Steam 名），所以不需要额外的字段标题说明改的是谁
 * - 保存：与账号昵称相同的输入按「没改过」处理（清空条目 → 回到账号昵称），避免留下同值僵尸条目；
 *   提交后由 store 调 POST /api/rooms/:id/display-name 并把返回的整间房间写回 store（随 room:update 广播全体）
 * - 失败（未开启开关 / 非管理员改他人 / 名字非法）由 store toast，弹窗保持打开便于修改重试
 */
export function RoomDisplayNameDialog({ room, open, onOpenChange, target }: Props) {
  const setDisplayName = useArena((s) => s.setDisplayName)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const targetId = target?.steamId ?? ''

  // 每次打开（或换目标）以房间当前值为初值；
  // 依赖里刻意不放 room.displayNames —— 房间推送不应冲掉正在编辑的内容
  useEffect(() => {
    if (!open || !target) return
    setValue(room.displayNames?.[target.steamId] || '')
    setSaving(false)
  }, [open, targetId, room.id])

  const handleSave = async () => {
    if (!target) return
    const trimmed = value.trim()
    setSaving(true)
    const ok = await setDisplayName(room.id, trimmed === target.name ? '' : trimmed, target.steamId)
    setSaving(false)
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>修改战局内显示的ID</DialogTitle>
        </DialogHeader>
        <Input
          id="display-name-input"
          // 视觉上不再有字段标题（需求：弹窗只留标题 + 文本框），给读屏留一个名字
          aria-label="局内ID"
          value={value}
          placeholder={target?.name}
          maxLength={DISPLAY_NAME_MAX}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        />
        <DialogFooter>
          <Button variant="subtle" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
