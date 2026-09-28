// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useMemo, useState } from 'react'
import { Bot, Trash2 } from 'lucide-react'
import { Button } from '@/components/winui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/winui/select'
import { useArena } from '@/stores/arena'
import {
  BOT_AIM_LABELS,
  BOT_NADES_LABELS,
  type BotAimMode,
  type BotNadeMode,
  type Room,
  type TeamSide,
} from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * 增强人机 · 人机管理面板（仅 botMode 房间的准备阶段展示）：
 * - 添加人机：指定名字（名字库联想）/ 名字池随机 / 职业队整队（仅 TeamB，需 ≥5 空位）
 * - 移除：清空全部人机（单个移除走槽位右键菜单）
 * - 人机调优：瞄准模式（bot_aim）/ 道具模式（bot_nades），开赛后经控制台下发
 * 管理操作仅房主可执行（非房主只读展示，与「自动补位」开关同模式）
 */
export function BotManagementPanel({ room }: { room: Room }) {
  const currentUser = useArena((s) => s.currentUser)
  const botCatalog = useArena((s) => s.botCatalog)
  const fetchBotCatalog = useArena((s) => s.fetchBotCatalog)
  const addBots = useArena((s) => s.addBots)
  const removeBots = useArena((s) => s.removeBots)
  const updateBotConfig = useArena((s) => s.updateBotConfig)

  const isHost = room.hostId === currentUser?.steamId
  const editable = isHost && (room.status === 'waiting' || room.status === 'vetoing')

  // 名字池/职业队目录（进入面板时拉取一次；失败时仍可手输名字）
  useEffect(() => {
    fetchBotCatalog()
  }, [fetchBotCatalog])

  const slots = room.slots
  const teamABots = slots.filter((s) => s.isBot && s.team === 'ct').length
  const teamBBots = slots.filter((s) => s.isBot && s.team === 't').length
  const hasBots = teamABots + teamBBots > 0
  const tFree = room.teamB - slots.filter((s) => s.team === 't').length
  const ctFree = room.teamA - slots.filter((s) => s.team === 'ct').length
  const proteamBlocked = tFree < 5

  // 指定名字添加
  const [singleName, setSingleName] = useState('')
  const [singleTeam, setSingleTeam] = useState<TeamSide>('t')
  const submitSingle = () => {
    const name = singleName.trim()
    if (!name) return
    addBots(room.id, { mode: 'single', name, team: singleTeam })
    setSingleName('')
  }

  // 随机添加：数量上限 = 目标队空位（与名字池剩余取小，后端再兜底）
  const [randomTeam, setRandomTeam] = useState<TeamSide>('t')
  const [randomCount, setRandomCount] = useState(1)
  const usedBotNames = useMemo(() => new Set(slots.filter((s) => s.isBot).map((s) => s.player.name)), [slots])
  const randomFree = randomTeam === 'ct' ? ctFree : tFree
  const poolRemaining = botCatalog ? botCatalog.names.filter((n) => !usedBotNames.has(n)).length : 30
  const randomMax = Math.max(0, Math.min(randomFree, poolRemaining))
  useEffect(() => {
    if (randomCount > randomMax) setRandomCount(Math.max(1, randomMax))
  }, [randomMax]) // eslint-disable-line react-hooks/exhaustive-deps

  const submitRandom = () => {
    if (randomMax === 0) return
    addBots(room.id, { mode: 'random', team: randomTeam, count: randomCount })
  }

  // 清空全部人机（含职业队标记重置）
  const [clearOpen, setClearOpen] = useState(false)

  const teamSelect = (value: TeamSide, onChange: (v: TeamSide) => void, idPrefix: string) => (
    <Select value={value} onValueChange={(v) => onChange(v as TeamSide)} disabled={!editable}>
      <SelectTrigger id={idPrefix}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ct">{room.teamAName}（真人侧）</SelectItem>
        <SelectItem value="t">{room.teamBName}（人机侧）</SelectItem>
      </SelectContent>
    </Select>
  )

  return (
    <section className="win-card p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-[var(--accent-text)]" />
          <p className="win-meta">人机管理</p>
        </div>
        {isHost && hasBots && editable && (
          <Button size="sm" variant="destructive" onClick={() => setClearOpen(true)}>
            <Trash2 className="size-3.5" />
            清空人机
          </Button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* 指定名字添加 */}
        <div className="flex flex-col gap-2">
          <Label className="win-caption text-muted-foreground">指定名字添加</Label>
          <Input
            list="bot-name-pool"
            placeholder="输入人机名，如 NiKo"
            maxLength={24}
            value={singleName}
            disabled={!editable}
            onChange={(e) => setSingleName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitSingle()}
          />
          <datalist id="bot-name-pool">
            {(botCatalog?.names ?? []).map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {teamSelect(singleTeam, setSingleTeam, 'single-bot-team')}
          <Button size="sm" disabled={!editable || !singleName.trim()} onClick={submitSingle}>
            添加人机
          </Button>
        </div>

        {/* 随机添加 */}
        <div className="flex flex-col gap-2">
          <Label className="win-caption text-muted-foreground">名字池随机添加</Label>
          {teamSelect(randomTeam, setRandomTeam, 'random-bot-team')}
          <Select value={String(randomCount)} onValueChange={(v) => setRandomCount(Number(v))} disabled={!editable || randomMax === 0}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: Math.max(0, Math.min(randomMax, 10)) }).map((_, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>
                  随机 {i + 1} 名
                </SelectItem>
              ))}
              {randomMax === 0 && (
                <SelectItem value="0" disabled>
                  无空位
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!editable || randomMax === 0} onClick={submitRandom}>
            随机添加
          </Button>
        </div>

        {/* 职业队整队（仅 TeamB） */}
        <div className="flex flex-col gap-2">
          <Label className="win-caption text-muted-foreground">
            职业队整队（仅 {room.teamBName}，需 5 空位）
          </Label>
          <div className="flex flex-col gap-1.5">
            {(botCatalog?.proTeams ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={!editable || proteamBlocked}
                title={t.roster.join(' / ')}
                onClick={() => addBots(room.id, { mode: 'proteam', teamId: t.id })}
                className={cn(
                  'win-tile flex cursor-pointer items-center justify-between gap-2 border border-[var(--card-stroke)] px-2.5 py-1.5 text-left',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                )}
              >
                <span className="win-caption font-semibold">{t.name}</span>
                <span className="win-caption truncate font-mono text-muted-foreground">{t.roster.join(' ')}</span>
              </button>
            ))}
            {!botCatalog && <p className="win-caption text-muted-foreground">职业队目录加载中…</p>}
            {proteamBlocked && (
              <p className="win-caption text-muted-foreground">{room.teamBName} 空位不足 5 个，无法整队添加</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-[var(--divider)] pt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="bot-aim">瞄准模式（bot_aim）</Label>
            <Select
              value={room.botAim ?? 'mixed'}
              onValueChange={(v) => updateBotConfig(room.id, { botAim: v as BotAimMode })}
              disabled={!editable}
            >
              <SelectTrigger id="bot-aim">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(BOT_AIM_LABELS) as BotAimMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {BOT_AIM_LABELS[m]}
                    {m === 'mixed' && '（默认）'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="win-caption text-muted-foreground">控制人机的瞄准部位策略</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bot-nades">道具模式（bot_nades）</Label>
            <Select
              value={room.botNades ?? 'normal'}
              onValueChange={(v) => updateBotConfig(room.id, { botNades: v as BotNadeMode })}
              disabled={!editable}
            >
              <SelectTrigger id="bot-nades">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(BOT_NADES_LABELS) as BotNadeMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {BOT_NADES_LABELS[m]}
                    {m === 'normal' && '（默认）'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="win-caption text-muted-foreground">「地狱道具」将解除投掷物数量限制</p>
          </div>
        </div>
        {!isHost && <p className="win-caption text-muted-foreground">人机的添加与调优由房主管理</p>}
        {isHost && (
          <p className="win-caption text-muted-foreground">
            {room.teamBName} 开赛缺员时将自动补满随机人机
          </p>
        )}
      </div>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>清空全部人机</DialogTitle>
            <DialogDescription>
              将移除两队的全部 {teamABots + teamBBots} 名人机，并重置职业队标记；真人玩家不受影响
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                removeBots(room.id)
                setClearOpen(false)
              }}
            >
              确认清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
