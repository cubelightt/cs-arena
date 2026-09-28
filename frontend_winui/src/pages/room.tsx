// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, SlidersHorizontal } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/winui/avatar'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { InfoBar } from '@/components/winui/info-bar'
import { Ring } from '@/components/winui/progress'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/winui/select'
import { Checkbox } from '@/components/winui/switch'
import { MapCard } from '@/components/match/map-card'
import { RoomAdvancedSettingsDialog } from '@/components/match/advanced-settings-dialog'
import { BotManagementPanel } from '@/components/match/bot-panel'
import { RoomSlotsPanel } from '@/components/match/slot-panel'
import { VetoPanel } from '@/components/match/veto-panel'
import { NumberBox } from '@/components/winui/number-box'
import { useArena } from '@/stores/arena'
import { copyText } from '@/lib/clipboard'
import { api, joinRoomChannel, leaveRoomChannel, onRoomRemoved } from '@/lib/api'
import {
  DUEL_PRESET_LABELS,
  DUEL_SOLO_PHASE_ROUNDS,
  MATCH_TYPE_LABELS,
  SPEC_SEAT_OPTIONS,
  TEAM_COUNT_OPTIONS,
  specSeatLabel,
  type BestOf,
  type DuelPreset,
  type HealthSnapshot,
  type MaintenanceInfo,
  type MapPoolKind,
  type PickMode,
  type ServerGroup,
} from '@/lib/types'
import { mapDefOf } from '@/lib/maps'

const STATUS_META: Record<string, { label: string; variant: 'success' | 'info' | 'destructive' | 'secondary' }> = {
  waiting: { label: '等待中', variant: 'success' },
  vetoing: { label: '选图中', variant: 'info' },
  starting: { label: '开赛中', variant: 'info' },
  live: { label: '进行中', variant: 'destructive' },
  finished: { label: '已结束', variant: 'secondary' },
}

/** Solo三项总回合数 = 三段之和（后端固定 10+28+13=51，先到 26 胜） */
const SOLO_TOTAL_ROUNDS = Object.values(DUEL_SOLO_PHASE_ROUNDS).reduce((a, b) => a + b, 0)

export function RoomPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const room = useArena((s) => s.rooms.find((r) => r.id === id))
  const currentUser = useArena((s) => s.currentUser)
  const fetchRoom = useArena((s) => s.fetchRoom)
  const leaveRoom = useArena((s) => s.leaveRoom)
  const setTeam = useArena((s) => s.setTeam)
  const updateConfig = useArena((s) => s.updateConfig)
  const toggleDirectPick = useArena((s) => s.toggleDirectPick)
  const startVeto = useArena((s) => s.startVeto)
  const resetVeto = useArena((s) => s.resetVeto)
  const startMatch = useArena((s) => s.startMatch)
  const toast = useArena((s) => s.toast)
  const fetchCommunityMaps = useArena((s) => s.fetchCommunityMaps)
  const [passwordInput, setPasswordInput] = useState('')
  const [teamANameInput, setTeamANameInput] = useState('')
  const [teamBNameInput, setTeamBNameInput] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [botNoticeOpen, setBotNoticeOpen] = useState(true)

  // 社区地图模式时刷新社区目录（管理员刚录入的图可能不在本端 store）
  useEffect(() => {
    if (room?.pickMode === 'community') fetchCommunityMaps()
  }, [room?.id, room?.pickMode, fetchCommunityMaps])

  // 队名输入框随房间数据同步（仅当输入框不是聚焦编辑状态时）
  useEffect(() => {
    if (room) {
      setTeamANameInput(room.teamAName || 'TEAM A')
      setTeamBNameInput(room.teamBName || 'TEAM B')
    }
  }, [room?.id, room?.teamAName, room?.teamBName])

  const saveTeamNames = async () => {
    if (!room) return
    const a = teamANameInput.trim()
    const b = teamBNameInput.trim()
    if (a === room.teamAName && b === room.teamBName) return
    await updateConfig(room.id, {
      teamAName: a || 'TEAM A',
      teamBName: b || 'TEAM B',
    })
  }

  const roomId = id ?? ''

  // 关闭/刷新页面前弹出浏览器级确认（房间内防误关）。
  // 即便强关，socket 断开超宽限期（默认 30s，ROOM_DISCONNECT_GRACE_MS）后由后端自动退房
  useEffect(() => {
    if (!roomId) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [roomId])

  useEffect(() => {
    if (!roomId) return
    fetchRoom(roomId)
    joinRoomChannel(roomId)
    const unsubRemoved = onRoomRemoved((rid) => {
      if (rid === roomId) navigate('/lobby')
    })
    return () => {
      leaveRoomChannel(roomId)
      unsubRemoved()
    }
  }, [roomId, fetchRoom, navigate])

  // 开赛自动跳转：房间状态跃迁到 live 时直接进比赛页（非房主无需再点「进入比赛」）。
  // 开赛会走 waiting → starting → live，所以两个前态都算；只认「状态跃迁」而不是「当前是 live」，
  // 否则比赛期间从比赛页返回房间页看阵容会被立刻弹回去。
  const prevStatusRef = useRef<string | null>(null)
  useEffect(() => {
    const status = room?.status ?? null
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (roomId && status === 'live' && (prev === 'waiting' || prev === 'starting')) navigate(`/match/${roomId}`)
  }, [room?.status, roomId, navigate])

  const isHost = room?.hostId === currentUser?.steamId
  const me = useMemo(
    () => room?.slots.find((s) => s.player.steamId === currentUser?.steamId),
    [room, currentUser?.steamId],
  )
  const filled = room ? room.slots.filter((s) => s.team !== 'spec').length : 0
  const total = room ? room.teamA + room.teamB : 0

  // 存量单挑房可能停留在 BP（旧版本开放过单挑切换选图方式）：单挑对决只支持直接选图，
  // 房主在房时自动纠正一次——后端 waiting/vetoing 均允许改配置，切换会同步换池并清空 BP 状态。
  // ref 防并发广播下的重复提交（pickMode=direct 幂等，重复提交无副作用）；提交失败由 store
  // 统一 toast，刷新页面会重试；非房主无权改，等房主进房纠正后经 room:update 广播同步。
  const pickModeFixedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!room || room.matchType !== 'duel' || room.pickMode === 'direct') return
    if (!isHost || (room.status !== 'waiting' && room.status !== 'vetoing')) return
    if (pickModeFixedRef.current === room.id) return
    pickModeFixedRef.current = room.id
    updateConfig(room.id, { pickMode: 'direct' })
    toast('已自动切换为直接选图', '单挑对决仅支持直接选图')
  }, [room, isHost, updateConfig, toast])

  // 服务器选择（等待期拉取：房主要用，成员只读展示；普通用户后端已过滤 admin_only 实例）
  const [serverGroups, setServerGroups] = useState<ServerGroup[]>([])
  useEffect(() => {
    if (room?.status !== 'waiting') return
    let cancelled = false
    api
      .get<ServerGroup[]>('/api/servers/status')
      .then((g) => {
        if (!cancelled) setServerGroups(g)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [room?.status, room?.id])

  // 按组维护态：/api/health 已带 maintenance[]，等待期 5s 轮询——开赛按钮据此提前置灰
  // （最终判定在后端：组维护中开赛一律 409，这里只是提示，避免房主白点）
  const [maintenance, setMaintenance] = useState<MaintenanceInfo[]>([])
  useEffect(() => {
    if (room?.status !== 'waiting') return
    let cancelled = false
    const fetchHealth = () =>
      api
        .get<HealthSnapshot>('/api/health')
        .then((h) => {
          if (!cancelled) setMaintenance(h.maintenance ?? [])
        })
        .catch(() => {})
    fetchHealth()
    const timer = setInterval(() => {
      if (!document.hidden) fetchHealth()
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [room?.status, room?.id])

  const setServerChoice = useArena((s) => s.setServerChoice)
  const swapRespond = useArena((s) => s.swapRespond)
  const shuffleTeams = useArena((s) => s.shuffleTeams)
  const maps = useArena((s) => s.maps)
  const serverChoice = room?.serverChoice ?? { mode: 'auto', group: null, instance: null }
  const selGroup = serverChoice.mode === 'manual' ? serverChoice.group : null
  const currentGroup = serverGroups.find((g) => g.groupId === selGroup) ?? null

  // 模式 draft：切换 manual 不立即提交（后端要求 manual 必须带 group，选组时一并提交）
  const [modeDraft, setModeDraft] = useState<'auto' | 'manual'>(serverChoice.mode)
  useEffect(() => {
    setModeDraft(room?.serverChoice?.mode ?? 'auto')
  }, [room?.serverChoice?.mode])

  const changeServerMode = (m: 'auto' | 'manual') => {
    setModeDraft(m)
    if (m === 'auto' && room) {
      setServerChoice(room.id, { mode: 'auto' })
    }
  }
  const changeServerGroup = (g: string) => room && setServerChoice(room.id, { mode: 'manual', group: g })
  const pickServerInstance = (inst: string) =>
    room && setServerChoice(room.id, { mode: 'manual', group: selGroup ?? '', instance: inst })

  // 维护中的组：手动选择看该组；自动分配看是否**全部**活跃组都在维护（有任意一组可用就能开）
  // 自动分配时后端会自己挑可用组，前端只在无组可用时提前置灰
  const maintenanceGroups = useMemo(() => new Set(maintenance.map((m) => m.groupId)), [maintenance])
  const manualGroupId = room?.serverChoice?.mode === 'manual' ? room.serverChoice.group : null
  const maintenanceHit = useMemo(() => {
    if (manualGroupId) return maintenance.find((m) => m.groupId === manualGroupId) ?? null
    if (serverGroups.length > 0 && serverGroups.every((g) => maintenanceGroups.has(g.groupId))) {
      return maintenance.find((m) => maintenanceGroups.has(m.groupId)) ?? null
    }
    return null
  }, [maintenance, maintenanceGroups, manualGroupId, serverGroups])

  // 随机分队弹窗
  const [shuffleOpen, setShuffleOpen] = useState(false)
  const [shuffleIncludeCaptains, setShuffleIncludeCaptains] = useState(true)

  const pending = room?.pendingSwap ?? null
  const meIsSwapTarget = pending?.targetPlayerId === currentUser?.steamId
  const meIsSwapFrom = pending?.fromPlayerId === currentUser?.steamId
  const swapFromPlayerObj = room?.slots.find((s) => s.player.steamId === pending?.fromPlayerId)
  const swapTargetPlayerObj = room?.slots.find((s) => s.player.steamId === pending?.targetPlayerId)
  const [pendingCountdown, setPendingCountdown] = useState<number | null>(null)
  useEffect(() => {
    if (!pending) {
      setPendingCountdown(null)
      return
    }
    const calc = () => setPendingCountdown(Math.max(0, Math.ceil((pending.at + 60000 - Date.now()) / 1000)))
    calc()
    const t = setInterval(calc, 1000)
    return () => clearInterval(t)
  }, [pending?.id, pending?.at])

  if (!room) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <p className="text-muted-foreground">房间不存在或已被解散</p>
        <Button variant="secondary" onClick={() => navigate('/lobby')}>
          返回大厅
        </Button>
      </div>
    )
  }

  const status = STATUS_META[room.status] ?? { label: room.status, variant: 'secondary' }
  const remainingMaps = room.mapPool.filter((id) => !room.banned.includes(id) && !room.picked.includes(id))

  const copyCode = async () => {
    const ok = await copyText(room.code)
    toast(ok ? '房间码已复制' : '复制失败', ok ? `房间码：${room.code}` : '请手动复制房间码', ok ? 'default' : 'error')
  }

  const handleRestartVeto = async () => {
    await resetVeto(room.id)
    await startVeto(room.id)
  }

  const handleStart = async () => {
    if (room.status === 'vetoing') return
    if (room.pickMode === 'veto' && room.picked.length === 0) {
      await startVeto(room.id)
    } else {
      try {
        await startMatch(room.id)
        navigate(`/match/${room.id}`)
      } catch (e) {
        toast('开赛失败', e instanceof Error ? e.message : String(e), 'error')
      }
    }
  }

  const savePassword = async () => {
    await updateConfig(room.id, { password: passwordInput.trim() || undefined })
    setPasswordInput('')
    toast('房间密码已更新')
  }

  const handleLeave = async () => {
    const res = await leaveRoom(room.id)
    if (res.deleted || !isHost) {
      navigate('/lobby')
    }
  }

  const pickModeLabel = room.pickMode === 'veto' ? 'BP选图' : room.pickMode === 'community' ? '社区地图' : '直接选图'
  // Solo三项：阶段回合数后端固定（10/28/13），maxRounds 锁定 51 禁改，单框切换为只读三段展示
  const isSolo = (room.duelPreset ?? 'rifle') === 'solo'
  // 直接选图池：duel 房按「地图池选择」（缺省=总竞技图池，与后端一致）；其余情形沿用原口径
  const poolLabel =
    room.pickMode === 'veto'
      ? '服役池'
      : room.pickMode === 'community'
        ? '社区池'
        : room.matchType === 'duel' && (room.mapPoolKind ?? 'total') === 'duel'
          ? '单挑图池'
          : '总竞技池'
  // 席位选项 0~5（0=禁止观战）；当前值若不在选项里（单挑房默认 6 / 旧房间）补进列表，否则下拉框会显示为空
  const specSeatOptions = SPEC_SEAT_OPTIONS.includes(room.specSeats)
    ? SPEC_SEAT_OPTIONS
    : [...SPEC_SEAT_OPTIONS, room.specSeats].sort((a, b) => a - b)
  const specCount = room.slots.filter((s) => s.team === 'spec').length

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Button variant="subtle" size="icon" className="-ml-2 mt-0.5" aria-label="返回大厅" onClick={() => navigate('/lobby')}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="win-title">{room.name}</h1>
              <Badge variant={status.variant}>
                {(room.status === 'live' || room.status === 'vetoing') && (
                  <span className="win-dot-live size-1.5 rounded-full bg-current" />
                )}
                {status.label}
              </Badge>
              {room.botMode && <Badge variant="info">增强人机</Badge>}
              {room.password && <Badge variant="secondary">私密</Badge>}
            </div>
            <p className="win-caption mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>
                房间码{' '}
                <button
                  className="cursor-pointer font-mono font-semibold tracking-widest text-[var(--accent-text)] hover:underline"
                  onClick={copyCode}
                >
                  {room.code}
                </button>
                <button
                  className="ml-2 cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
                  onClick={copyCode}
                >
                  复制
                </button>
              </span>
              <span>{MATCH_TYPE_LABELS[room.matchType]}</span>
              <span>
                {room.teamAName} ×{room.teamA} · {room.teamBName} ×{room.teamB}
              </span>
              <span>BO{room.bestOf}</span>
              <span>{pickModeLabel}</span>
              <span>
                {poolLabel} {room.mapPool.length} 张
              </span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isHost && room.status === 'waiting' ? (
            <>
              {room.pickMode === 'veto' && room.picked.length > 0 && (
                <Button variant="subtle" size="sm" onClick={handleRestartVeto}>
                  重新 BP
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleStart}
                disabled={
                  maintenanceHit !== null || ((room.pickMode === 'direct' || room.pickMode === 'community') && room.picked.length === 0)
                }
                title={maintenanceHit ? `该服务器组维护中：${maintenanceHit.reason ?? '更新/维护'}，暂不能开赛` : undefined}
              >
                {room.pickMode === 'veto' && room.picked.length === 0 ? '开始 BP 选图' : '开始对战'}
              </Button>
            </>
          ) : (
            me?.team !== 'spec' &&
            room.status === 'waiting' &&
            // 席位数 0 = 禁止观战：不提供入口（否则点下去只会收到「房间已满」）
            room.specSeats > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setTeam(room.id, 'spec')}>
                加入观战席
              </Button>
            )
          )}
          {me?.team === 'spec' && room.status === 'waiting' && (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setTeam(room.id, 'ct')}>
                加入 {room.teamAName}
              </Button>
              {!room.botMode && (
                <Button size="sm" variant="secondary" onClick={() => setTeam(room.id, 't')}>
                  加入 {room.teamBName}
                </Button>
              )}
            </div>
          )}
          {!isHost && room.status === 'waiting' && (
            <Button size="sm" variant="secondary" onClick={handleLeave}>
              退出
            </Button>
          )}
          {room.status === 'live' && (
            <Button size="sm" onClick={() => navigate(`/match/${room.id}`)}>
              进入比赛
            </Button>
          )}
        </div>
      </div>

      {/* 增强人机为测试特性：房间顶部提示（可关闭，关闭后本次进入房间内不再显示） */}
      {room.botMode && botNoticeOpen && (
        <InfoBar
          severity="info"
          title="注意"
          message="当前的增强人机处于测试阶段，存在部分bug以及不确定的性能问题！"
          onClose={() => setBotNoticeOpen(false)}
        />
      )}

      {/* 该组维护中（M4）：开赛按钮已置灰；最终判定在后端（组维护中开赛一律 409） */}
      {room.status === 'waiting' && maintenanceHit && (
        <InfoBar
          severity="caution"
          title="服务器组维护中"
          message={`${manualGroupId ? `服务器组 ${manualGroupId} ` : '全部服务器组'}维护中：${
            maintenanceHit.reason ?? '更新/维护'
          }——开赛与实例启停已暂时禁用，任务结束后自动恢复。`}
        />
      )}

      {/* 玩家展示：槽位面板置顶（点击空槽直接换位 / 右键玩家弹菜单） */}
      <RoomSlotsPanel room={room} onShuffle={room.botMode ? undefined : () => setShuffleOpen(true)} />

      {/* 增强人机：人机管理面板（添加/清空/调优；管理操作仅房主可用，准备阶段开放） */}
      {room.botMode && (room.status === 'waiting' || room.status === 'vetoing') && <BotManagementPanel room={room} />}

      {room.status === 'starting' && (
        // 进度环按用户给的参考图放大到约占条高 5/6（48px 环 + py-1.5 → 条高 60、比值 0.8）
        <InfoBar
          severity="info"
          title="正在初始化服务器进程…"
          message="实例启动 / 插件加载 / 比赛配置下发中，请稍候"
          className="py-1.5"
          trailing={<Ring size={48} />}
        />
      )}

      <div className="win-caption flex flex-wrap items-center gap-x-6 gap-y-1 text-muted-foreground">
        <span>
          已加入 <b className="font-mono text-foreground">{filled}</b>/{total}
        </span>
        <span>
          {room.specSeats > 0 ? `观战席 ${specCount}/${room.specSeats}` : '禁止观战'}
        </span>
        {room.password && <span>已设密码</span>}
        {/* 刀战选边开关已从单挑房移除（恒为后端默认开启），概览提示随之只保留给可配置的自定义房 */}
        {room.knifeRound && room.bestOf === 1 && room.pickMode !== 'veto' && room.matchType !== 'duel' && (
          <span>刀战选边已开启</span>
        )}
        {room.friendlyFire === false && <span>友军伤害已关闭</span>}
      </div>

      {/* 房间设置：全体成员可见（含观战席），但仅房主可改；非房主控件置灰 */}
      {room.status === 'waiting' && (
        <Card>
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="win-meta">房间设置</p>
              {!isHost && <p className="win-caption text-muted-foreground">仅房主可修改</p>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="win-form-cell">
                <Label>Team A 名称</Label>
                <Input
                  value={teamANameInput}
                  placeholder="TEAM A"
                  maxLength={32}
                  disabled={!isHost}
                  onChange={(e) => setTeamANameInput(e.target.value)}
                  onBlur={() => saveTeamNames()}
                />
              </div>
              <div className="win-form-cell">
                <Label>Team B 名称</Label>
                <Input
                  value={teamBNameInput}
                  placeholder="TEAM B"
                  maxLength={32}
                  disabled={!isHost}
                  onChange={(e) => setTeamBNameInput(e.target.value)}
                  onBlur={() => saveTeamNames()}
                />
              </div>
              {room.matchType === 'custom' && (
                <div className="win-form-cell">
                  <Label>Team A 人数（反恐精英）</Label>
                  <Select
                    value={String(room.teamA)}
                    onValueChange={(v) => updateConfig(room.id, { teamA: Number(v) })}
                    disabled={!isHost}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEAM_COUNT_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n} 人
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {/* 选图方式仅自定义竞技提供（单挑对决固定直接选图，不渲染选框）；
                  删除后单挑房「赛制」自然流到本格原位置（第一行第三列） */}
              {room.matchType === 'custom' && (
                <div className="win-form-cell">
                  <Label>选图方式</Label>
                  <Select
                    value={room.pickMode}
                    onValueChange={(v) => updateConfig(room.id, { pickMode: v as PickMode })}
                    disabled={!isHost}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="veto">BP选图</SelectItem>
                      <SelectItem value="direct">直接选图</SelectItem>
                      <SelectItem value="community">社区地图</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="win-form-cell">
                <Label>赛制</Label>
                <Select
                  value={String(room.bestOf)}
                  onValueChange={(v) => updateConfig(room.id, { bestOf: Number(v) as BestOf })}
                  disabled={!isHost || room.pickMode === 'community' || room.botMode}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">BO1</SelectItem>
                    <SelectItem value="3">BO3</SelectItem>
                  </SelectContent>
                </Select>
                {room.pickMode === 'community' && (
                  <p className="win-caption text-muted-foreground">社区地图模式固定 BO1，仅可选择 1 张地图</p>
                )}
              </div>
              {room.matchType === 'duel' ? (
                <>
                  {/* 对决类型（duelPreset）：经 POST /config 提交（rifle/pistol/sniper/solo）。
                      auto 放置落到第二排第一列（用户红框处） */}
                  <div className="win-form-cell">
                    <Label>对决类型</Label>
                    <Select
                      value={room.duelPreset ?? 'rifle'}
                      onValueChange={(v) => updateConfig(room.id, { duelPreset: v as DuelPreset })}
                      disabled={!isHost}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(DUEL_PRESET_LABELS) as DuelPreset[]).map((t) => (
                          <SelectItem key={t} value={t}>
                            {DUEL_PRESET_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* 地图池在第二排中列、观战席在右列（用户指定）。
                      定位列项按 DOM 顺序放置：col-start-2 的地图池必须在前，观战席 col-start-3
                      才会落到同一排第三列（顺序颠倒会把地图池挤到第三行） */}
                  <div className="win-form-cell lg:col-start-2">
                    <Label>地图池选择</Label>
                    <Select
                      value={room.mapPoolKind ?? 'total'}
                      onValueChange={(v) => updateConfig(room.id, { mapPoolKind: v as MapPoolKind })}
                      disabled={!isHost}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="total">总竞技图池</SelectItem>
                        <SelectItem value="duel">单挑图池</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="win-form-cell lg:col-start-3">
                    <Label>观战席数量</Label>
                    <Select
                      value={String(room.specSeats)}
                      onValueChange={(v) => updateConfig(room.id, { specSeats: Number(v) })}
                      disabled={!isHost}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {specSeatOptions.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {specSeatLabel(n)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* 回合数设置：无微调按钮的紧凑数字框（比右侧文字略大），文字与表单标题同字号。
                      非 Solo：单框走已就绪的 maxRounds 接口（1~101 奇数，开赛下发 mp_maxrounds；
                      前端上限 99），pt-[26px] = 标题行高 20px + 间距 6px，让数字框与同一排
                      「房间密码」的输入框在同一水平线上。
                      Solo：标题位显示「共 51 回合 26 胜」（三段之和），三段回合数后端固定
                      （arena_duel_phase_* cvars）为只读展示，maxRounds 由后端锁定 51。
                      auto 放置：观战席后光标越界换行 → 第三排第一列 */}
                  {isSolo ? (
                    <div className="win-form-cell">
                      <p className="win-body-strong text-foreground">
                        共 {SOLO_TOTAL_ROUNDS} 回合 {Math.floor((SOLO_TOTAL_ROUNDS + 1) / 2)} 胜
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        {(
                          [
                            ['pistol', '手枪'],
                            ['rifle', '长枪'],
                            ['sniper', '狙击'],
                          ] as const
                        ).map(([key, label]) => (
                          <span key={key} className="flex items-center gap-1.5">
                            <NumberBox
                              className="win-numberbox--sm"
                              aria-label={`${label}回合数`}
                              value={DUEL_SOLO_PHASE_ROUNDS[key]}
                              min={1}
                              max={99}
                              spinButtons={false}
                              // Solo 阶段回合数后端固定不可配（arena_duel_phase_* cvars），只读展示
                              disabled
                              onValueChange={() => {}}
                            />
                            <span className="win-body-strong text-foreground">{label}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="win-form-cell pt-[26px]">
                      <div className="flex items-center gap-1.5">
                        <NumberBox
                          className="win-numberbox--sm"
                          aria-label="最大回合数"
                          value={room.maxRounds ?? 31}
                          min={1}
                          max={99}
                          step={2}
                          spinButtons={false}
                          disabled={!isHost}
                          // 后端要求奇数（偶数打满无法分辨胜负，400）：↑↓ 步长 2 保证奇数序列，
                          // 手输偶数由后端拒绝并 toast，NumberBox 受控回退到房间当前值
                          onValueChange={(v) => updateConfig(room.id, { maxRounds: v })}
                        />
                        <span className="win-body-strong text-foreground">
                          回合 {Math.floor(((room.maxRounds ?? 31) + 1) / 2)} 胜
                        </span>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="win-form-cell">
                    <Label>Team B 人数（恐怖分子）</Label>
                    <Select
                      value={String(room.teamB)}
                      onValueChange={(v) => updateConfig(room.id, { teamB: Number(v) })}
                      disabled={!isHost}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TEAM_COUNT_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n} 人
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="win-form-cell">
                    <Label>观战席数量</Label>
                    <Select
                      value={String(room.specSeats)}
                      onValueChange={(v) => updateConfig(room.id, { specSeats: Number(v) })}
                      disabled={!isHost}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {specSeatOptions.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {specSeatLabel(n)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
              {/* 房间密码固定在「更多设置」左侧一列（lg col 2）：自定义竞技为自然流位置；
                  单挑对决原位置让给「地图池选择」，显式定位与自定义竞技对齐 */}
              <div className="win-form-cell lg:col-start-2">
                <Label>房间密码（可选）</Label>
                <div className="flex gap-2">
                  {/* 密码明文只给房主：成员侧不绑定房间密码值，仅显示「是否已设置」 */}
                  <Input
                    placeholder={isHost ? '设置后需密码加入' : room.password ? '已设置密码（仅房主可查看）' : '未设置密码'}
                    value={isHost ? passwordInput : ''}
                    disabled={!isHost}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    maxLength={12}
                    onKeyDown={(e) => e.key === 'Enter' && savePassword()}
                  />
                  <Button variant="secondary" size="sm" className="shrink-0" onClick={savePassword} disabled={!isHost}>
                    保存
                  </Button>
                </div>
              </div>
              <div className="flex items-end lg:col-start-3">
                <Button variant="secondary" className="w-full" onClick={() => setAdvancedOpen(true)}>
                  <SlidersHorizontal className="size-4" />
                  更多设置
                </Button>
              </div>
            </div>

            <div className="mt-1 flex flex-col gap-3 border-t border-[var(--divider)] pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="win-meta">服务器选择</p>
                {!isHost && <p className="win-caption text-muted-foreground">仅房主可修改</p>}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="win-form-cell">
                  <Label>分配模式</Label>
                  <Select
                    value={modeDraft}
                    onValueChange={(v) => changeServerMode(v as 'auto' | 'manual')}
                    disabled={!isHost}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动分配</SelectItem>
                      <SelectItem value="manual">手动选择</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {modeDraft === 'manual' && (
                  <div className="win-form-cell">
                    <Label>服务器组</Label>
                    <Select value={selGroup ?? ''} onValueChange={(v) => changeServerGroup(v)} disabled={!isHost}>
                      <SelectTrigger>
                        <SelectValue placeholder="选择服务器组" />
                      </SelectTrigger>
                      <SelectContent>
                        {serverGroups.map((g) => (
                          <SelectItem key={g.groupId} value={g.groupId}>
                            {g.groupName}（{g.region}）
                          </SelectItem>
                        ))}
                        {serverGroups.length === 0 && (
                          <SelectItem value="__none" disabled>
                            暂无可用组
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {modeDraft === 'manual' && currentGroup && (
                <div className="flex flex-col gap-1.5">
                  <Label>实例（{currentGroup.groupName}）</Label>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {currentGroup.servers.map((s) => {
                      // 增强人机房仅人机实例（s.botCapable，装有 CS2-Bot-Improver）可选；非房主一律不可选
                      const disabled = !isHost || s.health !== 'RUNNING' || (room.botMode && !s.botCapable)
                      const selected = serverChoice.instance === s.name
                      return (
                        <button
                          key={s.name}
                          type="button"
                          disabled={disabled}
                          onClick={() => pickServerInstance(s.name)}
                          className={`flex cursor-pointer flex-col gap-1 rounded-[4px] border p-2.5 text-left transition-colors ${
                            selected
                              ? 'border-[var(--accent)] bg-[var(--subtle-secondary)]'
                              : 'border-[var(--card-stroke)] hover:bg-[var(--subtle-secondary)]'
                          } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="win-caption font-mono font-semibold">{s.name}</span>
                            {s.botCapable && <Badge variant="info">人机</Badge>}
                            {s.adminOnly && <Badge variant="info">仅管理员</Badge>}
                          </span>
                          <span className="win-caption flex items-center gap-2 text-muted-foreground">
                            <span
                              className={
                                s.status === 'idle'
                                  ? 'rounded-[4px] bg-[var(--success-bg)] px-1 py-px text-[var(--success)]'
                                  : s.status === 'in_match'
                                    ? 'rounded-[4px] bg-[var(--critical-bg)] px-1 py-px text-[var(--critical)]'
                                    : s.status === 'stopped'
                                      ? 'rounded-[4px] bg-[var(--subtle-secondary)] px-1 py-px text-muted-foreground'
                                      : 'rounded-[4px] bg-[var(--subtle-secondary)] px-1 py-px text-[var(--accent-text)]'
                              }
                            >
                              {s.statusLabel}
                            </span>
                            <span className="font-mono">{s.health}</span>
                            {s.port ? <span className="font-mono">:{s.port}</span> : null}
                          </span>
                        </button>
                      )
                    })}
                    {currentGroup.servers.length === 0 && (
                      <p className="win-caption text-muted-foreground">该组暂无可用实例</p>
                    )}
                  </div>
                </div>
              )}

              <p className="win-caption text-muted-foreground">
                当前：
                {serverChoice.mode === 'auto'
                  ? '自动分配'
                  : `手动：${currentGroup?.groupName ?? selGroup ?? '未选择组'} / ${serverChoice.instance ?? '未选择实例'}`}
              </p>
            </div>
          </div>
        </Card>
      )}

      {(room.pickMode === 'direct' || room.pickMode === 'community') && room.status === 'waiting' && (
        <Card>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <p className="win-meta">{room.pickMode === 'community' ? '社区地图模式' : '直接选图模式'}</p>
              <Badge variant="secondary" className="font-mono">
                {room.pickMode === 'community'
                  ? `已选 ${room.picked.length}/1`
                  : room.bestOf === 1
                    ? `已选 ${room.picked.length} 张`
                    : `已选 ${room.picked.length}/${room.bestOf}`}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {room.mapPool.map((id) => {
                const idx = room.picked.indexOf(id)
                const isPicked = idx !== -1
                return (
                  <MapCard
                    key={id}
                    mapId={id}
                    state={isPicked ? 'picked' : 'available'}
                    pickOrder={isPicked ? idx + 1 : undefined}
                    compact
                    onClick={isHost ? () => toggleDirectPick(room.id, id) : undefined}
                  />
                )
              })}
            </div>
            <p className="win-caption text-muted-foreground">
              {isHost
                ? room.pickMode === 'community'
                  ? '社区地图模式仅可选择 1 张地图（固定 BO1）'
                  : room.bestOf === 1
                    ? '可多选地图，开赛时将随机确定本场地图'
                    : '点击地图选择本场比赛地图，选满后点击右上角「开始对战」'
                : room.pickMode === 'community'
                  ? '等待房主选择社区地图…'
                  : '等待房主勾选比赛地图…'}
            </p>
          </div>
        </Card>
      )}

      {room.pickMode === 'veto' && <VetoPanel room={room} />}

      {room.pickMode === 'veto' && room.picked.length > 0 && (
        <Card>
          <div className="flex flex-col gap-3 p-4">
            <p className="win-meta">比赛地图</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {room.picked.map((mapId, i) => (
                <MapCard key={mapId} mapId={mapId} state="picked" pickOrder={i + 1} compact />
              ))}
              {Array.from({ length: Math.max(0, room.bestOf - room.picked.length) }).map((_, i) => (
                <div
                  key={`pending-${i}`}
                  className="win-caption flex aspect-[16/9] items-center justify-center rounded-lg border border-dashed border-[var(--control-strong-stroke)] text-muted-foreground"
                >
                  {room.status === 'vetoing' ? `第 ${room.picked.length + i + 1} 张待定` : '待选图'}
                </div>
              ))}
            </div>
            {room.pickMode === 'veto' && remainingMaps.length === 1 && room.status === 'waiting' && (
              <p className="win-caption text-muted-foreground">
                剩余地图自动成为比赛地图：<b className="text-[var(--success)]">{mapDefOf(maps, remainingMaps[0]).displayName}</b>
              </p>
            )}
            {Object.keys(room.sideChoices ?? {}).length > 0 && (
              <div className="win-caption flex flex-wrap items-center gap-2">
                {Object.entries(room.sideChoices ?? {})
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([idx, val]) => {
                    const mapIndex = Number(idx)
                    const isTeam1 = val.startsWith('team1')
                    const side = val.endsWith('_ct') ? 'CT' : 'T'
                    const teamName = isTeam1 ? room.teamAName : room.teamBName
                    const def = room.picked[mapIndex] ? mapDefOf(maps, room.picked[mapIndex]) : null
                    return (
                      <Badge key={idx} variant="secondary">
                        图{mapIndex + 1} {def?.displayName ?? ''} · {teamName} 先 {side}
                      </Badge>
                    )
                  })}
                {room.bestOf === 3 && room.picked.length >= 2 && <Badge variant="info">图3 · 刀局选边</Badge>}
              </div>
            )}
          </div>
        </Card>
      )}

      {isHost && room.status === 'waiting' && room.pickMode === 'veto' && room.picked.length > 0 && (
        <InfoBar severity="success" message="选图完成，点击右上角「开始对战」创建服务器。" />
      )}

      {isHost && (
        <Button variant="destructive" size="sm" className="self-end" onClick={handleLeave}>
          解散房间
        </Button>
      )}

      {pending && (meIsSwapTarget || meIsSwapFrom) && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent className="max-w-[440px]">
            <DialogHeader>
              <DialogTitle>{meIsSwapTarget ? '换位申请' : '换位申请已发送'}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              {meIsSwapTarget ? (
                <>
                  <Avatar className="size-14">
                    <AvatarImage src={swapFromPlayerObj?.player.avatarUrl} />
                    <AvatarFallback>{swapFromPlayerObj?.player.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <p className="win-subtitle">{swapFromPlayerObj?.player.name} 想与你换位</p>
                  <p className="win-caption text-muted-foreground">同意后双方互换位置（{pendingCountdown}s 后过期）</p>
                  <div className="flex gap-3 pt-2">
                    <Button size="lg" onClick={() => swapRespond(room.id, pending.fromPlayerId, true)}>
                      同意换位
                    </Button>
                    <Button size="lg" variant="secondary" onClick={() => swapRespond(room.id, pending.fromPlayerId, false)}>
                      拒绝
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Avatar className="size-14">
                    <AvatarImage src={swapTargetPlayerObj?.player.avatarUrl} />
                    <AvatarFallback>{swapTargetPlayerObj?.player.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <p className="win-subtitle">已向 {swapTargetPlayerObj?.player.name} 发送换位申请</p>
                  <p className="win-caption text-muted-foreground">等待对方确认（{pendingCountdown}s 后过期）</p>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={shuffleOpen} onOpenChange={setShuffleOpen}>
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>随机分队</DialogTitle>
            <DialogDescription>打乱队员并随机分配至两个队伍（观战席不参与；至少 2 名队员换队）</DialogDescription>
          </DialogHeader>
          <label className="win-body flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={shuffleIncludeCaptains}
              onChange={(e) => setShuffleIncludeCaptains(e.target.checked)}
            />
            队长参与随机
          </label>
          <p className="win-caption text-muted-foreground">取消勾选则两队队长留在本队，不参与洗牌</p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShuffleOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                shuffleTeams(room.id, shuffleIncludeCaptains)
                setShuffleOpen(false)
              }}
            >
              确认随机
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RoomAdvancedSettingsDialog
        room={room}
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        canEdit={isHost}
        canAdmin={currentUser?.isAdmin === true}
      />
    </div>
  )
}
