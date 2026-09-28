// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { Crown, MoreVertical, RefreshCw, UserPlus, UserX } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/winui/avatar'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/winui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/winui/tooltip'
import { useArena } from '@/stores/arena'
import type { PlayerSlot, Room, TeamSide } from '@/lib/types'
import { cn } from '@/lib/utils'

// 阵营标识色：CT 蓝 / T 橙（沿用 CS 语义，取 Fluent 明度）
const TEAM_META: Record<TeamSide, { dot: string }> = {
  ct: { dot: 'bg-[#4cc2ff]' },
  t: { dot: 'bg-[#f7a501]' },
}

function PlayerRow({
  slot,
  isHost,
  isCaptain,
  room,
  onRequestSwap,
  onTransferCaptain,
}: {
  slot: PlayerSlot
  isHost: boolean
  isCaptain: boolean
  room: Room
  onRequestSwap?: (playerId: string) => void
  onTransferCaptain?: (playerId: string) => void
}) {
  const currentUser = useArena((s) => s.currentUser)
  const kickPlayer = useArena((s) => s.kickPlayer)
  const movePlayer = useArena((s) => s.movePlayer)
  const me = slot.player.steamId === currentUser?.steamId
  const isHostUser = room.hostId === currentUser?.steamId

  return (
    <div className="win-tile group flex items-center gap-3 px-2 py-1.5">
      <Avatar className="size-8">
        <AvatarImage src={slot.player.avatarUrl} />
        <AvatarFallback>{slot.player.name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate">
          <span className={cn('win-body truncate', me && 'font-semibold text-[var(--accent-text)]')}>
            {slot.player.name}
          </span>
          {isHost && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Crown className="size-3.5 text-[var(--caution)]" />
                </span>
              </TooltipTrigger>
              <TooltipContent>房主</TooltipContent>
            </Tooltip>
          )}
          {isCaptain && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Badge variant="info">队长</Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent>阵营队长，负责 BP 选图</TooltipContent>
            </Tooltip>
          )}
        </p>
        <p className="win-caption truncate font-mono text-muted-foreground">{slot.player.steamId}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="subtle"
            size="icon-sm"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="玩家操作"
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {me && onRequestSwap && (
            <DropdownMenuItem onSelect={() => onRequestSwap(slot.player.steamId)}>
              <RefreshCw className="size-4" />
              申请换位
            </DropdownMenuItem>
          )}
          {me && isCaptain && onTransferCaptain && (
            <DropdownMenuItem onSelect={() => onTransferCaptain(slot.player.steamId)}>
              <Crown className="size-4" />
              移交队长
            </DropdownMenuItem>
          )}
          {slot.team !== 'spec' && (
            <DropdownMenuItem onSelect={() => movePlayer(room.id, slot.player.id, slot.team === 'ct' ? 't' : 'ct')}>
              <UserPlus className="size-4" />
              交换到{slot.team === 'ct' ? room.teamBName : room.teamAName}
            </DropdownMenuItem>
          )}
          {slot.team === 'spec' && isHostUser && (
            <>
              <DropdownMenuItem onSelect={() => movePlayer(room.id, slot.player.id, 'ct')}>
                <UserPlus className="size-4" />
                加入 {room.teamAName}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => movePlayer(room.id, slot.player.id, 't')}>
                <UserPlus className="size-4" />
                加入 {room.teamBName}
              </DropdownMenuItem>
            </>
          )}
          {isHostUser && slot.player.steamId !== currentUser?.steamId && (
            <DropdownMenuItem danger onSelect={() => kickPlayer(room.id, slot.player.id)}>
              <UserX className="size-4" />
              踢出房间
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** 比赛页对阵版式的单人条目：横着的长方体（不铺满），头像与名字同一水平线，头像贴外侧 */
function PlayerChip({ slot, side, room }: { slot: PlayerSlot; side: TeamSide; room: Room }) {
  const currentUser = useArena((s) => s.currentUser)
  const me = slot.player.steamId === currentUser?.steamId
  const isHost = room.hostId === slot.player.steamId
  const isCaptain = room.captainA === slot.player.steamId || room.captainB === slot.player.steamId
  // T 列在右侧：整条镜像（头像落到右边），两列因此左右对称地朝外
  const mirrored = side === 't'

  return (
    <div
      className={cn(
        // 去掉 steamid 后收窄加高：200×52 左右的长方体（窄屏按 w-full 收缩）
        'flex w-full max-w-[220px] min-w-0 items-center gap-2.5 rounded-[4px] bg-[var(--subtle-secondary)] px-3 py-2',
        mirrored && 'flex-row-reverse',
      )}
    >
      <Avatar className="size-9 shrink-0">
        <AvatarImage src={slot.player.avatarUrl} />
        <AvatarFallback>{slot.player.name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className={cn('win-body min-w-0 flex-1 truncate', me && 'font-semibold text-[var(--accent-text)]')}>
        {slot.player.name}
      </span>
      {isHost && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <Crown className="size-3.5 text-[var(--caution)]" />
            </span>
          </TooltipTrigger>
          <TooltipContent>房主</TooltipContent>
        </Tooltip>
      )}
      {isCaptain && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <Badge variant="info">队长</Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent>阵营队长，负责 BP 选图</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/**
 * 比赛页的阵营列（对阵版式）：CT 列在左、T 列在右，队名在各自半区居中，
 * 玩家长方体贴外侧（左列贴左、右列贴右），中间的竖线 + VS 由调用方插入。
 * 观战席仍走 PlayerRow / SpecPanel；房间页的完整管理交互在 slot-panel。
 */
export function TeamPanel({ room, side }: { room: Room; side: TeamSide }) {
  const meta = TEAM_META[side]
  const teamName = side === 'ct' ? room.teamAName : room.teamBName
  const members = room.slots.filter((s) => s.team === side)
  const limit = side === 'ct' ? room.teamA : room.teamB
  const emptyCount = Math.max(0, limit - members.length)
  const mirrored = side === 't'

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', mirrored ? 'items-end' : 'items-start')}>
      {/* 队名在半区居中（原「反恐精英 / 恐怖分子」副标题与 n/N 计数按用户要求去掉） */}
      <div className="flex w-full items-center justify-center gap-2">
        <span className={cn('size-2 rounded-full', meta.dot)} />
        <span className="win-body-strong">{teamName}</span>
      </div>
      <div className={cn('flex w-full min-w-0 flex-col gap-1.5', mirrored ? 'items-end' : 'items-start')}>
        {members.map((slot) => (
          <PlayerChip key={slot.player.id} slot={slot} side={side} room={room} />
        ))}
        {Array.from({ length: emptyCount }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className={cn(
              'flex w-full max-w-[220px] min-w-0 items-center gap-2.5 rounded-[4px] px-3 py-2 text-muted-foreground',
              mirrored && 'flex-row-reverse',
            )}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-[var(--control-strong-stroke)]">
              <UserPlus className="size-3.5" />
            </span>
            <span className="win-caption">空位</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SpecPanel({
  room,
  onRequestSwap,
  onTransferCaptain,
}: {
  room: Room
  onRequestSwap?: (playerId: string) => void
  onTransferCaptain?: (playerId: string) => void
}) {
  const specs = room.slots.filter((s) => s.team === 'spec')
  if (specs.length === 0) return null
  return (
    <div className="win-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-[var(--control-strong-fill)]" />
          <span className="win-body-strong text-muted-foreground">观战席</span>
        </div>
        <Badge variant="secondary" className="font-mono">
          {specs.length}/{room.specSeats}
        </Badge>
      </div>
      <div className="flex flex-col gap-0.5">
        {specs.map((s) => (
          <PlayerRow
            key={s.player.id}
            slot={s}
            isHost={room.hostId === s.player.steamId}
            isCaptain={room.captainA === s.player.steamId || room.captainB === s.player.steamId}
            room={room}
            onRequestSwap={onRequestSwap}
            onTransferCaptain={onTransferCaptain}
          />
        ))}
      </div>
    </div>
  )
}
