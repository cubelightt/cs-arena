// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 会话持久化到 SQLite(重启不丢登录态),内存 Map 仅作缓存
import crypto from 'node:crypto'
import { ProxyAgent } from 'undici'
import { getDb, now } from '../db.js'
import config from '../config.js'

const SESSIONS = new Map() // sid → { steamId, createdAt } 缓存
const SID_COOKIE = 'arena_sid'
export const RETURN_COOKIE = 'arena_return'
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

function loadSession(sid) {
  const cached = SESSIONS.get(sid)
  if (cached) return cached
  const row = getDb().prepare('SELECT * FROM sessions WHERE sid = ?').get(sid)
  if (!row) return null
  if (now() - row.created_at > SESSION_TTL_MS) {
    getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid)
    return null
  }
  const s = { steamId: row.steam_id, createdAt: row.created_at }
  SESSIONS.set(sid, s)
  return s
}

export function parseCookies(req) {
  const header = req.headers.cookie || ''
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) {
      const k = part.slice(0, i).trim()
      const v = part.slice(i + 1).trim()
      if (k) out[k] = decodeURIComponent(v)
    }
  }
  return out
}

export function setCookie(res, name, value, maxAge) {
  res.setHeader(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${maxAge ? `; Max-Age=${maxAge}` : ''}`,
  )
}

export function clearCookie(res, name) {
  setCookie(res, name, '', -1)
}

function fetcher() {
  const { proxy } = config.steam
  if (!proxy) return fetch
  const dispatcher = new ProxyAgent(proxy)
  return (url, opts = {}) => fetch(url, { ...opts, dispatcher })
}

const DEFAULT_STEAM_AVATAR =
  'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg'

// 兼容 <tag>纯文本</tag> 与 <tag><![CDATA[...]]></tag> 两种形式
function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, 's'))
  return m ? m[1].trim() : ''
}

export function parseSteamInput(input) {
  const t = String(input ?? '').trim()
  if (/^\d{17}$/.test(t)) return t
  let m = t.match(/steamcommunity\.com\/profiles\/(\d{17})/i)
  if (m) return m[1]
  m = t.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]+)/i)
  if (m) return `id/${m[1]}`
  if (/^id\/[A-Za-z0-9_-]+$/.test(t)) return t
  return null
}

// 经 STEAM_PROXY 拉取 Steam 资料(规避浏览器 CORS,代理可用性由后端保证)
export async function fetchSteamProfile(input) {
  const parsed = parseSteamInput(input)
  if (!parsed) throw new Error('无法识别的 Steam 输入,支持 17 位 ID / 资料链接 / 自定义 URL')
  const isVanity = parsed.startsWith('id/')
  const url = isVanity
    ? `https://steamcommunity.com/id/${parsed.slice(3)}/?xml=1`
    : `https://steamcommunity.com/profiles/${parsed}/?xml=1`
  const f = fetcher()
  const res = await f(url, {
    headers: { accept: 'text/xml', 'user-agent': 'Mozilla/5.0 (Arena)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`获取 Steam 资料失败 (HTTP ${res.status})`)
  const xml = await res.text()
  const steamId = xmlField(xml, 'steamID64')
  if (!steamId) throw new Error('未找到该 Steam 用户,请检查输入')
  const name = xmlField(xml, 'steamID') || 'SteamUser'
  const avatarUrl = xmlField(xml, 'avatarFull') || DEFAULT_STEAM_AVATAR
  return { steamId, name, avatarUrl }
}

export function upsertUser({ steamId, name, avatarUrl }) {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId)
  if (existing) {
    db.prepare('UPDATE users SET name = ?, avatar_url = ? WHERE steam_id = ?').run(
      name || existing.name,
      avatarUrl || existing.avatar_url,
      steamId,
    )
    return db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId)
  }
  db.prepare('INSERT INTO users (steam_id, name, avatar_url, created_at) VALUES (?, ?, ?, ?)').run(
    steamId,
    name || 'SteamUser',
    avatarUrl || '',
    now(),
  )
  return db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId)
}

export function createSession(res, steamId) {
  const sid = crypto.randomBytes(24).toString('hex')
  const s = { steamId, createdAt: now() }
  SESSIONS.set(sid, s)
  getDb().prepare('INSERT INTO sessions (sid, steam_id, created_at) VALUES (?, ?, ?)').run(sid, steamId, s.createdAt)
  setCookie(res, SID_COOKIE, sid, Math.floor(SESSION_TTL_MS / 1000))
  return sid
}

export function destroySession(req, res) {
  const sid = parseCookies(req)[SID_COOKIE]
  if (sid) {
    SESSIONS.delete(sid)
    getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid)
  }
  clearCookie(res, SID_COOKIE)
}

export function currentUser(req) {
  const sid = parseCookies(req)[SID_COOKIE]
  if (!sid) return null
  const s = loadSession(sid)
  if (!s) return null
  return getDb().prepare('SELECT * FROM users WHERE steam_id = ?').get(s.steamId) ?? null
}

// Socket.io 握手鉴权(解析 cookie 中的会话)
export function userFromSocket(socket) {
  const cookie = socket.handshake?.headers?.cookie
  if (!cookie) return null
  return currentUser({ headers: { cookie } })
}

// ---- 管理员与密码 ----

const SCRYPT_KEYLEN = 32

// 是否管理员(运行时读 config.adminSteamIds)
export function isAdmin(steamId) {
  return config.adminSteamIds.includes(String(steamId))
}

// scrypt 哈希:salt(16B hex):hash(32B hex),零依赖
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
}

// 管理员密码校验:返回 { ok, code } — code: 'SETUP_REQUIRED' | 'BAD_PASSWORD' | 'OK'
export function checkAdminLogin(steamId, password) {
  const user = getDb().prepare('SELECT password_hash FROM users WHERE steam_id = ?').get(steamId)
  const stored = user?.password_hash ?? null
  if (!stored) return { ok: false, code: 'SETUP_REQUIRED' }
  if (!verifyPassword(password ?? '', stored)) return { ok: false, code: 'BAD_PASSWORD' }
  return { ok: true, code: 'OK' }
}

// 设置管理员密码(宽松:steamid 属管理员即可;重复设置返回 false)
export function setAdminPassword(steamId, password) {
  const db = getDb()
  const user = db.prepare('SELECT password_hash FROM users WHERE steam_id = ?').get(steamId)
  if (user?.password_hash) return false
  const hash = hashPassword(password)
  if (!user) {
    db.prepare('INSERT INTO users (steam_id, name, avatar_url, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      steamId,
      'SteamUser',
      '',
      hash,
      now(),
    )
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE steam_id = ?').run(hash, steamId)
  }
  return true
}

export function requireAdmin() {
  return (req, res, next) => {
    const user = currentUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(user.steam_id)) return res.status(403).json({ error: '需要管理员权限' })
    req.user = user
    next()
  }
}

export function requireAuth() {
  return (req, res, next) => {
    const user = currentUser(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    req.user = user
    next()
  }
}

// ---- Steam OpenID 2.0 ----

const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login'

export function openIdLoginUrl(returnTo) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': `${new URL(config.publicBaseUrl).origin}/`,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  })
  return `${OPENID_ENDPOINT}?${params.toString()}`
}

// 校验 OpenID 回调:把参数回 POST 给 Steam,检查 is_valid
export async function verifyOpenIdResponse(query) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('openid.')) params.set(k, String(v))
  }
  if (params.get('openid.mode') !== 'id_res') return { valid: false, reason: 'bad mode' }
  params.set('openid.mode', 'check_authentication')

  const f = fetcher()
  const res = await f(OPENID_ENDPOINT, {
    method: 'POST',
    body: params.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  const text = await res.text()
  const valid = /is_valid\s*:\s*true/i.test(text)
  if (!valid) return { valid: false, reason: text.slice(0, 200) }

  const claimed = params.get('openid.claimed_id')
  const m = claimed?.match(/\/openid\/id\/(\d{17})$/)
  return m ? { valid: true, steamId: m[1] } : { valid: false, reason: 'bad claimed_id' }
}
