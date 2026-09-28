// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 对外接口:游戏服务器主动 GET 比赛 JSON(matchzy_loadmatch_url 拉取)
import { Router } from 'express'
import { getDb } from '../db.js'

export function createMatchRouter() {
  const router = Router()

  router.get('/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad match id' })
    const match = getDb().prepare('SELECT * FROM matches WHERE id = ?').get(id)
    console.log(`[match:fetch] id=${id} token=${req.query.token ? 'yes' : 'no'} ip=${req.ip}`)
    if (!match) return res.status(404).json({ error: 'match not found' })
    if (match.token !== req.query.token) return res.status(401).json({ error: 'bad token' })
    if (match.status === 'aborted') return res.status(410).json({ error: 'match aborted' })
    res.json(JSON.parse(match.payload))
  })

  return router
}
