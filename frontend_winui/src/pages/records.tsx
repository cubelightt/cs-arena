// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/winui/avatar'
import { Badge } from '@/components/winui/badge'
import { Card } from '@/components/winui/card'
import { useArena } from '@/stores/arena'
import { mapDefOf } from '@/lib/maps'
import { MATCH_TYPE_LABELS, type MatchRecord, type TeamSide } from '@/lib/types'
import { cn } from '@/lib/utils'

function PlayerChip({
  p,
  side,
  isHost,
}: {
  p: MatchRecord['players'][number]
  side: TeamSide
  isHost: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-[4px] border-l-2 bg-[var(--subtle-secondary)] px-2 py-1.5',
        side === 'ct' ? 'border-l-[#4cc2ff]' : 'border-l-[#f7a501]',
      )}
    >
      <Avatar className="size-7">
        <AvatarImage src={p.avatarUrl} />
        <AvatarFallback>{p.name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="win-caption flex items-center gap-1 truncate font-medium">
          {p.name}
          {isHost && <Badge variant="secondary">房主</Badge>}
        </p>
        <p className="win-caption truncate font-mono text-muted-foreground">{p.steamId}</p>
      </div>
    </div>
  )
}

function RecordCard({ record }: { record: MatchRecord }) {
  const [open, setOpen] = useState(false)
  const maps = useArena((s) => s.maps)
  const communityMaps = useArena((s) => s.communityMaps)
  const teamA = record.players.filter((p) => p.team === 'ct')
  const teamB = record.players.filter((p) => p.team === 't')
  const specs = record.players.filter((p) => p.team === 'spec')
  const hostSteamId = record.players.find((p) => p.isHost)?.steamId
  const hasScore = record.score1 !== null && record.score2 !== null

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 p-5 text-left transition-colors hover:bg-[var(--subtle-secondary)]"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="win-body-strong">{record.roomName}</h3>
            <Badge variant="outline">{MATCH_TYPE_LABELS[record.matchType]}</Badge>
            <Badge variant="secondary">BO{record.bestOf}</Badge>
            {hasScore && (
              <span className="win-caption inline-flex items-center gap-1.5 rounded-[4px] bg-[var(--subtle-secondary)] px-2.5 py-0.5 font-mono font-semibold">
                <span className="size-1.5 rounded-full bg-[#4cc2ff]" />
                {record.score1}
                <span className="font-normal text-muted-foreground">:</span>
                {record.score2}
                <span className="size-1.5 rounded-full bg-[#f7a501]" />
              </span>
            )}
          </div>
          <p className="win-caption mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-muted-foreground">
            <span className="font-mono">#{record.code}</span>
            <span>{record.players.length} 名选手</span>
            <span>{record.maps.map((id) => mapDefOf([...maps, ...communityMaps], id).displayName).join(' / ')}</span>
            <span>{new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
          </p>
        </div>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="grid gap-4 border-t border-[var(--divider)] p-5 lg:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <p className="win-meta mb-1 flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-[#4cc2ff]" />
              TEAM A（{teamA.length} 人）
            </p>
            {teamA.map((p) => (
              <PlayerChip key={p.steamId} p={p} side="ct" isHost={p.steamId === hostSteamId} />
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="win-meta mb-1 flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-[#f7a501]" />
              TEAM B（{teamB.length} 人）
            </p>
            {teamB.map((p) => (
              <PlayerChip key={p.steamId} p={p} side="t" isHost={p.steamId === hostSteamId} />
            ))}
          </div>
          {specs.length > 0 && (
            <div className="flex flex-col gap-1.5 lg:col-span-2">
              <p className="win-meta mb-1">观战席（{specs.length} 人）</p>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
                {specs.map((p) => (
                  <PlayerChip key={p.steamId} p={p} side="ct" isHost={p.steamId === hostSteamId} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

export function RecordsPage() {
  const records = useArena((s) => s.records)
  const fetchRecords = useArena((s) => s.fetchRecords)

  useEffect(() => {
    fetchRecords()
  }, [fetchRecords])

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="win-title">比赛记录</h1>
        <p className="win-body mt-1 text-muted-foreground">
          共 {records.length} 场比赛，记录每场各选手的 Steam 信息与阵容
        </p>
      </div>

      {records.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--card-stroke)] py-20 text-center">
          <p className="win-body font-medium">还没有比赛记录</p>
          <p className="win-caption mt-1 text-muted-foreground">完成一场对战后将自动记录</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {records.map((r) => (
            <RecordCard key={r.id} record={r} />
          ))}
        </div>
      )}
    </div>
  )
}
