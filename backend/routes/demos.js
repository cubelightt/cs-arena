// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// demo 上传接收端点
// MatchZy 每张图结束经 matchzy_demo_upload_url POST 原始 .dem(octet-stream),
// 头带 MatchZy-FileName/MatchId/MapNumber/RoundNumber,鉴权复用比赛 token。
// 上传无重试 → 立即 200;原子写入(tmp+rename),中断不产生半文件。
import express from 'express'
import { Router } from 'express'
import { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { getDb, now } from '../db.js'
import config from '../config.js'
import { demoArrived } from '../lib/instances.js'
import { requireAuth } from '../lib/auth.js'

export function createDemosRouter(ctx) {
  const router = Router()

  // 接收上传(原始字节,上限可配)
  router.post('/', express.raw({ type: '*/*', limit: config.demo.maxUploadBytes }), (req, res) => {
    const token = req.headers['x-arena-token']
    if (!token) return res.status(401).json({ error: 'missing token' })
    const match = getDb().prepare('SELECT * FROM matches WHERE token = ?').get(String(token))
    if (!match) return res.status(401).json({ error: 'unknown token' })

    const fileName = req.headers['matchzy-filename'] || req.headers['get5-filename']
    if (!fileName || !/^[\w.\-]+$/.test(String(fileName))) {
      return res.status(400).json({ error: 'bad filename' })
    }
    const hMatchId = Number(req.headers['matchzy-matchid'] || req.headers['get5-matchid'] || -1)
    if (hMatchId !== match.id) return res.status(400).json({ error: 'matchid mismatch' })

    const mapNumber = Number(req.headers['matchzy-mapnumber'] || req.headers['get5-mapnumber'] || 0)
    const roundNumber = Number(req.headers['matchzy-roundnumber'] || req.headers['get5-roundnumber'] || 0)
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty body' })

    const dir = path.join(config.demo.storageDir, String(match.id))
    const finalPath = path.join(dir, String(fileName))
    const tmpPath = `${finalPath}.tmp`
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(tmpPath, buf)
      renameSync(tmpPath, finalPath)
    } catch (err) {
      try { unlinkSync(tmpPath) } catch {}
      return res.status(500).json({ error: err.message })
    }

    getDb()
      .prepare(
        `INSERT INTO demos (match_id, map_number, round_number, file_name, stored_path, size, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id, file_name) DO NOTHING`,
      )
      .run(match.id, mapNumber, roundNumber, String(fileName), finalPath, buf.length, now())

    // 事件驱动:该比赛 demo 到齐 → 解除实例冷却
    demoArrived(match.id)

    res.json({ ok: true, size: buf.length, stored: finalPath })
  })

  // 列表(登录,无下载端点)
  router.get('/', requireAuth(), (req, res) => {
    const matchId = Number(req.query.matchId || 0)
    const rows = matchId > 0
      ? getDb().prepare('SELECT * FROM demos WHERE match_id = ? ORDER BY id').all(matchId)
      : getDb().prepare('SELECT * FROM demos ORDER BY id DESC LIMIT 100').all()
    res.json(
      rows.map((r) => ({
        id: r.id,
        matchId: r.match_id,
        mapNumber: r.map_number,
        roundNumber: r.round_number,
        fileName: r.file_name,
        size: r.size,
        receivedAt: r.received_at,
      })),
    )
  })

  return router
}
