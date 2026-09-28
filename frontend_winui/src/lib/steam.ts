// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import type { SteamUser } from '@/lib/types'

export const DEFAULT_STEAM_AVATAR =
  'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg'

export const DEMO_USER: SteamUser = {
  steamId: '76561198000000000',
  name: 'DemoPlayer',
  avatarUrl: DEFAULT_STEAM_AVATAR,
}

export interface ResolvedSteamProfile {
  steamId: string
  name: string
  avatarUrl: string
}

export function parseSteamInput(input: string): string | null {
  const t = input.trim()
  if (/^\d{17}$/.test(t)) return t
  let m = t.match(/steamcommunity\.com\/profiles\/(\d{17})/i)
  if (m) return m[1]
  m = t.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]+)/i)
  if (m) return `id/${m[1]}`
  if (/^id\/[A-Za-z0-9_-]+$/.test(t)) return t
  return null
}

export async function fetchSteamProfile(steamIdOrVanity: string): Promise<ResolvedSteamProfile> {
  // 优先走本地后端：经后端 STEAM_PROXY 拉取（无浏览器 CORS，代理由后端保证）
  try {
    const res = await fetch(`/api/auth/steam/profile?q=${encodeURIComponent(steamIdOrVanity)}`, {
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.json().catch(() => null)
    if (res.ok && body?.user) {
      return body.user as ResolvedSteamProfile
    }
    if (body?.error) throw new Error(body.error)
    throw new Error(`后端资料接口不可用 (HTTP ${res.status})`)
  } catch {
    // 后端不可用时降级第三方代理（保留原逻辑）
  }

  const isVanity = steamIdOrVanity.startsWith('id/')
  const target = isVanity
    ? `https://steamcommunity.com/id/${steamIdOrVanity.slice(3)}/?xml=1`
    : `https://steamcommunity.com/profiles/${steamIdOrVanity}/?xml=1`
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`
  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error('获取 Steam 资料失败')
  const xml = await res.text()
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const steamId = doc.querySelector('steamID64')?.textContent?.trim()
  const name = doc.querySelector('steamID')?.textContent?.trim()
  const avatarUrl = doc.querySelector('avatarFull')?.textContent?.trim()
  if (!steamId) throw new Error('未找到该 Steam 用户，请检查输入')
  return { steamId, name: name || 'SteamUser', avatarUrl: avatarUrl || DEFAULT_STEAM_AVATAR }
}
