// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// demo 定期清理:按 retentionDays 删除超期文件,清理空目录,同步 DB 记录
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import { getDb, now } from '../db.js'
import config from '../config.js'

export function cleanupDemos({ retentionDays = config.demo.retentionDays, storageDir = config.demo.storageDir } = {}) {
  if (!existsSync(storageDir)) return { deleted: 0 }
  const cutoff = now() - retentionDays * 86400000
  const db = getDb()
  let deleted = 0

  for (const matchDirName of readdirSync(storageDir)) {
    const matchDir = path.join(storageDir, matchDirName)
    let st
    try {
      st = statSync(matchDir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    for (const f of readdirSync(matchDir)) {
      const fp = path.join(matchDir, f)
      let fst
      try {
        fst = statSync(fp)
      } catch {
        continue
      }
      if (fst.isDirectory()) continue
      // 残留 tmp(上传中断)直接清
      if (f.endsWith('.tmp')) {
        unlinkSync(fp)
        continue
      }
      if (fst.mtimeMs < cutoff) {
        try {
          unlinkSync(fp)
          db.prepare('DELETE FROM demos WHERE stored_path = ?').run(fp)
          deleted++
        } catch {
          // 忽略并发删除
        }
      }
    }
    // 空目录清理
    try {
      if (readdirSync(matchDir).length === 0) rmdirSync(matchDir)
    } catch {}
  }
  if (deleted > 0) console.log(`[demo-cleanup] 删除超期 demo ${deleted} 个(>${retentionDays} 天)`)
  return { deleted }
}

// 启动时异步执行一次 + 周期性执行
export function startDemoCleanup(intervalMs = config.demo.cleanupIntervalMs) {
  setTimeout(() => {
    try {
      cleanupDemos()
    } catch (err) {
      console.error('[demo-cleanup]', err.message)
    }
  }, 1000)
  setInterval(() => {
    try {
      cleanupDemos()
    } catch (err) {
      console.error('[demo-cleanup]', err.message)
    }
  }, intervalMs)
}
