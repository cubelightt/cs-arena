// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftRight, Bot, Crown, Shuffle } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/winui/avatar'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Switch } from '@/components/winui/switch'
import { RoomDisplayNameDialog } from '@/components/match/display-name-dialog'
import { useArena } from '@/stores/arena'
import type { Player, PlayerSlot, Room, TeamSide } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * 玩家槽位面板（WinUI 磁贴风格）：
 * 上排 TEAM A / 分隔 / 下排 TEAM B 的头像槽位网格，观战席独立小卡区。
 * - 左键点击空闲槽位：直接换位过去（setTeam 到该侧；观战席同理）
 * - 右键玩家槽位：MenuFlyout 语义的上下文菜单
 *   · 自己：房间开启「允许玩家修改局内ID」后出现「修改ID」
 *   · 非房主：仅「发出换位申请」
 *   · 房主：额外「交换到另一队（观战席玩家显示两队选项）」+「踢出房间」（红字）
 *   · 操作者为该队队长：额外「移交队长」
 *   · 管理员：任何人都多一条「修改ID」（不受房间开关限制）
 * - 增强人机房（botMode）：bot 槽位为虚框机器卡片（Bot 图标 + BOT 徽标），不参与
 *   换位申请/队长；房主可右键调度队伍或移除；TeamB 空位为「人机位」不可被真人点击
 * 行为与 v2 逐条对齐（含槽位序号落位、空槽精确换位、自动补位开关）。
 */

interface MenuEntry {
  label: string
  danger?: boolean
  onSelect: () => void
}

const TEAM_ACCENT: Record<TeamSide, { dot: string; ring: string; badge: string }> = {
  ct: { dot: 'bg-[#4cc2ff]', ring: 'ring-[#4cc2ff]', badge: 'bg-[#0a6ca8]' },
  t: { dot: 'bg-[#f7a501]', ring: 'ring-[#f7a501]', badge: 'bg-[#9d5d00]' },
}

function SlotContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  // 视口坐标夹取；经 portal 挂到 body：避免父级堆叠上下文影响 fixed 定位
  const left = Math.max(8, Math.min(x, window.innerWidth - 200))
  const top = Math.max(8, Math.min(y, window.innerHeight - entries.length * 34 - 16))
  return createPortal(
    <div
      className="win-flyout win-anim-flyout fixed z-[90] min-w-44 shadow-xl"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((it) => (
        <button
          key={it.label}
          type="button"
          data-danger={it.danger || undefined}
          onClick={() => {
            it.onSelect()
            onClose()
          }}
          className="win-flyout-item cursor-pointer"
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

export function RoomSlotsPanel({ room, onShuffle }: { room: Room; onShuffle?: () => void }) {
  const currentUser = useArena((s) => s.currentUser)
  const setTeam = useArena((s) => s.setTeam)
  const swapRequest = useArena((s) => s.swapRequest)
  const transferCaptain = useArena((s) => s.transferCaptain)
  const movePlayer = useArena((s) => s.movePlayer)
  const kickPlayer = useArena((s) => s.kickPlayer)
  const removeBots = useArena((s) => s.removeBots)

  const meSteamId = currentUser?.steamId
  const isHost = room.hostId === meSteamId
  /** 管理员可改房内任意玩家的对局显示名（不受房间「允许玩家修改局内ID」开关限制） */
  const isAdmin = currentUser?.isAdmin === true
  /** 玩家自助改名：需房间开关（默认关闭）；管理员改自己/他人都放行 */
  const canRename = (steamId: string) => isAdmin || (steamId === meSteamId && room.allowDisplayName === true)
  const mySlot = room.slots.find((s) => s.player.steamId === meSteamId)
  const isCaptainOf = (team: TeamSide) => (team === 'ct' ? room.captainA : room.captainB) === meSteamId
  // 空槽位仅等待期可点（与旧版头部「加入 X」按钮同条件）；setTeam 由后端裁决人数
  const canMove = room.status === 'waiting' && !!meSteamId

  // 右键菜单状态
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  // 「修改战局内显示的ID」弹窗的目标玩家（null = 关闭）
  const [renameTarget, setRenameTarget] = useState<Player | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('click', close)
    document.addEventListener('resize', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const openMenu = (e: React.MouseEvent, slot: PlayerSlot) => {
    e.preventDefault()
    const target = slot.player
    const entries: MenuEntry[] = []
    const renameEntry: MenuEntry = { label: '修改ID', onSelect: () => setRenameTarget(target) }
    // 自己的槽位：只有「修改ID」（房间开启开关后玩家可改自己；管理员始终可改）
    if (target.steamId === meSteamId) {
      if (canRename(target.steamId)) setMenu({ x: e.clientX, y: e.clientY, entries: [renameEntry] })
      return
    }
    // 人机槽位：不参与换位申请/队长/改名；房主可调度队伍或移除
    if (slot.isBot) {
      if (isHost) {
        if (slot.team === 'spec') {
          entries.push({ label: `调度到 ${room.teamAName}`, onSelect: () => movePlayer(room.id, slot.player.id, 'ct') })
          entries.push({ label: `调度到 ${room.teamBName}`, onSelect: () => movePlayer(room.id, slot.player.id, 't') })
        } else {
          const other: TeamSide = slot.team === 'ct' ? 't' : 'ct'
          entries.push({
            label: `调度到 ${other === 'ct' ? room.teamAName : room.teamBName}`,
            onSelect: () => movePlayer(room.id, slot.player.id, other),
          })
        }
        entries.push({ label: '移除人机', danger: true, onSelect: () => removeBots(room.id, slot.player.id) })
      }
      if (entries.length > 0) setMenu({ x: e.clientX, y: e.clientY, entries })
      return
    }
    // 换位申请：目标与自己不在同一侧才有意义（同侧无位置概念，与旧版候选规则一致）
    if (mySlot && !mySlot.isBot && slot.team !== mySlot.team) {
      entries.push({ label: '发出换位申请', onSelect: () => swapRequest(room.id, target.steamId) })
    }
    if (isHost) {
      if (slot.team === 'spec') {
        entries.push({ label: `加入 ${room.teamAName}`, onSelect: () => movePlayer(room.id, slot.player.id, 'ct') })
        entries.push({ label: `加入 ${room.teamBName}`, onSelect: () => movePlayer(room.id, slot.player.id, 't') })
      } else {
        const other: TeamSide = slot.team === 'ct' ? 't' : 'ct'
        entries.push({
          label: `交换到 ${other === 'ct' ? room.teamAName : room.teamBName}`,
          onSelect: () => movePlayer(room.id, slot.player.id, other),
        })
      }
    }
    if (slot.team !== 'spec' && isCaptainOf(slot.team)) {
      entries.push({ label: '移交队长', onSelect: () => transferCaptain(room.id, target.steamId) })
    }
    // 管理员改他人显示名（不受房间开关限制）
    if (canRename(target.steamId)) entries.push(renameEntry)
    // 「踢出房间」恒为菜单最后一项（危险操作不与常规项混排）
    if (isHost) entries.push({ label: '踢出房间', danger: true, onSelect: () => kickPlayer(room.id, slot.player.id) })
    if (entries.length > 0) setMenu({ x: e.clientX, y: e.clientY, entries })
  }

  // 点击空槽：默认精确换位到该槽位（同队移位原槽留空 / 跨队直达目标位）；
  // 房主开启「自动补位」后不携带 slot，由后端落目标队最小空槽（旧行为）。
  // 开关为房间级设置（rooms.auto_fill，房主可改、经 room:update 广播全体）
  const updateConfig = useArena((s) => s.updateConfig)
  const autoFill = room.autoFill ?? false
  const clickEmpty = (team: TeamSide | 'spec', index: number) => {
    if (!canMove) return
    // 增强人机房 TeamB 全为人机：真人不可加入（后端 400），空位仅供人机落位
    if (room.botMode && team === 't') return
    if (autoFill) setTeam(room.id, team)
    else setTeam(room.id, team, index)
  }

  const teamASlots = room.slots.filter((s) => s.team === 'ct')
  const teamBSlots = room.slots.filter((s) => s.team === 't')
  const specSlots = room.slots.filter((s) => s.team === 'spec')
  const showShuffle = !!onShuffle && isHost && (room.status === 'waiting' || room.status === 'vetoing')

  const renderOccupied = (slot: PlayerSlot, small?: boolean) => {
    const side = slot.team === 'spec' ? null : (slot.team as TeamSide)
    const accent = side ? TEAM_ACCENT[side] : null
    const isHostPlayer = room.hostId === slot.player.steamId
    const isCaptain = !!side && (room.captainA === slot.player.steamId || room.captainB === slot.player.steamId)
    // 玩家自定义的对局显示 ID（displayNames 仅当前成员有条目；未设置则不显示该行）
    const displayName = room.displayNames?.[slot.player.steamId]
    // 增强人机槽位：虚框机器卡片（Bot 图标 + BOT 徽标），不显示房主/队长标记
    if (slot.isBot) {
      return (
        <div
          key={slot.player.id}
          onContextMenu={(e) => openMenu(e, slot)}
          title={`人机 · ${slot.player.name}`}
          className={cn(
            'win-tile relative flex flex-col items-center rounded-[4px] border border-dashed border-[var(--control-strong-stroke)] bg-[var(--subtle-tertiary)]',
            small ? 'min-h-[104px] gap-1.5 p-2.5' : 'min-h-[140px] gap-2 p-3',
          )}
        >
          <div className="relative mt-1.5">
            <div
              className={cn(
                'grid place-items-center rounded-[4px] border border-[var(--card-stroke)] bg-[var(--control-fill)]',
                small ? 'size-11' : 'size-14',
                accent && cn('ring-2', accent.ring),
              )}
            >
              <Bot className={cn('text-[var(--accent-text)]', small ? 'size-5' : 'size-7')} />
            </div>
          </div>
          <p className={cn('w-full truncate text-center', small ? 'win-caption' : 'win-caption')}>{slot.player.name}</p>
          <span className="win-caption rounded-[4px] bg-[var(--control-fill-secondary)] px-1.5 py-px font-mono font-bold tracking-[0.15em] text-muted-foreground">
            BOT
          </span>
        </div>
      )
    }
    return (
      <div
        key={slot.player.id}
        onContextMenu={(e) => openMenu(e, slot)}
        title={slot.player.steamId}
        className={cn(
          'win-tile relative flex flex-col items-center rounded-[4px] border border-[var(--card-stroke)] bg-[var(--card-bg)]',
          small ? 'min-h-[104px] gap-1.5 p-2.5' : 'min-h-[140px] gap-2 p-3',
        )}
      >
        {isHostPlayer && (
          <span
            title="房主"
            className="absolute -top-2 left-2 grid size-5 place-items-center rounded-[4px] bg-[var(--caution)] text-[var(--solid-quarternary)]"
          >
            <Crown className="size-3" />
          </span>
        )}
        <div className="relative mt-1.5">
          <Avatar className={cn(small ? 'size-11' : 'size-14', accent && cn('ring-2', accent.ring))}>
            <AvatarImage src={slot.player.avatarUrl} />
            <AvatarFallback>{slot.player.name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          {isCaptain && side && (
            <span
              title="队长"
              className={cn(
                'absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full text-[10px] font-bold text-white ring-2 ring-[var(--solid-base)]',
                accent!.badge,
              )}
            >
              {side === 'ct' ? 'A' : 'B'}
            </span>
          )}
        </div>
        <p
          className={cn(
            'win-caption w-full truncate text-center text-muted-foreground',
            slot.player.steamId === meSteamId && 'font-semibold text-[var(--accent-text)]',
          )}
        >
          {slot.player.name}
        </p>
        {/* 自定义局内ID：面具图标（X parody 标记样式，自带灰色）+ 修改后的 ID，恒为灰色，
            置于玩家昵称下方；本人昵称是强调色时该行仍保持灰，以区分「账号昵称 / 对局 ID」 */}
        {displayName && (
          <p
            title={`局内ID：${displayName}`}
            className="flex w-full items-center justify-center gap-1 text-muted-foreground"
          >
            <img src="/icons/parody-mask.svg" alt="" className={cn('shrink-0', small ? 'size-3' : 'size-3.5')} />
            <span className="win-caption truncate">{displayName}</span>
          </p>
        )}
      </div>
    )
  }

  const renderEmpty = (team: TeamSide | 'spec', idx: number, small?: boolean) => {
    // 增强人机房 TeamB 空位 = 人机位：真人不可加入，仅提示（可经人机面板/开赛自动补满）
    const botReserved = room.botMode && team === 't'
    const label = botReserved ? '人机位' : team === 'spec' ? '观战' : '换位'
    const teamName = team === 'spec' ? '观战席' : team === 'ct' ? room.teamAName : room.teamBName
    return (
      <button
        key={`empty-${team}-${idx}`}
        type="button"
        disabled={!canMove || botReserved}
        title={botReserved ? `${teamName} · 人机位（由房主添加人机或开赛自动补满）` : `换位到 ${teamName} · 第 ${idx + 1} 位`}
        onClick={() => clickEmpty(team, idx)}
        className={cn(
          'flex flex-col items-center justify-center rounded-[4px] border border-dashed border-[var(--control-strong-stroke)] bg-[var(--subtle-tertiary)] transition-colors',
          small ? 'min-h-[104px] gap-1.5 p-2.5' : 'min-h-[140px] gap-2 p-3',
          botReserved ? 'cursor-default opacity-60' : canMove ? 'cursor-pointer hover:bg-[var(--subtle-secondary)]' : 'cursor-default opacity-50',
        )}
      >
        <span
          className={cn(
            'grid place-items-center rounded-full border border-[var(--control-strong-stroke)] text-muted-foreground',
            small ? 'size-9' : 'size-12',
          )}
        >
          {botReserved ? (
            <Bot className={small ? 'size-3.5' : 'size-4'} />
          ) : (
            <ArrowLeftRight className={small ? 'size-3.5' : 'size-4'} />
          )}
        </span>
        <span className="win-caption text-muted-foreground">{label}</span>
      </button>
    )
  }

  // 行槽位构建：后端下发 slot 时按序号落位（空槽保持留空）；未下发时紧凑补位（旧行为）
  const buildRow = (teamSlots: PlayerSlot[], count: number): Array<PlayerSlot | null> => {
    const out: Array<PlayerSlot | null> = Array(count).fill(null)
    if (teamSlots.some((s) => typeof s.slot === 'number')) {
      for (const s of teamSlots) {
        const i = s.slot as number
        if (Number.isInteger(i) && i >= 0 && i < count && !out[i]) out[i] = s
      }
      for (const s of teamSlots) {
        if (!out.includes(s)) {
          const free = out.indexOf(null)
          if (free !== -1) out[free] = s
        }
      }
    } else {
      teamSlots.forEach((s, i) => {
        if (i < count) out[i] = s
      })
    }
    return out
  }

  const rowA = buildRow(teamASlots, room.teamA)
  const rowB = buildRow(teamBSlots, room.teamB)
  // 观战席空位 = 配置席位 − 已占用（不设上限：原先截断为 2，会把席位调到 4/6/8… 时界面毫无变化）
  const specEmptyCount = Math.max(0, room.specSeats - specSlots.length)
  // 列数上限 6（更多席位换行）；最小 1 —— 原先强制凑 2 列，导致只有 1 个观战位时偏左半个卡宽
  const specColCount = Math.max(1, Math.min(specEmptyCount + specSlots.length, 6))
  // 槽位统一固定宽度并居中：minmax(0,116px) 在容器不足时按比例微缩（如 10 列），
  // 相邻人数间卡宽完全一致，避免「4 人小卡居中 / 5 人大卡拉满」的阈值跳变
  const rowStyle = (n: number) => ({ gridTemplateColumns: `repeat(${n}, minmax(0, 116px))` })
  // 队伍头部与行网格同宽居中：头部随行宽收缩，计数徽章对齐行右缘
  const rowBlockClass = 'mx-auto w-fit'

  const teamHeader = (side: TeamSide) => (
    <div className="mb-2 flex items-center gap-2">
      <span className={cn('size-2 rounded-full', TEAM_ACCENT[side].dot)} />
      <span className="win-body-strong">{side === 'ct' ? room.teamAName : room.teamBName}</span>
      <span className="win-caption text-muted-foreground">{side === 'ct' ? '反恐精英' : '恐怖分子'}</span>
      <Badge variant="secondary" className="ml-auto font-mono">
        {(side === 'ct' ? teamASlots : teamBSlots).length}/{side === 'ct' ? room.teamA : room.teamB}
      </Badge>
    </div>
  )

  return (
    <section className="win-card p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="win-meta">阵容</p>
        <div className="flex items-center gap-4">
          <label
            className={cn(
              'win-caption flex items-center gap-2 select-none text-muted-foreground transition-colors',
              isHost ? 'cursor-pointer hover:text-foreground' : 'cursor-not-allowed opacity-60',
            )}
            title={`点击空槽的落位方式（仅房主可切换，对全体生效）\n关闭（默认）：精确换位到点击的槽位，原槽位留空\n开启：加入该侧时自动补位到最小空槽（旧行为）`}
          >
            <Switch
              checked={autoFill}
              disabled={!isHost}
              onChange={(e) => updateConfig(room.id, { autoFill: e.target.checked })}
            />
            自动补位
          </label>
          {showShuffle && (
            <Button size="sm" variant="secondary" onClick={onShuffle}>
              <Shuffle className="size-3.5" />
              随机分队
            </Button>
          )}
        </div>
      </div>

      {/* 每行独立「头部 + 网格」居中块：槽宽全行一致，人数只改变行宽不改变卡宽 */}
      <div className={rowBlockClass}>
        {teamHeader('ct')}
        <div className="grid justify-center gap-2.5" style={rowStyle(room.teamA)}>
          {rowA.map((slot, i) => (slot ? renderOccupied(slot) : renderEmpty('ct', i)))}
        </div>
      </div>

      <div className="my-3.5 flex items-center gap-3">
        <span className="h-px flex-1 bg-[var(--divider)]" />
        <span className="win-meta">VS</span>
        <span className="h-px flex-1 bg-[var(--divider)]" />
      </div>

      <div className={rowBlockClass}>
        {teamHeader('t')}
        <div className="grid justify-center gap-2.5" style={rowStyle(room.teamB)}>
          {rowB.map((slot, i) => (slot ? renderOccupied(slot) : renderEmpty('t', i)))}
        </div>
      </div>

      {room.specSeats > 0 && (
        <div className="mt-4 border-t border-[var(--divider)] pt-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="size-2 rounded-full bg-[var(--control-strong-fill)]" />
            <span className="win-caption font-semibold text-muted-foreground">观战席</span>
            <Badge variant="secondary" className="font-mono">
              {specSlots.length}/{room.specSeats}
            </Badge>
          </div>
          {/* 观战席与队伍行同一套规则：固定卡宽 + 居中 */}
          <div className="mx-auto grid w-fit justify-center gap-2.5" style={rowStyle(specColCount)}>
            {specSlots.map((slot) => renderOccupied(slot, true))}
            {/* 空位槽 index 从已有观战人数之后起算，避免与已占用槽位冲突 */}
            {Array.from({ length: specEmptyCount }).map((_, i) => renderEmpty('spec', specSlots.length + i, true))}
          </div>
        </div>
      )}

      {menu && <SlotContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}

      <RoomDisplayNameDialog
        room={room}
        open={!!renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        target={renameTarget}
      />
    </section>
  )
}
