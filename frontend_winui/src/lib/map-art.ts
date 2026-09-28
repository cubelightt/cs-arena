// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

/**
 * 地图美术注册表（frontend_winui 视觉层专有；不动 lib/maps.ts 的既有签名）。
 *
 * 图片为 CS2 官方地图截图，取自 ghostcap-gaming/cs2-map-images（16:9、无 HUD、面向 CS2 项目开放使用），
 * 已本地化为 1280×720 WebP 放在 `public/maps/`，随前端一起分发——不依赖第三方 CDN，
 * 局域网/离线环境下同样有图。来源与体积见 README「地图图片」一节。
 *
 * 未登记的地图（社区工坊图等）返回 null，由 MapCard 回退到色相磁贴，不会出现破图。
 */
export const MAP_ART: Record<string, string> = {
  de_dust2: '/maps/de_dust2.webp',
  de_mirage: '/maps/de_mirage.webp',
  de_inferno: '/maps/de_inferno.webp',
  de_nuke: '/maps/de_nuke.webp',
  de_ancient: '/maps/de_ancient.webp',
  de_anubis: '/maps/de_anubis.webp',
  de_vertigo: '/maps/de_vertigo.webp',
  de_train: '/maps/de_train.webp',
  de_cache: '/maps/de_cache.webp',
  de_overpass: '/maps/de_overpass.webp',
  // 休闲图（地图池里按需启用；标识名同后端 maps 表的 fullName）
  cs_italy: '/maps/cs_italy.webp',
  cs_office: '/maps/cs_office.webp',
}

/** 地图截图地址；无登记返回 null（调用方回退） */
export function mapArtOf(fullName: string): string | null {
  return MAP_ART[fullName] ?? null
}
