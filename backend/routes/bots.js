// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 人机目录(增强人机模式前端选择器数据源):名字池 + 职业队
import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import { BOT_NAME_POOL, PRO_TEAMS } from '../lib/bots.js'

export function createBotsRouter() {
  const router = Router()
  const auth = requireAuth()

  router.get('/catalog', auth, (req, res) => {
    res.json({
      names: BOT_NAME_POOL,
      proTeams: PRO_TEAMS.map((t) => ({ id: t.id, name: t.name, roster: t.roster })),
    })
  })

  return router
}
