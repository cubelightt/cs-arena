// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { Ban, Check } from 'lucide-react'
import { useState } from 'react'
import { mapDefOf } from '@/lib/maps'
import { mapArtOf } from '@/lib/map-art'
import { useArena } from '@/stores/arena'
import { Button } from '@/components/winui/button'
import { cn } from '@/lib/utils'

interface MapCardProps {
  mapId: string
  state: 'available' | 'banned' | 'picked'
  pickOrder?: number
  disabled?: boolean
  active?: boolean
  onClick?: () => void
  onBan?: () => void
  onPick?: () => void
  showActions?: boolean
  compact?: boolean
}

/**
 * 地图卡：参考 HLTV 比赛地图卡的版式——上半为 16:9 地图截图，下半为深色名条写地图名
 * （原版名条放比分与队标，这里只留地图名）。
 *
 * 名条刻意使用固定深色而非主题令牌：它与照片是同一块「媒体磁贴」，在浅色/深色主题下
 * 都压在照片下方，跟随主题反而会让浅色主题下的照片卡出现割裂感。
 * 未登记截图的地图（社区工坊图）回退为色相磁贴，不会破图。
 */
export function MapCard({ mapId, state, pickOrder, disabled, active, onClick, onBan, onPick, showActions, compact }: MapCardProps) {
  const maps = useArena((s) => s.maps)
  const communityMaps = useArena((s) => s.communityMaps)
  const def = mapDefOf([...maps, ...communityMaps], mapId)
  // 优先本地官方图注册表；社区图用后端缩略图（管理员上传的 WebP，同官方图展示口径）。
  // 加载失败（如管理员刚删除缩略图、页面还拿着旧列表）回退色相磁贴，不出现破图
  const [artFailed, setArtFailed] = useState(false)
  const art = artFailed ? null : (mapArtOf(def.fullName) ?? def.thumbnailUrl)
  const hueColor = `hsl(${def.hue} 60% 50%)`

  return (
    <div
      onClick={onClick}
      className={cn(
        'win-card group relative overflow-hidden transition-colors',
        state === 'banned' && 'opacity-55',
        state === 'picked' && 'border-[var(--success)]',
        state === 'available' && active && 'border-[var(--accent)] ring-1 ring-[var(--accent)]',
        onClick && !disabled && 'cursor-pointer hover:border-[var(--accent)]',
      )}
    >
      {/* 地图截图（16:9） */}
      <div className="relative aspect-video w-full overflow-hidden bg-[var(--subtle-secondary)]">
        {art ? (
          <img
            src={art}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setArtFailed(true)}
            className={cn(
              'absolute inset-0 size-full object-cover transition-transform duration-200',
              state === 'banned' && 'grayscale',
              onClick && !disabled && 'group-hover:scale-[1.03]',
            )}
          />
        ) : (
          <div
            className={cn('absolute inset-0', state === 'banned' && 'grayscale')}
            style={{ background: `linear-gradient(135deg, ${hueColor}44, ${hueColor}12)` }}
          />
        )}

        {/* 状态角标 */}
        {state === 'picked' && (
          <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-[4px] bg-[var(--success)] text-[11px] font-semibold text-[var(--solid-quarternary)] shadow-sm">
            {pickOrder ?? <Check className="size-3" />}
          </span>
        )}
        {state === 'banned' && (
          <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-[4px] bg-black/65 text-white">
            <Ban className="size-3" />
          </span>
        )}
      </div>

      {/* 名条：地图名 */}
      <div className="flex items-center gap-2 bg-[#2b3544] px-2.5 py-1.5">
        <span className={cn('win-body-strong truncate text-white', state === 'banned' && 'line-through opacity-80')}>
          {def.displayName}
        </span>
        {!compact && def.internalName && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-white/45">{def.internalName}</span>
        )}
      </div>

      {/* BP 操作区（仅选图阶段） */}
      {showActions && state === 'available' && (
        <div className="flex gap-2 border-t border-[var(--divider)] p-2">
          <Button
            variant="destructive"
            size="sm"
            className="flex-1"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation()
              onBan?.()
            }}
          >
            Ban
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation()
              onPick?.()
            }}
          >
            Pick
          </Button>
        </div>
      )}
    </div>
  )
}
