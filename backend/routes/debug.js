// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 诊断端点(管理用,需登录):主机连通性探测 + 实例控制台日志
// 用于定位 matchzy_loadmatch_url 加载失败(网络不可达 / 插件未就绪 / JSON 校验失败)
import { Router } from 'express'
import { requireAdmin } from '../lib/auth.js'
import { bridgeProbe, bridgeLog, bridgeLocate, bridgePs } from '../lib/bridge.js'

export function createDebugRouter() {
  const router = Router()
  const admin = requireAdmin()

  // 从 MatchZy 主机探测 URL:GET /api/debug/probe?url=http%3A%2F%2F...
  router.get('/probe', admin, async (req, res) => {
    const url = String(req.query.url || '')
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url 需以 http(s):// 开头' })
    try {
      const r = await bridgeProbe(url)
      res.status(r.status).json({ requestedUrl: url, ...r.data })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // 实例控制台日志:GET /api/debug/log?instance=match1&lines=100
  router.get('/log', admin, async (req, res) => {
    const instance = String(req.query.instance || '')
    const lines = Number(req.query.lines || 100)
    if (!instance) return res.status(400).json({ error: '缺少 instance' })
    try {
      const r = await bridgeLog(instance, lines)
      res.status(r.status).json(r.data)
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // 主机日志文件搜索:GET /api/debug/locate
  router.get('/locate', admin, async (req, res) => {
    try {
      const r = await bridgeLocate()
      res.status(r.status).json(r.data)
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // 主机 CS2 进程列表:GET /api/debug/ps
  router.get('/ps', admin, async (req, res) => {
    try {
      const r = await bridgePs()
      res.status(r.status).json(r.data)
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  return router
}
