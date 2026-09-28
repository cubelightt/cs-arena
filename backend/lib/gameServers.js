// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 游戏服务器(game_servers 表)读取辅助
// 运行时以 DB 为准;config.js 的 gameServers 仅作首次运行种子
import { getDb } from '../db.js'

export function listGameServers({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM game_servers WHERE is_active = 1 ORDER BY rowid'
    : 'SELECT * FROM game_servers ORDER BY rowid'
  return getDb().prepare(sql).all()
}

export function getGameServer(id) {
  return getDb().prepare('SELECT * FROM game_servers WHERE id = ?').get(id)
}

// 实例所属的服务器记录(bridge/主机信息等)
export function instanceServer(instanceName) {
  return getDb()
    .prepare('SELECT s.* FROM game_servers s JOIN instances i ON i.game_server_id = s.id WHERE i.name = ?')
    .get(instanceName)
}

export function serverInstanceNames(serverId) {
  return getDb().prepare('SELECT name FROM instances WHERE game_server_id = ?').all(serverId).map((r) => r.name)
}

export function allInstanceNames() {
  return getDb().prepare('SELECT name FROM instances').all().map((r) => r.name)
}
