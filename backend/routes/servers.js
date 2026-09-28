// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 服务器状态查询(需登录):分组列出 agent 控制的所有实例及三态(比赛中/空闲/已停止)
// 普通用户隐藏 admin_only 实例;管理员可见全部
import { Router } from 'express'
import { requireAuth, isAdmin } from '../lib/auth.js'
import { buildServerStatus } from '../lib/servers.js'

export function createServersRouter() {
  const router = Router()
  const auth = requireAuth()

  router.get(['/', '/status'], auth, async (req, res) => {
    try {
      res.json(await buildServerStatus({ showAdminOnly: isAdmin(req.user.steam_id) }))
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  return router
}
