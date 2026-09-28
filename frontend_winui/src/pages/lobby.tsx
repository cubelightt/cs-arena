// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input, PasswordInput } from '@/components/winui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/winui/select'
import { CreateRoomDialog } from '@/components/match/create-room-dialog'
import { useArena } from '@/stores/arena'
import { mapDefOf } from '@/lib/maps'
import { MATCH_TYPE_LABELS, type Room, type RoomStatus } from '@/lib/types'

const STATUS_META: Record<RoomStatus, { label: string; variant: 'success' | 'info' | 'secondary' | 'destructive' }> = {
  waiting: { label: '等待中', variant: 'success' },
  vetoing: { label: '选图中', variant: 'info' },
  starting: { label: '开赛中', variant: 'info' },
  live: { label: '进行中', variant: 'destructive' },
  finished: { label: '已结束', variant: 'secondary' },
}

function RoomCard({ room, onJoin }: { room: Room; onJoin: (room: Room) => void }) {
  const navigate = useNavigate()
  const maps = useArena((s) => s.maps)
  const communityMaps = useArena((s) => s.communityMaps)
  const played = room.picked.length
  const filled = room.slots.filter((s) => s.team !== 'spec').length
  const total = room.teamA + room.teamB
  const status = STATUS_META[room.status]

  return (
    <Card className="transition-colors hover:border-input">
      <div className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="win-body-strong truncate">{room.name}</h3>
            <Badge variant="outline">{MATCH_TYPE_LABELS[room.matchType]}</Badge>
            {room.botMode && <Badge variant="info">增强人机</Badge>}
            <Badge variant={status.variant}>
              {(room.status === 'live' || room.status === 'vetoing') && (
                <span className="size-1.5 rounded-full bg-current win-dot-live" />
              )}
              {status.label}
            </Badge>
            {room.password && <Badge variant="secondary">私密</Badge>}
          </div>
          <div className="win-caption mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
            <span className="font-mono">#{room.code}</span>
            <span>{filled}/{total} 人</span>
            <span>{room.matchType === 'duel' ? '1v1' : `${room.teamA} vs ${room.teamB}`}</span>
            <span>BO{room.bestOf}</span>
          </div>
        </div>
        {room.status === 'live' ? (
          <Button size="sm" onClick={() => navigate(`/match/${room.id}`)}>
            查看比赛
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => onJoin(room)}>
            加入
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--divider)] px-5 py-3">
        <span className="win-meta mr-1">地图</span>
        {room.mapPool.slice(0, 7).map((id) => {
          const def = mapDefOf([...maps, ...communityMaps], id)
          const isPicked = room.picked.includes(id)
          const isBanned = room.banned.includes(id)
          return (
            <span
              key={id}
              className={`inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium ${
                isPicked
                  ? 'bg-[var(--success-bg)] text-[var(--success)]'
                  : isBanned
                    ? 'bg-[var(--subtle-secondary)] text-[var(--text-disabled)] line-through'
                    : 'bg-[var(--subtle-secondary)] text-muted-foreground'
              }`}
            >
              {!isBanned && !isPicked && <span className="size-1.5 rounded-full" style={{ backgroundColor: `hsl(${def.hue} 65% 55%)` }} />}
              {def.displayName.slice(0, 5)}
            </span>
          )
        })}
        {room.bestOf === 3 && <Badge variant="secondary" className="ml-auto font-mono text-[10px]">{played}/3</Badge>}
      </div>
    </Card>
  )
}

export function LobbyPage() {
  const rooms = useArena((s) => s.rooms)
  const currentUser = useArena((s) => s.currentUser)
  const joinRoomById = useArena((s) => s.joinRoomById)
  const refreshRooms = useArena((s) => s.refreshRooms)
  const navigate = useNavigate()

  useEffect(() => {
    refreshRooms()
  }, [refreshRooms])

  const [createOpen, setCreateOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | RoomStatus>('all')
  const [passwordRoom, setPasswordRoom] = useState<Room | null>(null)
  const [passwordInput, setPasswordInput] = useState('')

  const filtered = useMemo(
    () =>
      rooms.filter((r) => {
        const q = query.trim().toLowerCase()
        if (q && !r.name.toLowerCase().includes(q) && !r.code.toLowerCase().includes(q)) return false
        if (statusFilter !== 'all' && r.status !== statusFilter) return false
        return true
      }),
    [rooms, query, statusFilter],
  )

  const handleJoin = async (room: Room) => {
    if (room.password && room.status !== 'live') {
      setPasswordRoom(room)
      return
    }
    const id = await joinRoomById(room.id)
    if (id) navigate(`/room/${id}`)
  }

  const confirmPassword = async () => {
    if (!passwordRoom) return
    const id = await joinRoomById(passwordRoom.id, passwordInput)
    if (id) {
      setPasswordRoom(null)
      setPasswordInput('')
      navigate(`/room/${id}`)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="win-title">房间大厅</h1>
          <p className="win-body mt-1 text-muted-foreground">
            共 {rooms.length} 个房间 · 当前玩家 <span className="text-[var(--accent-text)]">{currentUser?.name}</span>
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>创建房间</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="搜索房间名称或房间码"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="waiting">等待中</SelectItem>
            <SelectItem value="vetoing">选图中</SelectItem>
            <SelectItem value="live">进行中</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--card-stroke)] py-20 text-center">
          <p className="win-body font-medium">没有找到符合条件的房间</p>
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            去创建一个
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((room) => (
            <RoomCard key={room.id} room={room} onJoin={handleJoin} />
          ))}
        </div>
      )}

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />

      <Dialog open={!!passwordRoom} onOpenChange={(open) => !open && setPasswordRoom(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>房间需要密码</DialogTitle>
            <DialogDescription>输入 {passwordRoom?.name} 的房间密码后加入</DialogDescription>
          </DialogHeader>
          <PasswordInput
            placeholder="房间密码"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmPassword()}
          />
          <DialogFooter>
            <Button onClick={confirmPassword}>确认加入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
