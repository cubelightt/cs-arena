// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, Copy } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { MapCard } from '@/components/match/map-card'
import { TeamPanel, SpecPanel } from '@/components/match/team-panel'
import { useArena } from '@/stores/arena'
import { copyText } from '@/lib/clipboard'
import { api, joinRoomChannel, leaveRoomChannel } from '@/lib/api'
import { mapDefOf } from '@/lib/maps'
import { MATCH_TYPE_LABELS, type RoomStatusResponse, type ServerGroup } from '@/lib/types'

export function MatchPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const room = useArena((s) => s.rooms.find((r) => r.id === id))
  const currentUser = useArena((s) => s.currentUser)
  const resetRoom = useArena((s) => s.resetRoom)
  const fetchRoom = useArena((s) => s.fetchRoom)
  const scores = useArena((s) => (id ? s.latestScores[id] : undefined))
  const finalMap = useArena((s) => (id ? s.finalMaps[id] : undefined))
  const allocatedInstance = useArena((s) => (id ? s.matchServers[id] : undefined))
  const maps = useArena((s) => s.maps)
  const communityMaps = useArena((s) => s.communityMaps)
  const spectate = useArena((s) => s.spectate)
  const [copied, setCopied] = useState<string | null>(null)
  // 中途加入观战：已获准的非名单观战者（来自 GET /status，刷新/换设备后仍成立）+ 观战开关快照
  const [extraSpectators, setExtraSpectators] = useState<string[]>([])
  const [spectateFlags, setSpectateFlags] = useState<{ roomAllowed: boolean; platformAllowed: boolean } | null>(null)
  // 本场实例名（auto 分配时 store 里只有发起开赛的那个会话有；直链/刷新靠 /status 补）
  const [matchInstance, setMatchInstance] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  // 直链/刷新进入时补拉房间（live 房只读查看）
  useEffect(() => {
    if (!id) return
    joinRoomChannel(id)
    void fetchRoom(id)
    return () => leaveRoomChannel(id)
  }, [id, fetchRoom])

  useEffect(() => {
    if (room && (room.status === 'waiting' || room.status === 'finished')) {
      navigate(`/room/${room.id}`, { replace: true })
    }
  }, [room, navigate])

  const loadStatus = useCallback(async () => {
    if (!id) return
    try {
      const st = await api.get<RoomStatusResponse>(`/api/rooms/${id}/status`)
      setExtraSpectators(st.match?.extraSpectators ?? [])
      setSpectateFlags(st.spectate ?? null)
      setMatchInstance(st.match?.instanceName ?? null)
    } catch {
      /* 房间不存在/网络抖动：保持页面既有渲染 */
    }
  }, [id])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // 服务器组名映射（serverChoice.group → groupName；实例 → 所在组）
  const [serverGroups, setServerGroups] = useState<ServerGroup[]>([])
  useEffect(() => {
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
  }, [])

  // 实例名：手动选实例 → 房间字段；auto → 本会话 store ?? /status 的 match.instanceName
  // （原先只认 store：非房主/开赛后刷新进来的人永远拿不到 → 徽章一直显示「服务器分配中…」）
  const usedInstance =
    room?.serverChoice?.mode === 'manual' ? room.serverChoice.instance : (allocatedInstance ?? matchInstance ?? undefined)
  const usedGroup = usedInstance
    ? serverGroups.find((g) => g.servers.some((s) => s.name === usedInstance))
    : undefined

  if (!room || !room.server) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <p className="text-muted-foreground">比赛不存在或尚未开始</p>
        <Button variant="secondary" onClick={() => navigate('/lobby')}>
          返回大厅
        </Button>
      </div>
    )
  }

  const mySlot = room.slots.find((s) => s.player.steamId === currentUser?.steamId)
  const myTeam = mySlot?.team === 'spec' ? null : mySlot?.team ?? null
  const isHost = room.hostId === currentUser?.steamId
  // 名单内(参赛/观战席) 或 已获准的非名单观战者:只有这两种人能看服务器地址/密码/连接按钮
  const spectatorApproved = !!currentUser && extraSpectators.includes(currentUser.steamId)
  const canSeeServer = !!mySlot || spectatorApproved
  // 申请按钮可用性:房间级(房主)与平台级(管理员)开关都开才可申请;/status 未回来时先按房间字段乐观判断
  const spectateEnabled = spectateFlags
    ? spectateFlags.roomAllowed && spectateFlags.platformAllowed
    : room.spectatorJoin !== false
  const spectateDisabledReason = spectateEnabled
    ? null
    : spectateFlags?.platformAllowed === false
      ? '平台已关闭中途加入观战'
      : '房主未开启「允许中途加入观战」'
  const server = room.server
  // 生效口径与房间页概览一致：刀战选边只在 BO1 + 非 BP 下真正生效；友军伤害缺省视为开启
  const knifeOn = room.knifeRound && room.bestOf === 1 && room.pickMode !== 'veto'
  const ffOn = room.friendlyFire !== false

  const copy = async (label: string, text: string) => {
    const ok = await copyText(text)
    if (ok) {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    }
  }

  const launchConnect = () => {
    window.location.href = `steam://connect/${server.ip}:${server.port}`
  }

  // 观战者(名单观战席 / 中途加入)不带 jointeam:MatchZy 会拦截观战者的换队请求,
  // 带上它既无效又与实际观感矛盾(提示语也不再提"自动加入阵营")
  const consoleCommand = myTeam
    ? `connect ${server.ip}:${server.port}; jointeam ${myTeam === 't' ? 't' : 'ct'}`
    : `connect ${server.ip}:${server.port}`

  const handleSpectate = async () => {
    if (!currentUser) return
    setApplying(true)
    try {
      const res = await spectate(room.id)
      // 申请成功(含重复申请幂等)后立即放行服务器信息,不等下一次 /status
      setExtraSpectators((prev) => (prev.includes(currentUser.steamId) ? prev : [...prev, currentUser.steamId]))
      if (res.seatsLeft != null) setSpectateFlags((f) => f ?? { roomAllowed: true, platformAllowed: true })
    } catch {
      /* 失败已 toast */
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="subtle" size="icon" className="-ml-2" aria-label="返回房间" onClick={() => navigate(`/room/${room.id}`)}>
            <ArrowLeft className="size-4" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="win-title">{room.name}</h1>
              <Badge variant="destructive">
                <span className="win-dot-live size-1.5 rounded-full bg-current" />
                比赛进行中
              </Badge>
            </div>
            <p className="win-caption mt-1 text-muted-foreground">
              服务器已就绪 · 房间码{' '}
              <span className="font-mono font-semibold tracking-widest text-[var(--accent-text)]">{room.code}</span> ·{' '}
              {MATCH_TYPE_LABELS[room.matchType]}
            </p>
          </div>
        </div>
        {isHost ? (
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await resetRoom(room.id)
                navigate(`/room/${room.id}`)
              } catch {
                /* 错误已 toast */
              }
            }}
          >
            结束比赛并返回房间
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => navigate(`/room/${room.id}`)}>
            返回房间
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <div className="flex flex-col gap-5 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="win-body-strong">对战服务器</h2>
                <Badge variant="outline">{server.region}</Badge>
                <Badge variant="info">
                  {usedInstance ? `${usedGroup?.groupName ?? usedInstance} / ${usedInstance}` : '服务器分配中…'}
                </Badge>
              </div>

              {canSeeServer ? (
                <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg bg-[var(--subtle-secondary)] p-3">
                  <p className="win-meta">服务器地址</p>
                  <p className="win-subtitle mt-1 font-mono">
                    {server.ip}:{server.port}
                  </p>
                </div>
                <div className="rounded-lg bg-[var(--subtle-secondary)] p-3">
                  <p className="win-meta">服务器密码</p>
                  {server.password ? (
                    <p className="win-subtitle mt-1 flex items-center gap-2 font-mono">
                      {server.password}
                      <button
                        type="button"
                        onClick={() => copy('pass', server.password)}
                        className="cursor-pointer rounded-[4px] p-1 text-muted-foreground transition-colors hover:bg-[var(--subtle-secondary)] hover:text-foreground"
                        aria-label="复制密码"
                      >
                        {copied === 'pass' ? <Check className="size-3.5 text-[var(--success)]" /> : <Copy className="size-3.5" />}
                      </button>
                    </p>
                  ) : (
                    // 无密码服务器:不留空白,也不给"复制空密码"的按钮
                    <p className="win-subtitle mt-1 text-muted-foreground">无密码</p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--subtle-secondary)] p-4">
                <p className="win-caption mb-2 font-semibold text-[var(--accent-text)]">一键进入</p>
                <Button size="lg" className="w-full" onClick={launchConnect}>
                  唤起 CS2 并连接服务器
                </Button>
                <p className="win-caption mt-2 text-center text-muted-foreground">
                  点击后浏览器将唤起 Steam / CS2，自动加入服务器并进入观察位
                </p>
                <p className="win-caption mt-1 text-center text-muted-foreground">如进入游戏后未进入地图，请再次点击</p>
              </div>

              <div>
                <p className="win-meta mb-1.5">备用：控制台命令</p>
                <div className="flex items-center gap-2 rounded-lg bg-[var(--subtle-secondary)] p-3">
                  <code className="win-caption flex-1 font-mono break-all">{consoleCommand}</code>
                  <button
                    type="button"
                    onClick={() => copy('cmd', consoleCommand)}
                    className="shrink-0 cursor-pointer rounded-[4px] p-1 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="复制命令"
                  >
                    {copied === 'cmd' ? <Check className="size-3.5 text-[var(--success)]" /> : <Copy className="size-3.5" />}
                  </button>
                </div>
                <p className="win-caption mt-1.5 leading-relaxed text-muted-foreground">
                  游戏内按 <code className="rounded-[4px] bg-[var(--control-fill)] px-1">~</code> 打开控制台粘贴执行，
                  {myTeam ? (
                    <>
                      进入服务器后自动加入{' '}
                      {myTeam === 't' ? <b className="text-[#f7a501]">T 阵营</b> : <b className="text-[#4cc2ff]">CT 阵营</b>}
                    </>
                  ) : (
                    <>进入服务器后落在观战席</>
                  )}
                </p>
              </div>
                </>
              ) : (
                <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg bg-[var(--subtle-secondary)] p-3">
                  <p className="win-meta">服务器地址</p>
                  <p className="win-subtitle mt-1 text-muted-foreground">请先申请加入观战</p>
                </div>
                <div className="rounded-lg bg-[var(--subtle-secondary)] p-3">
                  <p className="win-meta">服务器密码</p>
                  <p className="win-subtitle mt-1 text-muted-foreground">请先申请加入观战</p>
                </div>
              </div>

              <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--subtle-secondary)] p-4">
                <p className="win-caption mb-2 font-semibold text-[var(--accent-text)]">一键进入</p>
                <Button size="lg" className="w-full" disabled>
                  唤起 CS2 并连接服务器
                </Button>
                <p className="win-caption mt-2 text-center text-muted-foreground">
                  你不在本场名单内：需先在右侧「我的阵营」申请中途加入观战，通过后才会显示服务器地址与密码
                </p>
              </div>

              <div>
                <p className="win-meta mb-1.5">备用：控制台命令</p>
                <div className="flex items-center gap-2 rounded-lg bg-[var(--subtle-secondary)] p-3">
                  <code className="win-caption flex-1 font-mono text-muted-foreground">请先申请加入观战</code>
                </div>
              </div>
                </>
              )}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-2">
          {scores && (
            <Card>
              <div className="p-5">
                <p className="win-meta mb-3">实时比分</p>
                <div className="flex items-center justify-around rounded-lg bg-[var(--subtle-secondary)] p-4">
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="size-2 rounded-full bg-[#4cc2ff]" />
                    <span className="win-title font-mono">{scores.score1}</span>
                    <span className="win-caption text-muted-foreground">{room.teamAName}</span>
                  </div>
                  <span className="win-subtitle font-mono text-muted-foreground">:</span>
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="size-2 rounded-full bg-[#f7a501]" />
                    <span className="win-title font-mono">{scores.score2}</span>
                    <span className="win-caption text-muted-foreground">{room.teamBName}</span>
                  </div>
                </div>
              </div>
            </Card>
          )}
          <Card className="flex-1">
            <div className="flex h-full flex-col gap-2 p-5">
              <p className="win-meta mb-1">我的阵营</p>
              {myTeam ? (
                <div className="flex items-center gap-2.5 rounded-lg bg-[var(--subtle-secondary)] p-3">
                  <span className={`size-2.5 rounded-full ${myTeam === 'ct' ? 'bg-[#4cc2ff]' : 'bg-[#f7a501]'}`} />
                  <div>
                    <p className="win-body-strong">
                      {myTeam === 'ct' ? `${room.teamAName}（反恐精英）` : `${room.teamBName}（恐怖分子）`}
                    </p>
                    <p className="win-caption text-muted-foreground">
                      连接后将进入 {myTeam === 'ct' ? room.teamAName : room.teamBName} 阵营
                    </p>
                  </div>
                </div>
              ) : mySlot ? (
                <p className="win-caption rounded-lg bg-[var(--subtle-secondary)] p-3 text-muted-foreground">
                  你当前在旁观席，连接服务器后请手动加入阵营
                </p>
              ) : (
                <div className="flex flex-col gap-2 rounded-lg bg-[var(--subtle-secondary)] p-3">
                  <Button
                    size="sm"
                    variant={spectatorApproved ? 'secondary' : 'default'}
                    disabled={!spectateEnabled || applying || spectatorApproved}
                    onClick={handleSpectate}
                  >
                    {spectatorApproved ? '已加入观战' : applying ? '申请中…' : '申请中途加入观战'}
                  </Button>
                  <p className="win-caption leading-relaxed text-muted-foreground">
                    {spectateDisabledReason
                      ? `${spectateDisabledReason}，暂时无法申请`
                      : spectatorApproved
                        ? '申请已通过：可直接用左侧的服务器地址/一键进入连接，进服后落在观战席'
                        : '通过后可看到左侧的服务器地址与控制台命令，进服后自动落在观战席'}
                  </p>
                </div>
              )}
              <p className="win-caption text-muted-foreground">
                阵营归属由创建房间时的分配决定，也可在房间页手动调整
              </p>

              {/* 比赛设置状态：卡片靠 flex-1 拉到与左栏大卡等高，这两行落在卡片底部 */}
              <div className="mt-auto flex flex-col gap-2 border-t border-[var(--divider)] pt-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="win-body text-muted-foreground">拼刀选边</span>
                  <Badge variant={knifeOn ? 'success' : 'secondary'}>{knifeOn ? '开启' : '关闭'}</Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="win-body text-muted-foreground">友军伤害</span>
                  <Badge variant={ffOn ? 'success' : 'caution'}>{ffOn ? '开启' : '关闭'}</Badge>
                </div>
              </div>
            </div>
          </Card>

          <SpecPanel room={room} />
        </div>
      </div>

      {/* 对阵阵容：从右栏移到底部（右栏保留「我的阵营」），CT 在左 / T 在右，中间竖线 + VS */}
      <Card>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-4 p-5">
          <TeamPanel room={room} side="ct" />
          <div className="flex flex-col items-center gap-2">
            <span className="w-px flex-1 bg-[var(--divider)]" />
            <span className="win-meta">VS</span>
            <span className="w-px flex-1 bg-[var(--divider)]" />
          </div>
          <TeamPanel room={room} side="t" />
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 p-5">
          <p className="win-meta">比赛地图</p>
          {room.bestOf === 1 && finalMap ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <MapCard mapId={finalMap} state="picked" pickOrder={1} compact />
              </div>
              {room.picked.length > 1 && (
                <p className="win-caption text-muted-foreground">
                  本场地图从已选 {room.picked.length} 张（
                  {room.picked.map((id) => mapDefOf([...maps, ...communityMaps], id).displayName).join(' / ')}）中随机确定
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {room.picked.map((mapId, i) => (
                <MapCard key={mapId} mapId={mapId} state="picked" pickOrder={i + 1} compact />
              ))}
              {room.pickMode === 'veto' && room.banned.map((mapId) => (
                <MapCard key={mapId} mapId={mapId} state="banned" compact />
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
