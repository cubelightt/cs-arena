// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import type { MapMeta } from '@/lib/types'

/**
 * frontend_v2 地图视觉注册表。
 * 旧版用大色块渐变；v2 改为「浅色卡片 + 单色条」风格：
 * 每张图注册一个色相（hue），渲染层用 hsl(hue …) 生成色条/浅底，未知地图按名称 hash 稳定兜底。
 */
export const MAP_HUES: Record<string, number> = {
  de_mirage: 36,
  de_inferno: 8,
  de_nuke: 168,
  de_dust2: 47,
  de_ancient: 96,
  de_anubis: 196,
  de_vertigo: 248,
  de_train: 218,
  de_cache: 22,
  de_overpass: 208,
}

const FALLBACK_HUES = [0, 30, 60, 130, 170, 210, 260, 300]

export function mapHueOf(fullName: string): number {
  if (MAP_HUES[fullName] !== undefined) return MAP_HUES[fullName]
  let h = 0
  for (let i = 0; i < fullName.length; i++) h = (h * 31 + fullName.charCodeAt(i)) | 0
  return FALLBACK_HUES[Math.abs(h) % FALLBACK_HUES.length]
}

/** 地图展示定义（渲染层统一入口） */
export interface MapDisplay {
  /** 比赛内使用的 id（官方名） */
  fullName: string
  /** 中文显示名；目录缺失时兜底为 id 本身 */
  displayName: string
  /** 视觉色相（hsl 色条 / 浅底） */
  hue: number
  workshopId?: string | null
  internalName?: string | null
  /** 社区图后端缩略图（公开读取的 WebP 直连路径；官方图/未上传为 null） */
  thumbnailUrl: string | null
}

// 从地图目录中取地图定义；匹配按 id / fullName / internalName
// （比赛记录里的社区图可能存 internalName；未知地图兜底显示名=id）
export function mapDefOf(maps: MapMeta[], id: string): MapDisplay {
  const found = maps.find(
    (m) => m.id === id || m.fullName === id || (m.internalName != null && m.internalName === id),
  )
  if (found) {
    return {
      fullName: id,
      displayName: found.displayName,
      hue: mapHueOf(found.workshopId ?? id),
      workshopId: found.workshopId,
      internalName: found.internalName,
      thumbnailUrl: found.hasThumbnail ? found.thumbnailUrl ?? null : null,
    }
  }
  return { fullName: id, displayName: id, hue: mapHueOf(id), thumbnailUrl: null }
}
