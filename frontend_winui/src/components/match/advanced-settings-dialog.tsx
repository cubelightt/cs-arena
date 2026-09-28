// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/winui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/winui/dialog'
import { SectionLabel } from '@/components/winui/label'
import { NumberBox } from '@/components/winui/number-box'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/winui/select'
import { Switch } from '@/components/winui/switch'
import { api } from '@/lib/api'
import { TEAM_COUNT_OPTIONS, type MaxPlayersSetting, type Room } from '@/lib/types'
import { useArena } from '@/stores/arena'

interface Props {
  room: Room
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 非房主：设置对全体可见但只读（开关置灰、不能确认） */
  canEdit: boolean
  /** 仅管理员：可改本房间实例的最大玩家数（maxPlayers 覆盖） */
  canAdmin: boolean
}

/** 弹窗内的单项设置：WinUI 设置页版式（左侧标题/说明，右侧控件）
 *
 *  两列网格（不是 flex）：控件在第 1 行右列、可选 footer 在第 2 行右列，与左侧提示同一行。
 *  右列宽度取「控件与 footer 里更宽的那个」，所以 footer 出现/消失都不会挤动控件 ——
 *  早先把按钮内联在控件右侧，一出现输入框就左移，用户明确要求按钮落到下方。
 */
function SettingRow({
  title,
  htmlFor,
  description,
  hint,
  control,
  footer,
}: {
  title: string
  htmlFor?: string
  /** 可省略：标题自解释的项只留开关，不再堆说明文字 */
  description?: ReactNode
  /** 标题下方的补充提示（关闭原因、副作用提醒等） */
  hint?: ReactNode
  control: ReactNode
  /** 控件下方的附加动作（如「跟随全局」），与提示文字同一行右对齐 */
  footer?: ReactNode
}) {
  return (
    <div className="win-card grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-1 p-4">
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-1">
        <label htmlFor={htmlFor} className="win-body-strong cursor-pointer">
          {title}
        </label>
        {description && <p className="win-caption leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <div className="col-start-2 row-start-1 flex items-center pt-0.5">{control}</div>
      {hint && (
        // min-h-7（28px）：提示行按控件高度预留，footer 按钮（24px）出现/消失都不改变行高 ——
        // 弹窗是垂直居中的，行高一变整个弹窗就会跟着上下位移（实测 2.25px）
        <p className="col-start-1 row-start-2 self-center min-h-7 win-caption leading-relaxed text-[var(--caution)]">
          {hint}
        </p>
      )}
      {footer && <div className="col-start-2 row-start-2 flex items-center justify-end">{footer}</div>}
    </div>
  )
}

/**
 * 房间「更多设置」ContentDialog：房间设置卡片里放不下的次级选项集中到这里。
 * 弹窗内只改草稿，点「确认」才提交给后端；「取消」/Esc/点遮罩丢弃草稿。
 * 新增选项：draft 加字段 → 下方分区加一行 SettingRow → patch 计算里加一行比对。
 */
export function RoomAdvancedSettingsDialog({ room, open, onOpenChange, canEdit, canAdmin }: Props) {
  const updateConfig = useArena((s) => s.updateConfig)
  const [draft, setDraft] = useState({
    knifeRound: room.knifeRound,
    friendlyFire: room.friendlyFire !== false,
    /** null = 跟随全局默认（不下发覆盖） */
    maxPlayers: room.maxPlayersOverride ?? null,
    /** 允许玩家修改局内ID（默认关闭；关闭时只有管理员能改对局显示名） */
    allowDisplayName: room.allowDisplayName === true,
    /** 允许中途加入观战（默认开启；关闭后本房间拒绝非名单观战申请） */
    spectatorJoin: room.spectatorJoin !== false,
    /** 保存Demo（默认开启；关闭后开赛下发的比赛 JSON record_demo=false，不保存对局录像） */
    recordDemo: room.recordDemo !== false,
    /** 单挑对决房间的人数（仅管理员可见/可改，用于测试非 1v1 场景；默认 1v1） */
    teamA: room.teamA,
    teamB: room.teamB,
  })
  const [saving, setSaving] = useState(false)
  // 全局默认（仅管理员需要：既用于展示「跟随全局默认」的值，也提供 NumberBox 的 2~64 边界）
  const [globalMax, setGlobalMax] = useState<MaxPlayersSetting | null>(null)

  // 打开时以房间当前值为草稿基线
  useEffect(() => {
    if (open) {
      setDraft({
        knifeRound: room.knifeRound,
        friendlyFire: room.friendlyFire !== false,
        maxPlayers: room.maxPlayersOverride ?? null,
        allowDisplayName: room.allowDisplayName === true,
        spectatorJoin: room.spectatorJoin !== false,
        recordDemo: room.recordDemo !== false,
        teamA: room.teamA,
        teamB: room.teamB,
      })
      setSaving(false)
    }
  }, [
    open,
    room.knifeRound,
    room.friendlyFire,
    room.maxPlayersOverride,
    room.allowDisplayName,
    room.spectatorJoin,
    room.recordDemo,
    room.teamA,
    room.teamB,
  ])

  // 全局默认每次都从后端读（GET /api/settings/max-players 仅要求登录），
  // 管理面板改了默认值后重新打开本弹窗即是新值——提示里的数字不写死
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .get<MaxPlayersSetting>('/api/settings/max-players')
      .then((s) => {
        if (!cancelled) setGlobalMax(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  const patch = useMemo(() => {
    const p: Partial<{
      knifeRound: boolean
      friendlyFire: boolean
      maxPlayers: number | null
      allowDisplayName: boolean
      spectatorJoin: boolean
      recordDemo: boolean
      teamA: number
      teamB: number
    }> = {}
    if (draft.knifeRound !== room.knifeRound) p.knifeRound = draft.knifeRound
    if (draft.friendlyFire !== (room.friendlyFire !== false)) p.friendlyFire = draft.friendlyFire
    if (draft.maxPlayers !== (room.maxPlayersOverride ?? null)) p.maxPlayers = draft.maxPlayers
    if (draft.allowDisplayName !== (room.allowDisplayName === true)) p.allowDisplayName = draft.allowDisplayName
    if (draft.spectatorJoin !== (room.spectatorJoin !== false)) p.spectatorJoin = draft.spectatorJoin
    if (draft.recordDemo !== (room.recordDemo !== false)) p.recordDemo = draft.recordDemo
    if (room.matchType === 'duel') {
      if (draft.teamA !== room.teamA) p.teamA = draft.teamA
      if (draft.teamB !== room.teamB) p.teamB = draft.teamB
    }
    return p
  }, [
    draft,
    room.knifeRound,
    room.friendlyFire,
    room.maxPlayersOverride,
    room.allowDisplayName,
    room.spectatorJoin,
    room.recordDemo,
    room.matchType,
    room.teamA,
    room.teamB,
  ])
  const dirty = Object.keys(patch).length > 0
  const maxPlayersEditable = canEdit && canAdmin

  // 生效条件与后端一致：BO1 + 直接选图/社区地图（BP 由选边流程定先后手，增强人机固定关闭）
  const knifeAvailable = room.bestOf === 1 && room.pickMode !== 'veto' && !room.botMode
  const knifeHint = knifeAvailable
    ? null
    : room.botMode
      ? '增强人机模式固定关闭刀战选边'
      : room.pickMode === 'veto'
        ? 'BP 选图的先后手由选边流程决定，刀战选边仅用于直接选图 / 社区地图'
        : '刀战选边仅在 BO1 开放'

  const handleConfirm = async () => {
    if (!canEdit) return
    if (!dirty) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    await updateConfig(room.id, patch)
    setSaving(false)
    // updateConfig 失败时内部已 toast；此处逐项比对房间数据确认已落库，未生效则留在弹窗便于重试
    const saved = useArena.getState().rooms.find((r) => r.id === room.id)
    if (saved) {
      const stale =
        (patch.knifeRound != null && saved.knifeRound !== patch.knifeRound) ||
        (patch.friendlyFire != null && (saved.friendlyFire !== false) !== patch.friendlyFire) ||
        (patch.maxPlayers !== undefined &&
          (patch.maxPlayers === null ? saved.maxPlayersOverride != null : saved.maxPlayersOverride !== patch.maxPlayers)) ||
        (patch.allowDisplayName != null && (saved.allowDisplayName === true) !== patch.allowDisplayName) ||
        (patch.spectatorJoin != null && (saved.spectatorJoin !== false) !== patch.spectatorJoin) ||
        (patch.recordDemo != null && (saved.recordDemo !== false) !== patch.recordDemo) ||
        (patch.teamA != null && saved.teamA !== patch.teamA) ||
        (patch.teamB != null && saved.teamB !== patch.teamB)
      if (stale) return
    }
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
      <DialogContent size="wide" className="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>更多设置</DialogTitle>
          <DialogDescription>房间的次级选项集中在这里，修改后点「确认」保存并对全体玩家生效</DialogDescription>
        </DialogHeader>

        <div className="min-h-[280px] overflow-y-auto border-t border-[var(--divider)] px-6 py-5">
          {!canEdit && (
            <p className="win-caption mb-3 text-muted-foreground">仅房主可修改房间设置，以下为当前设置项。</p>
          )}
          <section className="flex flex-col gap-3">
            <SectionLabel>比赛设置</SectionLabel>
            {/* 单挑对决房间的人数:常规建房锁 1v1,这里给管理员测试非 1v1 之用(后端同样仅管理员可改) */}
            {room.matchType === 'duel' && canAdmin && (
              <SettingRow
                title="人数设置"
                htmlFor="adv-duel-team-a"
                control={
                  <div className="flex items-center gap-2">
                    <Select
                      value={String(draft.teamA)}
                      onValueChange={(v) => setDraft({ ...draft, teamA: Number(v) })}
                      disabled={!canEdit || saving}
                    >
                      <SelectTrigger id="adv-duel-team-a" className="w-24">
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
                    <Select
                      value={String(draft.teamB)}
                      onValueChange={(v) => setDraft({ ...draft, teamB: Number(v) })}
                      disabled={!canEdit || saving}
                    >
                      <SelectTrigger aria-label="Team B 人数" className="w-24">
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
                }
              />
            )}
            <SettingRow
              title="最大玩家数（-maxplayers）"
              htmlFor="adv-max-players"
              description={
                <>
                  本房间开赛时实例启动项 <code className="font-mono">-maxplayers</code> 的值（引擎口径，含 SourceTV 1 席）。
                </>
              }
              hint={
                !maxPlayersEditable
                  ? canAdmin
                    ? '仅房主可修改房间设置；此项同时要求管理员权限'
                    : '仅管理员可调整（房间覆盖）；未覆盖时跟随全局默认'
                  : draft.maxPlayers == null
                    ? `当前跟随全局默认${globalMax ? ` ${globalMax.maxPlayers}` : ''}`
                    : `已覆盖全局默认${globalMax ? `（全局默认 ${globalMax.maxPlayers}）` : ''}`
              }
              control={
                <NumberBox
                  id="adv-max-players"
                  className="w-32"
                  value={draft.maxPlayers ?? globalMax?.maxPlayers ?? room.maxPlayers ?? 12}
                  min={globalMax?.min ?? 2}
                  max={globalMax?.max ?? 64}
                  disabled={!maxPlayersEditable || saving}
                  // 改回与全局默认相同的数值即视为「跟随全局」（草稿归 null）：既避免留下
                  // 与全局同值的僵尸覆盖，也让提示文字与真实状态一致
                  onValueChange={(v) => setDraft({ ...draft, maxPlayers: v === globalMax?.maxPlayers ? null : v })}
                />
              }
              footer={
                maxPlayersEditable && draft.maxPlayers != null ? (
                  <Button variant="subtle" size="sm" disabled={saving} onClick={() => setDraft({ ...draft, maxPlayers: null })}>
                    跟随全局
                  </Button>
                ) : null
              }
            />
            {/* 刀战选边开关不对单挑房提供（需求 2026-09-19）：单挑房保持房间当前值（后端默认开启），
                草稿仍以房间值初始化，diff 恒为空不会误提交 */}
            {room.matchType !== 'duel' && (
              <SettingRow
                title="刀战选边"
                htmlFor="adv-knife-round"
                description="开启后每张地图先打刀局，胜方选择先当 CT 还是先当 T；关闭则 Team A 固定先当 CT。"
                hint={knifeHint}
                control={
                  <Switch
                    id="adv-knife-round"
                    checked={draft.knifeRound}
                    disabled={!canEdit || !knifeAvailable || saving}
                    onChange={(e) => setDraft({ ...draft, knifeRound: e.target.checked })}
                  />
                }
              />
            )}
            <SettingRow
              title="友军伤害"
              htmlFor="adv-friendly-fire"
              // 提示只在关闭后出现：开着的时候讲「关闭会怎样」是误导，也占版面
              hint={draft.friendlyFire ? null : '关闭友军伤害后，手雷、燃烧弹等投掷物仍会造成伤害！'}
              control={
                <Switch
                  id="adv-friendly-fire"
                  checked={draft.friendlyFire}
                  disabled={!canEdit || saving}
                  onChange={(e) => setDraft({ ...draft, friendlyFire: e.target.checked })}
                />
              }
            />
            <SettingRow
              title="允许玩家修改局内ID"
              htmlFor="adv-allow-display-name"
              control={
                <Switch
                  id="adv-allow-display-name"
                  checked={draft.allowDisplayName}
                  disabled={!canEdit || saving}
                  onChange={(e) => setDraft({ ...draft, allowDisplayName: e.target.checked })}
                />
              }
            />
            <SettingRow
              title="允许中途加入观战"
              htmlFor="adv-spectator-join"
              description="开启后，比赛进行中不在本场名单里的玩家可申请观战。"
              hint={draft.spectatorJoin ? null : '关闭后本房间拒绝非名单观战申请（已获准的观战者不受影响）'}
              control={
                <Switch
                  id="adv-spectator-join"
                  checked={draft.spectatorJoin}
                  disabled={!canEdit || saving}
                  onChange={(e) => setDraft({ ...draft, spectatorJoin: e.target.checked })}
                />
              }
            />
            <SettingRow
              title="保存Demo"
              htmlFor="adv-record-demo"
              control={
                <Switch
                  id="adv-record-demo"
                  checked={draft.recordDemo}
                  disabled={!canEdit || saving}
                  onChange={(e) => setDraft({ ...draft, recordDemo: e.target.checked })}
                />
              }
            />
          </section>
        </div>

        <DialogFooter className="border-t border-[var(--divider)] p-6 pt-4">
          <Button variant="subtle" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={!canEdit || saving}>
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
