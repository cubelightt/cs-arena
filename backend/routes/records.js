// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 战绩记录(前端 MatchRecord 对齐)
import { Router } from 'express'
import { getDb } from '../db.js'
import { requireAuth } from '../lib/auth.js'

export function createRecordsRouter() {
  const router = Router()
  const auth = requireAuth()

  router.get('/', auth, (req, res) => {
    const rows = getDb().prepare('SELECT * FROM records ORDER BY created_at DESC LIMIT 100').all()
    res.json(
      rows.map((r) => ({
        id: `rec-${r.id}`,
        roomId: r.room_id,
        roomName: r.room_name,
        code: r.code,
        matchType: r.match_type,
        bestOf: r.best_of,
        maps: JSON.parse(r.maps),
        players: JSON.parse(r.players),
        score1: r.score1,
        score2: r.score2,
        winner: r.winner,
        createdAt: r.created_at,
      })),
    )
  })

  router.get('/:id', auth, (req, res) => {
    const id = Number(String(req.params.id).replace(/^rec-/, ''))
    const r = getDb().prepare('SELECT * FROM records WHERE id = ?').get(id)
    if (!r) return res.status(404).json({ error: '记录不存在' })
    res.json({
      id: `rec-${r.id}`,
      roomId: r.room_id,
      roomName: r.room_name,
      code: r.code,
      matchType: r.match_type,
      bestOf: r.best_of,
      maps: JSON.parse(r.maps),
      players: JSON.parse(r.players),
      score1: r.score1,
      score2: r.score2,
      winner: r.winner,
      createdAt: r.created_at,
    })
  })

  return router
}
