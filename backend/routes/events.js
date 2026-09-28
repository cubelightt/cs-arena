// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 对外接口:MatchZy remote_log 事件回调 POST(无重试,立即返回 200)
import { Router } from 'express'
import { getDb } from '../db.js'
import { handleEvent } from '../lib/events.js'

export function createEventsRouter(ctx) {
  const router = Router()
  const { io } = ctx

  router.post('/', (req, res) => {
    const token = req.headers['x-arena-token']
    if (!token) return res.status(401).json({ error: 'missing token' })

    const match = getDb().prepare('SELECT * FROM matches WHERE token = ?').get(String(token))
    if (!match) return res.status(401).json({ error: 'unknown token' })

    const event = req.body
    if (!event || typeof event !== 'object' || !event.event) {
      return res.status(400).json({ error: 'event object with "event" field required' })
    }
    if (match.id !== Number(event.matchid ?? -1)) {
      return res.status(400).json({ error: 'matchid mismatch' })
    }

    const result = handleEvent({ io, match, event })
    res.json({ ok: true, stored: result.stored })
  })

  return router
}
