// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 管理员面板:实例控制台(仅运行中实例)
// GET  读取本次运行的历史控制台(RUNNING 门禁,支持 lines/offset 增量)
// POST 执行任意单行控制台命令(RUNNING 门禁)
import { Router } from 'express'
import config from '../config.js'
import { requireAdmin } from '../lib/auth.js'
import * as bridge from '../lib/bridge.js'

export function createAdminRouter() {
  const router = Router()
  const admin = requireAdmin()

  async function assertRunning(instance, res) {
    let health
    try {
      health = await bridge.instanceStatus(instance)
    } catch {
      health = 'UNKNOWN'
    }
    if (health !== 'RUNNING') {
      res.status(409).json({ error: '实例未运行,无法访问控制台' })
      return false
    }
    return true
  }

  router.get('/instances/:name/console', admin, async (req, res) => {
    const { name } = req.params
    if (!(await assertRunning(name, res))) return
    const lines = Math.max(1, Math.min(Number(req.query.lines || 200), 2000))
    const offsetRaw = req.query.offset
    const offset = offsetRaw != null && offsetRaw !== '' ? Number(offsetRaw) : undefined
    try {
      const r = offset == null || Number.isNaN(offset)
        ? await bridge.bridgeLog(name, lines)
        : await bridge.bridgeLogWithOffset(name, offset)
      res.status(r.status).json(r.data)
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  router.post('/instances/:name/console', admin, async (req, res) => {
    const { name } = req.params
    if (!(await assertRunning(name, res))) return
    const command = req.body?.command
    if (typeof command !== 'string' || command.trim() === '') return res.status(400).json({ error: 'command 必填' })
    if (command.includes('\n') || command.includes('\r')) return res.status(400).json({ error: '命令必须为单行' })
    if (command.length > config.consoleCommandMaxLen) {
      return res.status(400).json({ error: `命令过长(上限 ${config.consoleCommandMaxLen} 字符)` })
    }
    try {
      const r = await bridge.bridgeConsole(name, command.trim())
      res.status(r.status).json(r.data)
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  return router
}
