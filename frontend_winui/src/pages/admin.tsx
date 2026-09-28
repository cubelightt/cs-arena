// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { Input, Textarea } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { NumberBox } from '@/components/winui/number-box'
import { Ring } from '@/components/winui/progress'
import { Checkbox, Switch } from '@/components/winui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/winui/tabs'
import { HostStatusSection } from '@/components/host/host-status-section'
import { InstancesSection } from '@/components/host/instances-section'
import { ProvisionBadge } from '@/components/host/instance-parts'
import { JobsSection } from '@/components/host/jobs-section'
import { api } from '@/lib/api'
import {
  MATCH_TYPE_LABELS,
  type GameServerGroup,
  type HomeContent,
  type MapMeta,
  type MatchType,
  type MaxPlayersSetting,
  type DemoArchiveSetting,
  type RoomModeAvailability,
  type Room,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useArena } from '@/stores/arena'

/**
 * 管理面板（WinUI 外观）：实例 / 房间 / 服务器组 / 地图池 / 首页内容 / 杂项 / 主机概况 / 更新任务
 * 八个分区，业务逻辑与旧工程 frontend_v2 一致，仅替换视觉层（主机概况、更新任务与建删实例为桥 v2 M3/M4/M5 新界面）。
 */

/* ---------------- 类型 ---------------- */

const ROOM_STATUS_META: Record<string, { label: string; variant: 'success' | 'info' | 'destructive' | 'secondary' }> = {
  waiting: { label: '等待中', variant: 'success' },
  vetoing: { label: '选图中', variant: 'info' },
  starting: { label: '开赛中', variant: 'info' },
  live: { label: '进行中', variant: 'destructive' },
  finished: { label: '已结束', variant: 'secondary' },
}

/* ---------------- 房间管理 ---------------- */

function RoomCard({ room, onDissolve }: { room: Room; onDissolve: (room: Room) => void }) {
  const status = ROOM_STATUS_META[room.status] ?? { label: room.status, variant: 'secondary' as const }
  const host = room.slots.find((s) => s.player.steamId === room.hostId)
  const filled = room.slots.filter((s) => s.team !== 'spec').length
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="win-body-strong truncate">{room.name}</span>
            <Badge variant="outline">{MATCH_TYPE_LABELS[room.matchType]}</Badge>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <p className="win-caption mt-1 truncate text-muted-foreground">
            <span className="font-mono">#{room.code}</span>
            {' · '}
            {filled}/{room.teamA + room.teamB} 人
            {' · '}房主 {host?.player.name ?? room.hostId}
            {' · '}
            <span className="font-mono">{room.id}</span>
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 text-[var(--critical)]"
          onClick={() => onDissolve(room)}
        >
          强制解散
        </Button>
      </div>
    </Card>
  )
}

function RoomsSection() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState<Room | null>(null)
  const [searchError, setSearchError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const toast = useArena((s) => s.toast)
  const applyRoomRemoved = useArena((s) => s.applyRoomRemoved)

  const fetchAll = useCallback(async () => {
    try {
      setRooms(await api.get<Room[]>('/api/rooms'))
    } catch (e) {
      toast('加载失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const handleSearch = async () => {
    const q = query.trim()
    if (!q) return
    setSearchError('')
    setSearched(null)
    try {
      const room = await api.get<Room>(`/api/rooms/${q}`)
      setSearched(room)
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e))
    }
  }

  const dissolve = async (room: Room) => {
    if (!window.confirm(`确定强制解散房间「${room.name}」（#${room.code}）？比赛进行中会先强制结束。`)) return
    setBusy(true)
    try {
      await api.del(`/api/rooms/${room.id}`)
      applyRoomRemoved(room.id)
      setRooms((rs) => rs.filter((r) => r.id !== room.id))
      setSearched(null)
      toast('房间已解散', room.name, 'success')
    } catch (e) {
      toast('解散失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <p className="win-body text-muted-foreground">强制解散指定房间（管理员旁路，可解散进行中的房间）</p>
        <div className="flex gap-2">
          <Input
            className="max-w-sm font-mono"
            placeholder="输入房间码或房间 ID 搜索（含进行中）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <Button variant="outline" onClick={handleSearch}>
            搜索
          </Button>
        </div>
        {searchError && <p className="win-caption text-[var(--critical)]">{searchError}</p>}
        {searched && <RoomCard room={searched} onDissolve={dissolve} />}
      </div>

      <div className="flex flex-col gap-2">
        <p className="win-meta">当前房间（等待/选图/开赛中）</p>
        {rooms.length === 0 && !loading ? (
          <div className="win-body rounded-lg border border-dashed border-[var(--card-stroke)] py-10 text-center text-muted-foreground">
            暂无房间
          </div>
        ) : (
          rooms.map((room) => <RoomCard key={room.id} room={room} onDissolve={dissolve} />)
        )}
      </div>
      {busy && <p className="win-caption text-muted-foreground">操作中…</p>}
    </div>
  )
}

/* ---------------- 服务器组管理 ---------------- */

interface GroupForm {
  id?: string
  name: string
  hostIp: string
  region: string
  bridgeToken: string
  instances: Array<{ name: string; port: string }>
}

const EMPTY_FORM: GroupForm = { name: '', hostIp: '', region: '', bridgeToken: '', instances: [] }

function generateBridgeToken() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function GroupDialog({ open, onOpenChange, group, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; group: GameServerGroup | null; onSaved: () => void }) {
  const toast = useArena((s) => s.toast)
  const [form, setForm] = useState<GroupForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isCreate = !group

  useEffect(() => {
    if (open) {
      setError('')
      if (group) {
        setForm({
          id: group.id,
          name: group.name,
          hostIp: group.hostIp,
          region: group.region,
          bridgeToken: group.bridgeToken,
          // 实例清单自 2026-09-23 起由「实例管理」维护:编辑组时不再回填/提交 instances
          instances: [],
        })
      } else {
        setForm(EMPTY_FORM)
      }
    }
  }, [open, group])

  const patch = (p: Partial<GroupForm>) => setForm((f) => ({ ...f, ...p }))

  const save = async () => {
    setError('')
    if (!form.name.trim() || !form.hostIp.trim()) {
      setError('组名 / 主机 IP 为必填项')
      return
    }
    if (!form.bridgeToken.trim()) {
      setError('桥 Token 必填，可点击「生成」')
      return
    }
    if (!form.region.trim()) {
      setError('区域为必填项（面板输入什么就显示什么，如「华南」）')
      return
    }
    // 实例清单交给「实例管理」：新建时传空数组（不铺实例），编辑时不带该字段（后端不动 instances 表）
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      hostIp: form.hostIp.trim(),
      region: form.region.trim(),
      bridgeToken: form.bridgeToken.trim(),
      bridgeMode: 'http',
    }
    if (!form.id) body.instances = []
    setSaving(true)
    try {
      if (form.id) {
        await api.put(`/api/game-servers/${form.id}`, body)
      } else {
        await api.post('/api/game-servers', body)
      }
      toast(form.id ? '服务器组已更新' : '服务器组已添加', '', 'success')
      onOpenChange(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{group ? `编辑服务器组 ${group.name}` : '新增服务器组（reverse）'}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? '创建后需在主机部署 reverse 桥：server_id 使用本组 ID、bridge_token 保持一致，桥连接后卡片显示连接状态；实例在「实例管理」Tab 创建/删除'
              : '修改 bridge_token 后，需同步更新主机 config.json 并重启桥，否则连接 / 健康状态不一致；实例的增删改走「实例管理」Tab'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>组名 *</Label>
              <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="服务器组-2" />
            </div>
            <div className="grid gap-1.5">
              <Label>区域 *</Label>
              {/* 自由文本:面板输入什么、界面就显示什么(2026-09-23;此前是 cn-* 编码→中文的映射) */}
              <Input value={form.region} onChange={(e) => patch({ region: e.target.value })} placeholder="华南" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>主机 IP（gameHost）*</Label>
            <Input value={form.hostIp} onChange={(e) => patch({ hostIp: e.target.value })} placeholder="192.0.2.211" className="font-mono" />
          </div>
          <div className="grid gap-1.5">
            <Label>桥 Token（BRIDGE_TOKEN）*</Label>
            <div className="flex gap-2">
              <Input value={form.bridgeToken} onChange={(e) => patch({ bridgeToken: e.target.value })} placeholder="点击「生成」或手动输入" className="font-mono" />
              <Button variant="outline" className="shrink-0" onClick={() => patch({ bridgeToken: generateBridgeToken() })}>
                生成
              </Button>
            </div>
          </div>
          {error && <p className="win-caption text-[var(--critical)]">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Ring size={16} />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GameServersSection() {
  const [groups, setGroups] = useState<GameServerGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<GameServerGroup | null>(null)
  const [revealedTokens, setRevealedTokens] = useState<Set<string>>(new Set())
  const toast = useArena((s) => s.toast)

  const fetchAll = useCallback(async () => {
    try {
      setGroups(await api.get<GameServerGroup[]>('/api/game-servers'))
    } catch (e) {
      toast('加载失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const toggleActive = async (g: GameServerGroup) => {
    setBusy(true)
    try {
      const action = g.isActive ? 'deactivate' : 'activate'
      await api.post(`/api/game-servers/${g.id}/${action}`)
      await fetchAll()
    } catch (e) {
      toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const revealToken = (id: string) =>
    setRevealedTokens((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="win-body text-muted-foreground">管理桥接服务器组（gameServers），共 {groups.length} 组</p>
        <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true) }}>
          新增服务器组
        </Button>
      </div>

      {groups.length === 0 && !loading && (
        <div className="win-body rounded-lg border border-dashed border-[var(--card-stroke)] py-10 text-center text-muted-foreground">
          暂无服务器组
        </div>
      )}

      {groups.map((g) => {
        const revealed = revealedTokens.has(g.id)
        return (
          <Card key={g.id}>
            <div className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="win-body-strong">{g.name}</span>
                  <Badge variant={g.isActive ? 'success' : 'secondary'}>{g.isActive ? '已激活' : '已停用'}</Badge>
                  {g.connected ? (
                    <Badge variant="success">已连接</Badge>
                  ) : (
                    <Badge variant="destructive">未连接</Badge>
                  )}
                  <Badge variant="outline" className="font-mono">{g.hostIp}</Badge>
                  <Badge variant="secondary">{g.region}</Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setEditing(g); setDialogOpen(true) }}>
                    编辑
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toggleActive(g)} disabled={busy}>
                    {g.isActive ? '停用' : '激活'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[var(--critical)]"
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm(`确定删除服务器组「${g.name}」？该组的桥连接将一并断开。`)) return
                      setBusy(true)
                      try {
                        await api.del(`/api/game-servers/${g.id}`)
                        toast('服务器组已删除', g.name, 'success')
                        await fetchAll()
                      } catch (e) {
                        toast('删除失败', e instanceof Error ? e.message : String(e), 'error')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
              <div className="win-caption flex flex-col gap-1.5 text-muted-foreground">
                {!g.connected && (
                  <p className="rounded-[4px] bg-[var(--subtle-secondary)] px-2 py-1 text-[11px]">
                    桥未连接：需在主机部署 reverse 桥（server_id 使用本组 ID「{g.id}」、bridge_token 保持一致）
                  </p>
                )}
                <p className="flex flex-wrap items-center gap-2">
                  桥 Token：
                  <span className="font-mono text-foreground">{revealed ? g.bridgeToken : '********'}</span>
                  <Button variant="link" size="sm" onClick={() => revealToken(g.id)}>
                    {revealed ? '隐藏' : '显示'}
                  </Button>
                </p>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  实例（按编号）：
                  {g.instances.length === 0 && <span className="text-muted-foreground">（无）</span>}
                  {g.instances.map((i) => (
                    <span key={i.name} className="flex items-center gap-1.5">
                      <span className="font-mono text-muted-foreground">{i.idx != null ? `#${i.idx}` : '#—'}</span>
                      <span className="font-mono text-foreground">
                        {i.name}:{i.port || '—'}
                      </span>
                      <ProvisionBadge state={i.provisionState} />
                    </span>
                  ))}
                </p>
              </div>
            </div>
          </Card>
        )
      })}

      <GroupDialog open={dialogOpen} onOpenChange={setDialogOpen} group={editing} onSaved={fetchAll} />
    </div>
  )
}

/* ---------------- 地图池调整 ---------------- */

/** 社区图缩略图上传约束（与后端一致：PNG/JPEG/WebP、≤5MB，后端按魔数嗅探兜底） */
const THUMB_ACCEPT = 'image/png,image/jpeg,image/webp'
const THUMB_MAX_BYTES = 5 * 1024 * 1024

function validateThumbFile(file: File): string | null {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    return '仅支持 PNG / JPEG / WebP 图片'
  }
  if (file.size > THUMB_MAX_BYTES) {
    return '缩略图需 ≤5MB'
  }
  return null
}

function MapPoolSection() {
  const toast = useArena((s) => s.toast)
  const [maps, setMaps] = useState<MapMeta[]>([])
  const [communityMaps, setCommunityMaps] = useState<MapMeta[]>([])
  const [mapIds, setMapIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFullName, setNewFullName] = useState('')
  const [communityOpen, setCommunityOpen] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [newCName, setNewCName] = useState('')
  const [newCInternal, setNewCInternal] = useState('')
  const [newCWid, setNewCWid] = useState('')
  const [newCMatchTypes, setNewCMatchTypes] = useState<MatchType[]>([])
  // 新增弹窗的缩略图（本地暂存，录入成功后自动上传；失败不阻断录入）
  const [newCThumb, setNewCThumb] = useState<File | null>(null)
  const [newCThumbUrl, setNewCThumbUrl] = useState<string | null>(null)
  const newThumbInputRef = useRef<HTMLInputElement>(null)
  // 后端缩略图的缓存戳：上传/删除后刷新列表时更新，避免 5 分钟 max-age 内拿到旧图
  const [thumbTs, setThumbTs] = useState(0)
  // 编辑弹窗的缩略图上传/删除（立即生效）
  const [uploadingThumb, setUploadingThumb] = useState(false)
  const editThumbInputRef = useRef<HTMLInputElement>(null)

  const fetchAll = useCallback(async (): Promise<{ community: MapMeta[] } | null> => {
    try {
      const [poolRes, mapsRes, communityRes] = await Promise.all([
        api.get<{ mapIds: string[] }>('/api/settings/map-pool'),
        api.get<{ maps: MapMeta[] }>('/api/settings/maps'),
        api.get<{ maps: MapMeta[] }>('/api/settings/community-maps'),
      ])
      setMapIds(poolRes.mapIds)
      setMaps(mapsRes.maps)
      setCommunityMaps(communityRes.maps)
      // 同步全局 store（房间页地图卡用 thumbnailUrl 渲染社区图，需与本面板一致）
      useArena.getState().fetchCommunityMaps()
      return { community: communityRes.maps }
    } catch (e) {
      toast('加载失败', e instanceof Error ? e.message : String(e), 'error')
      return null
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const toggle = (id: string) =>
    setMapIds((prev) => {
      if (prev.includes(id)) return prev.filter((m) => m !== id)
      if (prev.length >= 7) {
        toast('服役地图池需恰好 7 张', '请先取消勾选一张再添加', 'error')
        return prev
      }
      return [...prev, id]
    })

  const save = async () => {
    if (mapIds.length !== 7) {
      toast('服役地图池需恰好 7 张', `当前 ${mapIds.length} 张`, 'error')
      return
    }
    setSaving(true)
    try {
      await api.put('/api/settings/map-pool', { mapIds })
      toast('服役地图池已更新', 'BP 模式房间将使用该池（直接选图用总竞技池）', 'success')
    } catch (e) {
      toast('保存失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const addMap = async () => {
    const fullName = newFullName.trim()
    const displayName = newName.trim()
    if (!displayName) {
      toast('请输入地图名称', '', 'error')
      return
    }
    if (displayName.length > 32 || fullName.length > 32) {
      toast('名称与地图 id 均需 ≤32 字符', '', 'error')
      return
    }
    if (!/^(de|cs)_[a-z0-9_]+$/.test(fullName)) {
      toast('地图 id 需为官方名', '如 de_mirage / cs_office', 'error')
      return
    }
    setAdding(true)
    try {
      await api.post('/api/settings/maps', { fullName, displayName })
      toast('地图已录入', `${fullName}（${displayName}）已加入总竞技图池`, 'success')
      setAddOpen(false)
      setNewName('')
      setNewFullName('')
      fetchAll()
    } catch (e) {
      toast('录入失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setAdding(false)
    }
  }

  const removeMap = async (fullName: string) => {
    if (!window.confirm(`确定从总竞技图池移除「${fullName}」？服役地图池在用该图时将被拒绝。`)) return
    try {
      await api.del(`/api/settings/maps/${encodeURIComponent(fullName)}`)
      toast('地图已移除', `${fullName} 已从总竞技图池删除`, 'success')
      fetchAll()
    } catch (e) {
      toast('移除失败', e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const toggleMatchType = (t: MatchType) =>
    setNewCMatchTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))

  // 新增弹窗：选择/清除暂存缩略图（objectURL 预览，关闭时回收）
  const pickNewCThumb = (f: File | null) => {
    if (f) {
      const err = validateThumbFile(f)
      if (err) {
        toast('缩略图不符合要求', err, 'error')
        return
      }
    }
    if (newCThumbUrl) URL.revokeObjectURL(newCThumbUrl)
    setNewCThumb(f)
    setNewCThumbUrl(f ? URL.createObjectURL(f) : null)
  }

  const clearNewCThumb = () => pickNewCThumb(null)

  const addCommunityMap = async () => {
    const displayName = newCName.trim()
    const internalName = newCInternal.trim()
    const workshopId = newCWid.trim()
    if (!displayName) {
      toast('请输入地图名', '', 'error')
      return
    }
    if (displayName.length > 32 || internalName.length > 32) {
      toast('地图名与内部地图名均需 ≤32 字符', '', 'error')
      return
    }
    if (!internalName) {
      toast('请输入内部地图名', '如 de_breach（服务器换图必需）', 'error')
      return
    }
    if (!/^\d{6,20}$/.test(workshopId)) {
      toast('创意工坊 id 需为数字', '6~20 位（链接 https://steamcommunity.com/sharedfiles/filedetails/?id=XXXX 仅取数字）', 'error')
      return
    }
    if (newCMatchTypes.length === 0) {
      toast('请选择适用模式', '至少选择一种房间类型', 'error')
      return
    }
    setCommitting(true)
    try {
      await api.post('/api/settings/community-maps', { displayName, workshopId, internalName, matchTypes: newCMatchTypes })
      // 缩略图按 workshopId 上传，只能等地图录入成功后再传；失败不回滚录入，提示稍后补传
      let thumbNote = ''
      if (newCThumb) {
        try {
          await api.upload(`/api/settings/community-maps/${encodeURIComponent(workshopId)}/thumbnail`, newCThumb)
        } catch {
          thumbNote = '；缩略图上传失败，可稍后在「编辑」中补传'
        }
      }
      toast('社区地图已录入', `${displayName}（${workshopId}）已加入社区地图池${thumbNote}`, 'success')
      setCommunityOpen(false)
      setNewCName('')
      setNewCInternal('')
      setNewCWid('')
      setNewCMatchTypes([])
      clearNewCThumb()
      setThumbTs(Date.now())
      fetchAll()
    } catch (e) {
      toast('录入失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setCommitting(false)
    }
  }

  const removeCommunityMap = async (workshopId: string) => {
    if (!window.confirm(`确定从社区地图池移除「${workshopId}」？使用中的房间开赛前需移除该图。`)) return
    try {
      await api.del(`/api/settings/community-maps/${encodeURIComponent(workshopId)}`)
      toast('社区地图已移除', `${workshopId} 已从社区地图池删除`, 'success')
      fetchAll()
    } catch (e) {
      toast('移除失败', e instanceof Error ? e.message : String(e), 'error')
    }
  }

  // ---- 编辑地图(官方/社区共用弹窗) ----
  const [editing, setEditing] = useState<MapMeta | null>(null)
  const [editName, setEditName] = useState('')
  const [editInternal, setEditInternal] = useState('')
  const [editMatchTypes, setEditMatchTypes] = useState<MatchType[]>([])
  const [savingEdit, setSavingEdit] = useState(false)

  const openEdit = (m: MapMeta) => {
    setEditing(m)
    setEditName(m.displayName)
    setEditInternal(m.internalName ?? '')
    setEditMatchTypes(m.matchTypes ?? [])
  }

  const toggleEditMatchType = (t: MatchType) =>
    setEditMatchTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))

  const saveEdit = async () => {
    if (!editing) return
    const displayName = editName.trim()
    if (!displayName) {
      toast('请输入地图名称', '', 'error')
      return
    }
    if (displayName.length > 32) {
      toast('地图名需 ≤32 字符', '', 'error')
      return
    }
    const body: { displayName: string; internalName?: string; matchTypes?: MatchType[] } = { displayName }
    if (editing.kind === 'workshop') {
      const internalName = editInternal.trim()
      if (!internalName) {
        toast('请输入内部地图名', '如 de_breach（服务器换图必需）', 'error')
        return
      }
      if (internalName.length > 32) {
        toast('内部地图名需 ≤32 字符', '', 'error')
        return
      }
      if (!/^[a-z0-9_]{3,32}$/.test(internalName)) {
        toast('内部地图名格式不正确', '3~32 位小写字母/数字/下划线,如 de_breach / aim_gryn', 'error')
        return
      }
      if (editMatchTypes.length === 0) {
        toast('请选择适用模式', '至少选择一种房间类型', 'error')
        return
      }
      body.internalName = internalName
      body.matchTypes = editMatchTypes
    }
    setSavingEdit(true)
    try {
      if (editing.kind === 'workshop') {
        await api.put(`/api/settings/community-maps/${encodeURIComponent(editing.workshopId ?? editing.id)}`, body)
        toast('社区地图已更新', `${displayName}（${editing.workshopId}）已保存`, 'success')
      } else {
        await api.put(`/api/settings/maps/${encodeURIComponent(editing.fullName)}`, body)
        toast('地图已更新', `${editing.fullName}（${displayName}）已保存`, 'success')
      }
      setEditing(null)
      fetchAll()
    } catch (e) {
      toast('保存失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSavingEdit(false)
    }
  }

  const deleteEditing = async () => {
    if (!editing) return
    if (editing.kind === 'workshop') {
      await removeCommunityMap(editing.workshopId ?? editing.id)
    } else {
      await removeMap(editing.fullName)
    }
    setEditing(null)
  }

  // 编辑弹窗：上传/更换、删除社区图缩略图（立即生效；成功后从最新列表回填 editing，预览随之更新）
  const uploadEditingThumb = async (file: File) => {
    if (!editing || editing.kind !== 'workshop') return
    const invalid = validateThumbFile(file)
    if (invalid) {
      toast('缩略图不符合要求', invalid, 'error')
      return
    }
    const wid = editing.workshopId ?? editing.id
    setUploadingThumb(true)
    try {
      await api.upload(`/api/settings/community-maps/${encodeURIComponent(wid)}/thumbnail`, file)
      toast('缩略图已上传', `${editing.displayName} 的缩略图已更新`, 'success')
      const res = await fetchAll()
      const updated = res?.community.find((m) => (m.workshopId ?? m.id) === wid)
      if (updated) setEditing(updated)
      setThumbTs(Date.now())
    } catch (e) {
      toast('上传失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setUploadingThumb(false)
    }
  }

  const deleteEditingThumb = async () => {
    if (!editing || editing.kind !== 'workshop') return
    const wid = editing.workshopId ?? editing.id
    setUploadingThumb(true)
    try {
      await api.del(`/api/settings/community-maps/${encodeURIComponent(wid)}/thumbnail`)
      toast('缩略图已删除', `${editing.displayName} 的缩略图已移除`, 'success')
      const res = await fetchAll()
      const updated = res?.community.find((m) => (m.workshopId ?? m.id) === wid)
      if (updated) setEditing(updated)
      setThumbTs(Date.now())
    } catch (e) {
      toast('删除失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setUploadingThumb(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="win-body-strong">总竞技图池</p>
              <p className="win-caption mt-0.5 text-muted-foreground">
                全部可选地图（官方名 + 中文显示名），直接选图模式从该池选择；可录入新官方地图
              </p>
            </div>
            <Button size="sm" onClick={() => setAddOpen(true)} disabled={loading}>
              新增地图
            </Button>
          </div>
          {loading ? (
            <Ring size={16} />
          ) : (
            <div className="flex flex-wrap gap-2">
              {maps.map((m) => (
                <span
                  key={m.fullName}
                  className="win-body inline-flex items-center gap-2 rounded-[4px] border border-[var(--card-stroke)] bg-[var(--subtle-secondary)] px-3 py-1.5"
                >
                  <span className="font-medium">{m.displayName}</span>
                  <span className="font-mono text-[10px] lowercase text-muted-foreground">{m.fullName}</span>
                  <button
                    type="button"
                    onClick={() => openEdit(m)}
                    className="win-caption cursor-pointer text-muted-foreground transition-colors hover:text-[var(--accent-text)]"
                    title={`编辑 ${m.fullName}`}
                  >
                    编辑
                  </button>
                </span>
              ))}
              {maps.length === 0 && <p className="win-caption text-muted-foreground">总竞技图池为空</p>}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="win-body-strong">服役地图池（恒 7 张，BP 专用）</p>
              <p className="win-caption mt-0.5 text-muted-foreground">从总竞技图池中选取，用于 BP选图；切换选图模式后房间自动换池</p>
            </div>
            <Button size="sm" onClick={save} disabled={saving || loading || mapIds.length !== 7}>
              {saving && <Ring size={16} />}
              保存服役池
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {maps.map((m) => {
              const active = mapIds.includes(m.fullName)
              return (
                <button
                  key={m.fullName}
                  type="button"
                  onClick={() => toggle(m.fullName)}
                  className={cn(
                    'win-body-strong cursor-pointer rounded-[4px] border px-4 py-2 transition-colors',
                    active
                      ? 'border-[var(--accent)]/60 bg-[var(--subtle-secondary)] text-[var(--accent-text)]'
                      : 'border-[var(--card-stroke)] bg-transparent text-muted-foreground hover:border-[var(--control-strong-stroke)] hover:text-foreground',
                  )}
                >
                  {m.displayName}
                </button>
              )
            })}
            {maps.length === 0 && <p className="win-caption text-muted-foreground">总竞技图池为空，请先录入地图</p>}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className={cn(mapIds.length !== 7 && 'bg-[var(--critical-bg)] text-[var(--critical)]')}>
              服役 {mapIds.length}/7 张
            </Badge>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="win-body-strong">社区地图池</p>
              <p className="win-caption mt-0.5 text-muted-foreground">
                创意工坊地图，独立于总竞技图池；自定义竞技房间在「选图方式」选择「社区地图」后可选（按适用模式过滤）
              </p>
            </div>
            <Button size="sm" onClick={() => setCommunityOpen(true)} disabled={loading}>
              新增社区地图
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {communityMaps.map((m) => (
              <span
                key={m.workshopId ?? m.id}
                className="win-body inline-flex flex-wrap items-center gap-2 rounded-[4px] border border-[var(--card-stroke)] bg-[var(--subtle-secondary)] px-3 py-1.5"
              >
                {m.hasThumbnail && m.thumbnailUrl ? (
                  <img
                    src={`${m.thumbnailUrl}?v=${thumbTs}`}
                    alt=""
                    className="h-9 w-16 rounded-[4px] border border-[var(--card-stroke)] object-cover"
                  />
                ) : (
                  <span className="grid h-9 w-16 place-items-center rounded-[4px] border border-dashed border-[var(--control-strong-stroke)] text-[9px] text-muted-foreground">
                    无缩略图
                  </span>
                )}
                <span className="font-medium">{m.displayName}</span>
                <span className="font-mono text-[10px] lowercase text-muted-foreground">{m.internalName ?? m.id}</span>
                <Badge variant="outline" className="font-mono text-[9px]">
                  WS {m.workshopId ?? ''}
                </Badge>
                {(m.matchTypes ?? []).map((t) => (
                  <Badge key={t} variant="secondary" className="text-[9px]">
                    {MATCH_TYPE_LABELS[t]}
                  </Badge>
                ))}
                <button
                  type="button"
                  onClick={() => openEdit(m)}
                  className="win-caption cursor-pointer text-muted-foreground transition-colors hover:text-[var(--accent-text)]"
                  title={`编辑 ${m.workshopId ?? m.id}`}
                >
                  编辑
                </button>
              </span>
            ))}
            {communityMaps.length === 0 && <p className="win-caption text-muted-foreground">社区地图池为空，可录入创意工坊地图</p>}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            开赛前主机需已订阅下载该图；服务器启动后可执行 <code className="rounded-[4px] bg-[var(--subtle-secondary)] px-1 font-mono">host_workshop_map &lt;创意工坊id&gt;</code>{' '}
            预加载（或启动项加 <code className="rounded-[4px] bg-[var(--subtle-secondary)] px-1 font-mono">+host_workshop_map &lt;id&gt;</code>，并保留一个官方图启动项如{' '}
            <code className="rounded-[4px] bg-[var(--subtle-secondary)] px-1 font-mono">+map de_mirage</code>）
          </p>
        </div>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>新增地图</DialogTitle>
            <DialogDescription>录入官方地图至总竞技图池（地图 id 用官方名，如 de_mirage / cs_office）</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>名称（中文显示名）</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="办公室" maxLength={32} />
            </div>
            <div className="grid gap-1.5">
              <Label>地图 id（官方名）</Label>
              <Input value={newFullName} onChange={(e) => setNewFullName(e.target.value)} placeholder="cs_office" maxLength={32} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button onClick={addMap} disabled={adding}>
              {adding && <Ring size={16} />}
              确认录入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={communityOpen}
        onOpenChange={(v) => {
          setCommunityOpen(v)
          // 半途关闭丢弃暂存缩略图并回收预览 URL
          if (!v) clearNewCThumb()
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>新增社区地图</DialogTitle>
            <DialogDescription>录入创意工坊地图至社区地图池（独立于总竞技图池，按适用模式过滤进房间）</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>地图名（中文显示名）</Label>
              <Input value={newCName} onChange={(e) => setNewCName(e.target.value)} placeholder="猩红监狱" maxLength={32} />
            </div>
            <div className="grid gap-1.5">
              <Label>内部地图名（服务器换图必需）</Label>
              <Input
                value={newCInternal}
                onChange={(e) => setNewCInternal(e.target.value)}
                placeholder="de_breach"
                maxLength={32}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>创意工坊 id（6~20 位数字）</Label>
              <Input
                value={newCWid}
                onChange={(e) => setNewCWid(e.target.value.replace(/\D/g, ''))}
                placeholder="3781536158"
                maxLength={20}
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                仅输入数字部分，如 https://steamcommunity.com/sharedfiles/filedetails/?id=3781536158 →{' '}
                <code className="font-mono">3781536158</code>
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label>适用模式</Label>
              <div className="flex gap-4">
                {(Object.keys(MATCH_TYPE_LABELS) as MatchType[]).map((t) => (
                  <label key={t} className="win-body flex cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={newCMatchTypes.includes(t)}
                      onChange={() => toggleMatchType(t)}
                    />
                    {MATCH_TYPE_LABELS[t]}
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                该地图仅在所选房间类型的「社区地图」选图方式中出现（至少选一种）
              </p>
            </div>
            {/* 缩略图（可选）：先本地暂存，录入成功后按 workshopId 自动上传 */}
            <div className="grid gap-1.5">
              <Label>缩略图（可选）</Label>
              <div className="flex items-center gap-3">
                {newCThumbUrl ? (
                  <img
                    src={newCThumbUrl}
                    alt="缩略图预览"
                    className="h-[54px] w-24 shrink-0 rounded-[4px] border border-[var(--card-stroke)] object-cover"
                  />
                ) : (
                  <div className="grid h-[54px] w-24 shrink-0 place-items-center rounded-[4px] border border-dashed border-[var(--control-strong-stroke)] text-[10px] text-muted-foreground">
                    未选择
                  </div>
                )}
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => newThumbInputRef.current?.click()}>
                      选择图片
                    </Button>
                    {newCThumb && (
                      <Button type="button" variant="ghost" size="sm" onClick={clearNewCThumb}>
                        移除
                      </Button>
                    )}
                  </div>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {newCThumb ? newCThumb.name : 'PNG / JPEG / WebP，≤5MB；录入成功后自动上传'}
                  </p>
                </div>
              </div>
              <input
                ref={newThumbInputRef}
                type="file"
                accept={THUMB_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  pickNewCThumb(e.target.files?.[0] ?? null)
                  e.target.value = ''
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommunityOpen(false)}>
              取消
            </Button>
            <Button onClick={addCommunityMap} disabled={committing}>
              {committing && <Ring size={16} />}
              确认录入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editing?.kind === 'workshop' ? '编辑社区地图' : '编辑地图'}</DialogTitle>
            <DialogDescription>
              {editing?.kind === 'workshop'
                ? '修改地图名 / 内部地图名 / 适用模式（创意工坊 id 不可修改）'
                : '修改中文显示名（地图 id 为身份键，不可修改）'}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>地图名（中文显示名）</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={32} />
              </div>
              {editing.kind === 'workshop' ? (
                <>
                  {/* 缩略图：后端存储（管理员上传、公开读取），预览/更换/删除即时生效 */}
                  <div className="grid gap-1.5">
                    <Label>缩略图</Label>
                    <div className="flex items-center gap-3">
                      {editing.hasThumbnail && editing.thumbnailUrl ? (
                        <img
                          src={`${editing.thumbnailUrl}?v=${thumbTs}`}
                          alt="缩略图预览"
                          className="h-[54px] w-24 shrink-0 rounded-[4px] border border-[var(--card-stroke)] object-cover"
                        />
                      ) : (
                        <div className="grid h-[54px] w-24 shrink-0 place-items-center rounded-[4px] border border-dashed border-[var(--control-strong-stroke)] text-[10px] text-muted-foreground">
                          未上传
                        </div>
                      )}
                      <div className="flex flex-col gap-1.5">
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={uploadingThumb}
                            onClick={() => editThumbInputRef.current?.click()}
                          >
                            {uploadingThumb && <Ring size={14} />}
                            {editing.hasThumbnail ? '更换缩略图' : '上传缩略图'}
                          </Button>
                          {editing.hasThumbnail && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-[var(--critical)]"
                              disabled={uploadingThumb}
                              onClick={deleteEditingThumb}
                            >
                              删除
                            </Button>
                          )}
                        </div>
                        <p className="text-[10px] leading-relaxed text-muted-foreground">
                          PNG / JPEG / WebP，≤5MB；转存为 WebP 后作为该图的展示截图
                        </p>
                      </div>
                    </div>
                    <input
                      ref={editThumbInputRef}
                      type="file"
                      accept={THUMB_ACCEPT}
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) uploadEditingThumb(f)
                        e.target.value = ''
                      }}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>内部地图名（服务器换图必需）</Label>
                    <Input
                      value={editInternal}
                      onChange={(e) => setEditInternal(e.target.value)}
                      placeholder="de_breach"
                      maxLength={32}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>创意工坊 id（不可修改）</Label>
                    <Input value={editing.workshopId ?? ''} disabled className="font-mono" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>适用模式</Label>
                    <div className="flex gap-4">
                      {(Object.keys(MATCH_TYPE_LABELS) as MatchType[]).map((t) => (
                        <label key={t} className="win-body flex cursor-pointer items-center gap-2">
                          <Checkbox
                            checked={editMatchTypes.includes(t)}
                            onChange={() => toggleEditMatchType(t)}
                          />
                          {MATCH_TYPE_LABELS[t]}
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="grid gap-1.5">
                  <Label>地图 id（不可修改）</Label>
                  <Input value={editing.fullName} disabled className="font-mono" />
                </div>
              )}
            </div>
          )}
          <div className="flex items-center justify-between pt-1">
            <Button variant="outline" size="sm" className="text-[var(--critical)]" onClick={deleteEditing} disabled={savingEdit}>
              删除地图
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button onClick={saveEdit} disabled={savingEdit}>
                {savingEdit && <Ring size={16} />}
                保存修改
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ---------------- 杂项设置 ---------------- */

interface DisconnectGrace {
  enabled: boolean
  seconds: number
}

/** 首页内容编辑器：一个卡片 = 一段 markdown（左卡 / 更新日志共用） */
function HomeContentEditor({
  id,
  title,
  description,
  hint,
  value,
  savedValue,
  saving,
  onChange,
  onSave,
}: {
  id: string
  title: string
  description: string
  hint?: string
  value: string
  savedValue: string
  saving: boolean
  onChange: (v: string) => void
  onSave: () => void
}) {
  const dirty = value !== savedValue
  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <p className="win-body-strong">{title}</p>
        <p className="win-caption mt-0.5 leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {hint && <p className="win-caption leading-relaxed text-[var(--caution)]">{hint}</p>}
      <Textarea
        id={id}
        className="min-h-64 font-mono text-[13px] leading-relaxed"
        value={value}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        placeholder="支持标准 Markdown：标题 / 列表 / 链接 / 图片 / 表格 / 围栏代码块 / 引用 / 加粗斜体 / 删除线…（单个换行即断行）"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="win-caption text-muted-foreground">
          {value.length} 字符{dirty && ' · 有未保存修改'}
        </p>
        <Button size="sm" disabled={saving || !dirty} onClick={onSave}>
          {saving && <Ring size={14} />}
          保存
        </Button>
      </div>
    </div>
  )
}

function HomeContentSection() {
  const toast = useArena((s) => s.toast)
  const [content, setContent] = useState<HomeContent | null>(null)
  const [leftCard, setLeftCard] = useState('')
  const [changelog, setChangelog] = useState('')
  const [saving, setSaving] = useState<'leftCard' | 'changelog' | null>(null)

  useEffect(() => {
    api
      .get<HomeContent>('/api/settings/home-content')
      .then((c) => {
        setContent(c)
        setLeftCard(c.leftCard)
        setChangelog(c.changelog)
      })
      .catch((e) => toast('加载失败', e instanceof Error ? e.message : String(e), 'error'))
  }, [toast])

  const save = async (field: 'leftCard' | 'changelog') => {
    setSaving(field)
    try {
      const next = await api.put<HomeContent>('/api/settings/home-content', {
        [field]: field === 'leftCard' ? leftCard : changelog,
      })
      setContent(next)
      setLeftCard(next.leftCard)
      setChangelog(next.changelog)
      toast('首页内容已保存', field === 'leftCard' ? '左侧卡片内容已更新' : '更新日志已更新', 'success')
    } catch (e) {
      toast('保存失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {content ? (
        <>
          <Card>
            <HomeContentEditor
              id="home-left-card"
              title="左侧卡片（占 2/3 宽）"
              description="首页左侧大卡片的内容，显示在「已有房间码」入口下方；留空则首页该处为空白卡片。保存后玩家刷新首页即见。"
              value={leftCard}
              savedValue={content.leftCard}
              saving={saving === 'leftCard'}
              onChange={setLeftCard}
              onSave={() => save('leftCard')}
            />
          </Card>
          <Card>
            <HomeContentEditor
              id="home-changelog"
              title="更新日志（右侧卡片，占 1/3 宽）"
              description="首页右侧「更新日志」卡片的内容，内容超出时卡片内部滚动。保存后玩家刷新首页即见。"
              hint={
                content.source === 'file'
                  ? '当前显示的是仓库文件 update/CHANGELOG.md 的内容（尚未在后台保存过）。点击保存后将以后台内容为准，之后该文件的改动不再影响首页。'
                  : undefined
              }
              value={changelog}
              savedValue={content.changelog}
              saving={saving === 'changelog'}
              onChange={setChangelog}
              onSave={() => save('changelog')}
            />
          </Card>
        </>
      ) : (
        <Card>
          <div className="win-body flex items-center gap-2 p-4 text-muted-foreground">
            <Ring size={16} />
            加载中…
          </div>
        </Card>
      )}
    </div>
  )
}

function MiscSettingsSection() {  const toast = useArena((s) => s.toast)
  const [grace, setGrace] = useState<DisconnectGrace | null>(null)
  const [maxPlayers, setMaxPlayers] = useState<MaxPlayersSetting | null>(null)
  const [demoArchive, setDemoArchive] = useState<DemoArchiveSetting | null>(null)
  const [roomModes, setRoomModes] = useState<RoomModeAvailability | null>(null)
  const [archiveRunning, setArchiveRunning] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api
      .get<DisconnectGrace>('/api/settings/disconnect')
      .then(setGrace)
      .catch((e) => toast('加载失败', e instanceof Error ? e.message : String(e), 'error'))
    api
      .get<MaxPlayersSetting>('/api/settings/max-players')
      .then(setMaxPlayers)
      .catch((e) => toast('加载失败', e instanceof Error ? e.message : String(e), 'error'))
    api
      .get<DemoArchiveSetting>('/api/settings/demo-archive')
      .then(setDemoArchive)
      .catch((e) => toast('加载失败', e instanceof Error ? e.message : String(e), 'error'))
    api
      .get<RoomModeAvailability>('/api/settings/room-modes')
      .then(setRoomModes)
      .catch((e) => toast('加载失败', e instanceof Error ? e.message : String(e), 'error'))
  }, [toast])

  const saveRoomModes = async (patch: Partial<RoomModeAvailability>) => {
    if (!roomModes) return
    setSaving(true)
    try {
      const next = await api.put<RoomModeAvailability>('/api/settings/room-modes', patch)
      setRoomModes(next)
      toast('杂项设置已保存', '房间模式开关即时生效', 'success')
    } catch (e) {
      api.get<RoomModeAvailability>('/api/settings/room-modes').then(setRoomModes).catch(() => {})
      toast('保存失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  // 录像定期归档:开关/时刻即时保存;「立即归档一次」对全部可归档的组下发任务
  const saveDemoArchive = async (patch: Partial<DemoArchiveSetting>) => {
    if (!demoArchive) return
    setSaving(true)
    try {
      const next = await api.put<DemoArchiveSetting>('/api/settings/demo-archive', patch)
      setDemoArchive(next)
      toast('杂项设置已保存', `录像定期归档：${next.enabled ? `开启（每天 ${next.hour}:00 后首次巡检生效）` : '已关闭'}`, 'success')
    } catch (e) {
      api.get<DemoArchiveSetting>('/api/settings/demo-archive').then(setDemoArchive).catch(() => {})
      toast('保存失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const runDemoArchiveNow = async () => {
    setArchiveRunning(true)
    try {
      const res = await api.post<{ ok: boolean; started: number; skipped: Array<{ groupId: string; reason: string }> }>(
        '/api/settings/demo-archive/run',
        {},
      )
      const skipped = (res.skipped ?? []).map((s) => `${s.groupId}:${s.reason}`).join('；')
      toast(
        res.started > 0 ? '归档任务已下发' : '本次没有可归档的组',
        res.started > 0 ? `${res.started} 个组已开始归集${skipped ? `；跳过：${skipped}` : ''}` : skipped || '全部跳过',
        res.started > 0 ? 'success' : 'default',
      )
      api.get<DemoArchiveSetting>('/api/settings/demo-archive').then(setDemoArchive).catch(() => {})
    } catch (e) {
      toast('下发失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setArchiveRunning(false)
    }
  }

  const save = async (patch: Partial<DisconnectGrace>) => {
    if (!grace) return
    setSaving(true)
    try {
      const next = await api.put<DisconnectGrace>('/api/settings/disconnect', patch)
      setGrace(next)
      toast('杂项设置已保存', '断线宽限设置即时生效', 'success')
    } catch (e) {
      toast('保存失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  // 默认最大玩家数：即时保存（失焦 / 回车 / 微调按钮提交时触发）
  const saveMaxPlayers = async (value: number) => {
    if (!maxPlayers || value === maxPlayers.maxPlayers) return
    setSaving(true)
    try {
      const next = await api.put<MaxPlayersSetting>('/api/settings/max-players', { maxPlayers: value })
      setMaxPlayers(next)
      toast('杂项设置已保存', `新房间默认最大玩家数：${next.maxPlayers}（可用玩家席 ${next.maxPlayers - next.tvSlots}）`, 'success')
    } catch (e) {
      // 保存失败时回读服务端现值，避免输入框停在与实际不符的数字上
      api.get<MaxPlayersSetting>('/api/settings/max-players').then(setMaxPlayers).catch(() => {})
      toast('保存失败', e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {roomModes ? (
          <div className="flex flex-col gap-4 p-4">
            <div>
              <p className="win-body-strong">房间模式</p>
              <p className="win-caption mt-0.5 leading-relaxed text-muted-foreground">
                关闭后，普通玩家创建房间时对应模式会置灰且不可选；管理员仍可创建。设置即时生效。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {([
                ['custom', '自定义竞技'],
                ['duel', '单挑对决'],
                ['botMode', '增强人机'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2">
                  <Switch
                    checked={roomModes[key]}
                    onChange={(e) => saveRoomModes({ [key]: e.target.checked })}
                    disabled={saving}
                  />
                  <span className="win-body">
                    {label}
                    <span className="win-caption ml-2 text-muted-foreground">{roomModes[key] ? '已开启' : '已关闭'}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div className="win-body flex items-center gap-2 p-4 text-muted-foreground">
            <Ring size={16} />
            加载中…
          </div>
        )}
      </Card>

      <Card>
        {grace ? (
          <div className="flex flex-col gap-4 p-4">
            <div>
              <p className="win-body-strong">断线自动退房</p>
              <p className="win-caption mt-0.5 leading-relaxed text-muted-foreground">
                玩家关闭网页或断网导致连接断开后，在宽限时间内未回到房间则自动退出（房主离开即解散房间）。
                关闭开关后不再有宽限计时——玩家断开将立即退出房间。设置即时生效并对全体玩家可用。
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-6">
              <label className="flex cursor-pointer items-center gap-2">
                <Switch
                  checked={grace.enabled}
                  onChange={(e) => save({ enabled: e.target.checked })}
                  disabled={saving}
                />
                <span className="win-body">
                  宽限计时
                  <span className="win-caption ml-2 text-muted-foreground">{grace.enabled ? '已开启' : '已关闭（断开立即退房）'}</span>
                </span>
              </label>
              <div className="grid gap-1.5">
                <Label>宽限时长（秒，0 = 永不超时）</Label>
                <div className="flex items-center gap-2">
                  <Input
                    className="w-28"
                    type="number"
                    min={0}
                    max={999}
                    value={grace.seconds}
                    disabled={saving || !grace.enabled}
                    onChange={(e) => {
                      const v = Math.min(999, Math.max(0, Math.round(Number(e.target.value) || 0)))
                      setGrace({ ...grace, seconds: v })
                    }}
                    onBlur={() => save({ seconds: grace.seconds })}
                    onKeyDown={(e) => e.key === 'Enter' && save({ seconds: grace.seconds })}
                  />
                  <Button size="sm" variant="outline" disabled={saving || !grace.enabled} onClick={() => save({ seconds: grace.seconds })}>
                    {saving && <Ring size={14} />}
                    保存时长
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">范围 0~999 秒；0 表示断开后永不自动退房（谨慎使用）</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="win-body flex items-center gap-2 p-4 text-muted-foreground">
            <Ring size={16} />
            加载中…
          </div>
        )}
      </Card>

      <Card>
        {maxPlayers ? (
          <div className="flex flex-col gap-4 p-4">
            <div>
              <p className="win-body-strong">默认最大玩家数（-maxplayers）</p>
              <p className="win-caption mt-0.5 leading-relaxed text-muted-foreground">
                新房间开赛时实例启动项 <code className="font-mono">-maxplayers</code> 的默认值（引擎口径，
                <b>含 SourceTV 占用的 {maxPlayers.tvSlots} 席</b>）→ 当前可用玩家席 ={' '}
                <b>
                  {maxPlayers.maxPlayers} − {maxPlayers.tvSlots} = {maxPlayers.maxPlayers - maxPlayers.tvSlots}
                </b>
                。管理员可在房间设置的「更多设置」里为单个房间单独覆盖。改动只影响之后的开赛，
                进行中的比赛不受影响；调小后既有房间（双方人数 + 观战席超过容量）开赛会报「房间容量超限」。
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="win-form-cell w-40">
                <Label htmlFor="default-max-players">最大玩家数（{maxPlayers.min}~{maxPlayers.max}）</Label>
                <NumberBox
                  id="default-max-players"
                  value={maxPlayers.maxPlayers}
                  min={maxPlayers.min}
                  max={maxPlayers.max}
                  disabled={saving}
                  onValueChange={saveMaxPlayers}
                />
              </div>
              <p className="win-caption pb-1.5 text-muted-foreground">
                可用玩家席（减 SourceTV）：
                <b className="font-mono text-foreground">{maxPlayers.maxPlayers - maxPlayers.tvSlots}</b>
              </p>
            </div>
          </div>
        ) : (
          <div className="win-body flex items-center gap-2 p-4 text-muted-foreground">
            <Ring size={16} />
            加载中…
          </div>
        )}
      </Card>

      <Card>
        {demoArchive ? (
          <div className="flex flex-col gap-4 p-4">
            <div>
              <p className="win-body-strong">录像定期归档</p>
              <p className="win-caption mt-0.5 leading-relaxed text-muted-foreground">
                每天到点把实例 <code className="font-mono">MatchZy/*.dem</code> 归集到主机录像目录，按
                「实例/日期」分目录 —— <b>只搬不删</b>（实例目录里搬走的文件到归档目录里找）。
                组内有进行中比赛 / 实例非空闲时会<b>跳过</b>（正在录的录像不能被搬走），下个巡检再补；
                每天只自动跑一次。也可在「主机概况」卡对单个组手动「归集录像」。
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-6">
              <label className="flex cursor-pointer items-center gap-2">
                <Switch
                  checked={demoArchive.enabled}
                  onChange={(e) => saveDemoArchive({ enabled: e.target.checked })}
                  disabled={saving}
                />
                <span className="win-body">
                  每日自动归档
                  <span className="win-caption ml-2 text-muted-foreground">
                    {demoArchive.enabled ? `已开启（${demoArchive.hour}:00 后首次巡检生效）` : '已关闭（仍可手动归集）'}
                  </span>
                </span>
              </label>
              <div className="win-form-cell w-36">
                <Label htmlFor="demo-archive-hour">执行时刻（0~23 时）</Label>
                <NumberBox
                  id="demo-archive-hour"
                  value={demoArchive.hour}
                  min={0}
                  max={23}
                  disabled={saving || !demoArchive.enabled}
                  onValueChange={(v) => v !== demoArchive.hour && saveDemoArchive({ hour: v })}
                />
              </div>
              <Button size="sm" variant="outline" disabled={archiveRunning} onClick={runDemoArchiveNow}>
                {archiveRunning && <Ring size={14} />}
                立即归档一次
              </Button>
              <p className="win-caption pb-1.5 text-muted-foreground">
                上次自动执行：
                <span className="font-mono">{demoArchive.lastRun ?? '—'}</span>
              </p>
            </div>
          </div>
        ) : (
          <div className="win-body flex items-center gap-2 p-4 text-muted-foreground">
            <Ring size={16} />
            加载中…
          </div>
        )}
      </Card>
    </div>
  )
}

/* ---------------- 页面 ---------------- */

export function AdminPage() {
  // 受控 Tab：实例卡片的「查看任务」与建实例冲突提示需要跳到「更新任务」并选中该任务
  const [tab, setTab] = useState('instances')
  const [focusJob, setFocusJob] = useState<{ id: number; seq: number } | null>(null)
  const openJob = (jobId: number | null) => {
    if (jobId != null) setFocusJob({ id: jobId, seq: Date.now() })
    setTab('jobs')
  }
  const clearFocusJob = useCallback(() => setFocusJob(null), [])

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="win-title">管理面板</h1>
        <p className="win-body mt-1 text-muted-foreground">仅管理员可见 · 操作即时生效</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full max-w-xl overflow-x-auto md:w-fit md:max-w-full">
          <TabsTrigger value="instances">实例管理</TabsTrigger>
          <TabsTrigger value="rooms">房间管理</TabsTrigger>
          <TabsTrigger value="servers">服务器组</TabsTrigger>
          <TabsTrigger value="maps">地图池调整</TabsTrigger>
          <TabsTrigger value="home">首页内容</TabsTrigger>
          <TabsTrigger value="misc">杂项设置</TabsTrigger>
          <TabsTrigger value="host">主机概况</TabsTrigger>
          <TabsTrigger value="jobs">更新任务</TabsTrigger>
        </TabsList>
        <TabsContent value="instances">
          <InstancesSection onOpenJob={openJob} />
        </TabsContent>
        <TabsContent value="rooms">
          <RoomsSection />
        </TabsContent>
        <TabsContent value="servers">
          <GameServersSection />
        </TabsContent>
        <TabsContent value="maps">
          <MapPoolSection />
        </TabsContent>
        <TabsContent value="home">
          <HomeContentSection />
        </TabsContent>
        <TabsContent value="misc">
          <MiscSettingsSection />
        </TabsContent>
        <TabsContent value="host">
          <HostStatusSection />
        </TabsContent>
        <TabsContent value="jobs">
          <JobsSection focusJob={focusJob} onFocusApplied={clearFocusJob} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
