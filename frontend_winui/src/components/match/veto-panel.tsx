// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useMemo, useState } from 'react'
import { Clock } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Progress } from '@/components/winui/progress'
import { MapCard } from '@/components/match/map-card'
import { useArena } from '@/stores/arena'
import { mapDefOf } from '@/lib/maps'
import { type Room } from '@/lib/types'
import { cn } from '@/lib/utils'

export function VetoPanel({ room }: { room: Room }) {
  const currentUser = useArena((s) => s.currentUser)
  const vetoAction = useArena((s) => s.vetoAction)
  const resetVeto = useArena((s) => s.resetVeto)
  const sideAction = useArena((s) => s.sideAction)
  const maps = useArena((s) => s.maps)

  const bpPhase = room.bpPhase ?? 'ban'
  const isSidePhase = !!room.sidePendingFor
  const turnTeam = room.vetoTurn % 2 === 0 ? 'ct' : 't'
  const isHost = room.hostId === currentUser?.steamId
  const turnCaptain = turnTeam === 'ct' ? room.captainA : room.captainB
  const pendingTeamName = room.sidePendingFor === 'team2' ? room.teamBName : room.teamAName
  const pendingCaptain = room.sidePendingFor === 'team2' ? room.captainB : room.captainA
  const canActMap =
    (isHost || currentUser?.isAdmin || turnCaptain === currentUser?.steamId) &&
    room.status === 'vetoing' &&
    !isSidePhase &&
    (bpPhase === 'ban' || bpPhase === 'pick')
  const canActSide =
    (isHost || currentUser?.isAdmin || pendingCaptain === currentUser?.steamId) && isSidePhase

  // 倒计时由后端 vetoDeadlineAt 驱动（超时自动操作在后端执行）
  const [remaining, setRemaining] = useState<number | null>(null)
  useEffect(() => {
    if (room.status !== 'vetoing' || !room.vetoDeadlineAt) {
      setRemaining(null)
      return
    }
    const tick = () => {
      const ms = Math.max(0, room.vetoDeadlineAt! - Date.now())
      setRemaining(Math.ceil(ms / 1000))
    }
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [room.status, room.vetoDeadlineAt, room.vetoTurn, room.id])

  const pendingCaptainPlayer = room.slots.find((s) => s.player.steamId === pendingCaptain)?.player

  // 已完成选边的地图结果展示
  const sideRows = useMemo(() => {
    return Object.entries(room.sideChoices ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([idx, val]) => {
        const mapIndex = Number(idx)
        const isTeam1 = val.startsWith('team1')
        const side = val.endsWith('_ct') ? 'CT' : 'T'
        const teamName = isTeam1 ? room.teamAName : room.teamBName
        const def = room.picked[mapIndex] ? mapDefOf(maps, room.picked[mapIndex]) : null
        return {
          mapIndex,
          label: `图${mapIndex + 1} · ${def?.displayName ?? ''}`,
          text: `${teamName} 先 ${side}`,
        }
      })
  }, [room.sideChoices, room.picked, room.teamAName, room.teamBName, maps])

  const phaseLabel = isSidePhase
    ? '选边阶段'
    : bpPhase === 'ban'
      ? 'BAN 阶段'
      : bpPhase === 'pick'
        ? 'PICK 阶段'
        : '选图完成'
  const phaseVariant = isSidePhase ? 'info' : bpPhase === 'pick' ? 'success' : bpPhase === 'done' ? 'secondary' : 'destructive'

  return (
    <div className="flex flex-col gap-4">
      <div className="win-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="win-body flex flex-wrap items-center gap-2.5">
            <Badge variant={phaseVariant}>{phaseLabel}</Badge>
            {isSidePhase ? (
              <span className="text-muted-foreground">
                请 <b className="text-[var(--accent-text)]">{pendingTeamName}</b> 队长{' '}
                <b className="text-foreground">{pendingCaptainPlayer?.name ?? '未知'}</b> 选择开局阵营
              </span>
            ) : (
              <span className="text-muted-foreground">
                {bpPhase === 'ban' ? (
                  <>
                    当前由 <b className="text-[var(--critical)]">{turnTeam === 'ct' ? room.teamAName : room.teamBName}</b> 队长{' '}
                    <b className="text-foreground">{turnCaptain ? room.slots.find((s) => s.player.steamId === turnCaptain)?.player.name : '未知'}</b>{' '}
                    Ban 一张地图
                  </>
                ) : (
                  <>
                    当前由 <b className="text-[var(--success)]">{turnTeam === 't' ? room.teamBName : room.teamAName}</b> 队长{' '}
                    <b className="text-foreground">{turnCaptain ? room.slots.find((s) => s.player.steamId === turnCaptain)?.player.name : '未知'}</b>{' '}
                    Pick 一张地图
                  </>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {room.status === 'vetoing' && remaining !== null && (
              <span
                className={cn(
                  'win-caption inline-flex items-center gap-1 rounded-[4px] border border-[var(--card-stroke)] bg-[var(--subtle-secondary)] px-2 py-1 font-mono font-semibold',
                  remaining <= 5 && 'border-transparent bg-[var(--critical-bg)] text-[var(--critical)]',
                )}
              >
                <Clock className="size-3" />
                {remaining}s
              </span>
            )}
            {isHost && (
              <Button variant="subtle" size="sm" onClick={() => resetVeto(room.id)}>
                重置 BP
              </Button>
            )}
          </div>
        </div>
        <div className="win-caption mt-3 flex items-center gap-3 text-muted-foreground">
          <span>
            已操作：<b className="font-mono text-foreground">{room.banned.length + room.picked.length}</b>/{room.mapPool.length}
          </span>
          <Progress
            className="flex-1"
            value={100 - (room.mapPool.length > 0 ? ((room.banned.length + room.picked.length) / room.mapPool.length) * 100 : 0)}
          />
        </div>

        {isSidePhase && (
          <div className="mt-3 rounded-[4px] border border-[var(--accent)]/30 bg-[var(--subtle-secondary)] p-4">
            <p className="win-body">
              请选择开局阵营（<b>{pendingTeamName}</b>）
            </p>
            <div className="mt-3 flex gap-3">
              <Button size="lg" disabled={!canActSide} onClick={() => sideAction(room.id, 'ct')}>
                <span className="size-2 rounded-full bg-[#4cc2ff]" />
                CT（先防守）
              </Button>
              <Button size="lg" disabled={!canActSide} onClick={() => sideAction(room.id, 't')}>
                <span className="size-2 rounded-full bg-[#f7a501]" />
                T（先进攻）
              </Button>
            </div>
            <p className="win-caption mt-2 text-muted-foreground">
              {canActSide ? '由当前待选边队伍的队长选择' : `等待 ${pendingTeamName} 队长选择`}
              {remaining === 0 && ' · 已超时，将默认选择 CT'}
            </p>
          </div>
        )}

        {bpPhase !== 'done' && !isSidePhase && (
          <p className="win-caption mt-3 text-muted-foreground">
            {canActMap
              ? `由当前轮次队伍的队长执行操作（${turnTeam === 'ct' ? room.teamAName : room.teamBName}）`
              : isHost
                ? '等待操作…'
                : `等待 ${turnTeam === 'ct' ? room.teamAName : room.teamBName} 队长操作`}
            {remaining === 0 && ' · 已超时，服务器将自动操作'}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
        {room.mapPool.map((id) => {
          const bannedIdx = room.banned.indexOf(id)
          const pickedIdx = room.picked.indexOf(id)
          const state = bannedIdx !== -1 ? 'banned' : pickedIdx !== -1 ? 'picked' : 'available'
          return (
            <MapCard
              key={id}
              mapId={id}
              state={state}
              pickOrder={pickedIdx !== -1 ? pickedIdx + 1 : undefined}
              disabled={!canActMap}
              compact
              showActions={!isSidePhase && bpPhase !== 'done'}
              onBan={() => vetoAction(room.id, id, 'ban')}
              onPick={() => vetoAction(room.id, id, 'pick')}
            />
          )
        })}
      </div>

      {(sideRows.length > 0 || room.bestOf === 3) && (
        <div className="win-card p-4">
          <p className="win-meta mb-2">选边结果</p>
          <div className="flex flex-wrap gap-2">
            {sideRows.map((r) => (
              <Badge key={r.mapIndex} variant="secondary">
                {r.label}
                <b className="text-[var(--accent-text)]">{r.text}</b>
              </Badge>
            ))}
            {room.bestOf === 3 && room.picked.length >= 2 && (
              <Badge variant="info">图3 · 刀局选边</Badge>
            )}
          </div>
        </div>
      )}

      <div className="win-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <p className="win-meta">操作记录</p>
          <Badge variant="secondary">{room.vetoHistory.length}</Badge>
        </div>
        {room.vetoHistory.length === 0 ? (
          <p className="win-caption text-muted-foreground">暂无记录，等待第一手操作…</p>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--divider)]">
            {room.vetoHistory.map((a) => {
              const def = mapDefOf(maps, a.mapId)
              const actor = room.slots.find((s) => s.player.steamId === a.byPlayerId)?.player
              return (
                <div key={a.id} className="win-caption flex items-center gap-2 py-1.5 first:pt-0 last:pb-0">
                  <span
                    className={cn(
                      'grid w-11 place-items-center rounded-[4px] px-1 py-0.5 font-mono font-bold',
                      a.type === 'ban'
                        ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
                        : 'bg-[var(--success-bg)] text-[var(--success)]',
                    )}
                  >
                    {a.type === 'ban' ? 'BAN' : 'PICK'}
                  </span>
                  <span className="font-semibold">{def.displayName}</span>
                  <span className="text-muted-foreground">
                    {actor?.name ?? '未知玩家'} · {a.byTeam === 'ct' ? room.teamAName : room.teamBName}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                    {new Date(a.at).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
