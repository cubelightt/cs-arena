// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 认证路由:手动登录(dev 兜底)+ Steam OpenID 2.0 + 管理员密码
import { Router } from 'express'
import config from '../config.js'
import {
  currentUser,
  createSession,
  destroySession,
  upsertUser,
  openIdLoginUrl,
  verifyOpenIdResponse,
  parseCookies,
  setCookie,
  clearCookie,
  requireAuth,
  isAdmin,
  checkAdminLogin,
  setAdminPassword,
  RETURN_COOKIE,
  fetchSteamProfile,
} from '../lib/auth.js'

export function createAuthRouter() {
  const router = Router()

  function userJson(user) {
    return {
      steamId: user.steam_id,
      name: user.name,
      avatarUrl: user.avatar_url,
      isAdmin: isAdmin(user.steam_id),
    }
  }

  // 按输入解析 Steam 资料(手动登录用;经后端代理拉取,规避浏览器 CORS)
  router.get('/steam/profile', async (req, res) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) return res.status(400).json({ error: '缺少参数 q' })
    try {
      res.json({ user: await fetchSteamProfile(q) })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // 手动登录(前端 fetchSteamProfile 后传入;OpenID 不可用时兜底)
  // 管理员必须携带密码;首次登录(未设密码)返回 403 SETUP_REQUIRED 引导设置
  router.post('/login', async (req, res) => {
    const { steamId, name, avatarUrl, password } = req.body ?? {}
    if (!/^\d{17}$/.test(String(steamId || ''))) return res.status(400).json({ error: 'steamId 必须为 17 位数字' })
    const sid = String(steamId)

    if (isAdmin(sid)) {
      const r = checkAdminLogin(sid, password)
      if (r.code === 'SETUP_REQUIRED') {
        return res.status(403).json({ error: '管理员首次登录需设置密码', code: 'PASSWORD_SETUP_REQUIRED', steamId: sid })
      }
      if (r.code === 'BAD_PASSWORD') {
        return res.status(401).json({ error: '密码错误' })
      }
    }

    let finalName = String(name || '').slice(0, 64)
    let finalAvatar = String(avatarUrl || '')
    // 名称/头像缺失或为占位(SteamUser)时,后端自行解析 Steam 资料,避免显示占位名
    // (前端解析偶发失败时兜底;Steam 不可达则保留原值)
    if (!finalName || finalName === 'SteamUser' || !finalAvatar) {
      try {
        const profile = await fetchSteamProfile(sid)
        if (!finalName || finalName === 'SteamUser') finalName = profile.name
        if (!finalAvatar) finalAvatar = profile.avatarUrl
      } catch {
        // 忽略,使用提供的/占位值
      }
    }

    const user = upsertUser({
      steamId: sid,
      name: finalName || 'SteamUser',
      avatarUrl: finalAvatar,
    })
    createSession(res, user.steam_id)
    res.json({ user: userJson(user) })
  })

  // 管理员设置密码(宽松:steamid 属管理员即可;已设置返回 409)
  router.post('/set-password', (req, res) => {
    const { steamId, password } = req.body ?? {}
    if (!/^\d{17}$/.test(String(steamId || ''))) return res.status(400).json({ error: 'steamId 必须为 17 位数字' })
    const sid = String(steamId)
    if (!isAdmin(sid)) return res.status(403).json({ error: '仅管理员可设置密码' })
    if (typeof password !== 'string' || password.length < config.adminPasswordMinLength) {
      return res.status(400).json({ error: `密码长度至少 ${config.adminPasswordMinLength} 位` })
    }
    if (!setAdminPassword(sid, password)) {
      return res.status(409).json({ error: '密码已设置,请直接登录' })
    }
    const user = upsertUser({ steamId: sid, name: '', avatarUrl: '' })
    createSession(res, user.steam_id)
    res.json({ ok: true, user: userJson(user) })
  })

  // 当前登录用户
  router.get('/me', (req, res) => {
    const user = currentUser(req)
    if (!user) return res.status(401).json({ error: 'not logged in' })
    res.json({ user: userJson(user) })
  })

  router.post('/logout', (req, res) => {
    destroySession(req, res)
    res.json({ ok: true })
  })

  // Steam OpenID:跳转
  router.get('/steam/login', (req, res) => {
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/'
    setCookie(res, RETURN_COOKIE, returnTo, 600)
    const cb = `${config.publicBaseUrl}/api/auth/steam/callback`
    res.redirect(openIdLoginUrl(cb))
  })

  // Steam OpenID:回调校验
  // 管理员不直接建会话,跳转前端登录页并携带 admin 标识(需密码 / 首次需设置)
  router.get('/steam/callback', async (req, res) => {
    try {
      const result = await verifyOpenIdResponse(req.query)
      if (!result.valid) {
        return res.status(400).send(`OpenID 校验失败: ${result.reason || 'unknown'}`)
      }
      // 拉取 Steam 资料(昵称/头像)入库,避免占位名 SteamUser;失败兜底占位
      let profile = null
      try {
        profile = await fetchSteamProfile(result.steamId)
      } catch {
        profile = null
      }
      const user = upsertUser({
        steamId: result.steamId,
        name: profile?.name ?? '',
        avatarUrl: profile?.avatarUrl ?? '',
      })
      const returnTo = parseCookies(req)[RETURN_COOKIE] || '/'
      clearCookie(res, RETURN_COOKIE)
      const origin = new URL(config.publicBaseUrl).origin
      if (isAdmin(user.steam_id)) {
        const hasPassword = !!user.password_hash
        const sep = returnTo.includes('?') ? '&' : '?'
        res.redirect(`${origin}${returnTo}${sep}admin_login=1&admin_setup=${hasPassword ? 0 : 1}&admin_steam_id=${user.steam_id}`)
        return
      }
      createSession(res, user.steam_id)
      res.redirect(`${origin}${returnTo}`)
    } catch (err) {
      res.status(500).send(`OpenID 回调错误: ${err.message}`)
    }
  })

  router.get('/steam/verify', requireAuth(), (req, res) => {
    res.json({ user: req.user })
  })

  return router
}
