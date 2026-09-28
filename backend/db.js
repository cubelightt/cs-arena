// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import config from './config.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  steam_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  avatar_url    TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id           TEXT PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  host_id      TEXT NOT NULL,
  password     TEXT NOT NULL DEFAULT '',
  match_type   TEXT NOT NULL DEFAULT 'custom',
  team_a       INTEGER NOT NULL DEFAULT 5,
  team_b       INTEGER NOT NULL DEFAULT 5,
  team_a_name  TEXT NOT NULL DEFAULT 'TEAM A',
  team_b_name  TEXT NOT NULL DEFAULT 'TEAM B',
  spec_seats   INTEGER NOT NULL DEFAULT 1,
  best_of      INTEGER NOT NULL DEFAULT 1,
  pick_mode    TEXT NOT NULL DEFAULT 'veto',
  status       TEXT NOT NULL DEFAULT 'waiting',
  slots        TEXT NOT NULL DEFAULT '[]',
  map_pool     TEXT NOT NULL DEFAULT '[]',
  banned       TEXT NOT NULL DEFAULT '[]',
  picked       TEXT NOT NULL DEFAULT '[]',
  veto_history TEXT NOT NULL DEFAULT '[]',
  veto_turn    INTEGER NOT NULL DEFAULT 0,
  veto_deadline_at INTEGER,
  bp_phase       TEXT,
  side_choices   TEXT,
  side_pending_for TEXT,
  knife_round  INTEGER NOT NULL DEFAULT 0,
  auto_fill    INTEGER NOT NULL DEFAULT 0,
  friendly_fire INTEGER NOT NULL DEFAULT 1,
  record_demo  INTEGER NOT NULL DEFAULT 1,
  overtime_enabled INTEGER NOT NULL DEFAULT 1,
  allow_display_name INTEGER NOT NULL DEFAULT 0,
  spectator_join INTEGER NOT NULL DEFAULT 1,
  max_players  INTEGER,
  bot_mode     INTEGER NOT NULL DEFAULT 0,
  bot_aim      TEXT NOT NULL DEFAULT 'mixed',
  bot_nades    TEXT NOT NULL DEFAULT 'normal',
  bot_proteam  TEXT,
  captain_a    TEXT,
  captain_b    TEXT,
  display_names TEXT NOT NULL DEFAULT '{}',
  server_choice TEXT,
  server       TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id          TEXT NOT NULL,
  token            TEXT NOT NULL,
  instance_name    TEXT,
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  current_scores   TEXT,
  spectators_extra TEXT NOT NULL DEFAULT '[]',
  arena_match_sha256 TEXT,
  arena_match_bind_started INTEGER NOT NULL DEFAULT 0,
  arena_match_close_confirmed INTEGER NOT NULL DEFAULT 0,
  arena_match_result_seq INTEGER NOT NULL DEFAULT 0,
  arena_match_result_json TEXT,
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_id);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    INTEGER NOT NULL,
  event_name  TEXT NOT NULL,
  dedup_key   TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(match_id, event_name, dedup_key);
CREATE INDEX IF NOT EXISTS idx_events_match ON events(match_id);

CREATE TABLE IF NOT EXISTS game_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  host_ip      TEXT NOT NULL DEFAULT '',
  region       TEXT NOT NULL DEFAULT '',
  bridge_url   TEXT NOT NULL DEFAULT '',
  bridge_token TEXT NOT NULL DEFAULT '',
  bridge_mode  TEXT NOT NULL DEFAULT 'http',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS instances (
  name           TEXT PRIMARY KEY,
  port           INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'idle',
  match_id       INTEGER,
  game_server_id TEXT,
  admin_only     INTEGER NOT NULL DEFAULT 0,
  idx            INTEGER,
  provision_state TEXT,
  provision_error TEXT,
  source         TEXT NOT NULL DEFAULT 'seed',
  created_at     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL,
  room_name  TEXT NOT NULL,
  code       TEXT NOT NULL,
  match_type TEXT NOT NULL,
  best_of    INTEGER NOT NULL,
  maps       TEXT NOT NULL,
  players    TEXT NOT NULL,
  score1     INTEGER NOT NULL DEFAULT 0,
  score2     INTEGER NOT NULL DEFAULT 0,
  winner     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS demos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id     INTEGER NOT NULL,
  map_number   INTEGER NOT NULL DEFAULT 0,
  round_number INTEGER NOT NULL DEFAULT 0,
  file_name    TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  received_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_demos_dedup ON demos(match_id, file_name);
CREATE INDEX IF NOT EXISTS idx_demos_match ON demos(match_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  steam_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maps (
  full_name     TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'official',        -- official(官方) / workshop(社区/创意工坊)
  workshop_id   TEXT,                                     -- workshop 图:host_workshop_map 数字 id
  internal_name TEXT,                                     -- workshop 图:服务器内部地图名(MatchZy 换图必需)
  match_types   TEXT NOT NULL DEFAULT '["custom","duel"]', -- 适用房间类型(custom/duel)
  created_at    INTEGER NOT NULL
);

-- 任务(job 框架;M4):桥 v2 执行,平台记状态与授权,进度经 push kind:'job' 实时更新
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,              -- game_update | instance_create | instance_delete | plugin_sync | plugin_deploy | demo_collect | host_cleanup
  server_id     TEXT,
  group_id      TEXT,
  instance_name TEXT,
  status        TEXT NOT NULL,              -- queued | running | cancelling | done | failed | cancelled
  step          TEXT,
  step_index    INTEGER,
  step_total    INTEGER,
  progress      INTEGER NOT NULL DEFAULT 0,
  params        TEXT NOT NULL DEFAULT '{}',
  result        TEXT,
  error         TEXT,
  origin        TEXT NOT NULL DEFAULT 'panel',  -- panel(平台发起) / cli(主机侧 cs 命令,经 job_report 收敛)
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER
);

-- 维护模式(按服务器组;M4):权威在平台 —— 更新任务期间该组全实例不可用
CREATE TABLE IF NOT EXISTS maintenance (
  group_id   TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  reason     TEXT,
  job_id     INTEGER,
  started_at INTEGER,
  by         TEXT
);
`

let db

export function initDb(path) {
  db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)

  // 迁移:旧库补列
  const roomCols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name)
  if (!roomCols.includes('veto_deadline_at')) {
    db.exec('ALTER TABLE rooms ADD COLUMN veto_deadline_at INTEGER')
  }
  if (!roomCols.includes('team_a_name')) {
    db.exec("ALTER TABLE rooms ADD COLUMN team_a_name TEXT NOT NULL DEFAULT 'TEAM A'")
  }
  if (!roomCols.includes('team_b_name')) {
    db.exec("ALTER TABLE rooms ADD COLUMN team_b_name TEXT NOT NULL DEFAULT 'TEAM B'")
  }
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  if (!userCols.includes('password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT')
  }
  if (!roomCols.includes('server_choice')) {
    db.exec('ALTER TABLE rooms ADD COLUMN server_choice TEXT')
  }
  if (!roomCols.includes('knife_round')) {
    db.exec('ALTER TABLE rooms ADD COLUMN knife_round INTEGER NOT NULL DEFAULT 1')
  }
  if (!roomCols.includes('auto_fill')) {
    // v2 槽位面板「自动补位」开关(房主可控,广播全体):0=精确槽位(默认) 1=自动补位(旧行为)
    db.exec('ALTER TABLE rooms ADD COLUMN auto_fill INTEGER NOT NULL DEFAULT 0')
  }
  if (!roomCols.includes('friendly_fire')) {
    // 房间「友军伤害」开关:1=开启(默认,同 competitive/MatchZy 默认) 0=关闭(队友免疫子弹伤害)
    db.exec('ALTER TABLE rooms ADD COLUMN friendly_fire INTEGER NOT NULL DEFAULT 1')
  }
  if (!roomCols.includes('max_players')) {
    // 房间级实例最大玩家数(-maxplayers;仅管理员可改):NULL=跟随全局默认 settings.default_max_players
    db.exec('ALTER TABLE rooms ADD COLUMN max_players INTEGER')
  }
  if (!roomCols.includes('bot_mode')) {
    // 增强人机模式:TeamB 全人机、TeamA 真人(可加人机);仅 bot 实例可用
    db.exec('ALTER TABLE rooms ADD COLUMN bot_mode INTEGER NOT NULL DEFAULT 0')
  }
  if (!roomCols.includes('bot_aim')) {
    db.exec("ALTER TABLE rooms ADD COLUMN bot_aim TEXT NOT NULL DEFAULT 'mixed'")
  }
  if (!roomCols.includes('bot_nades')) {
    db.exec("ALTER TABLE rooms ADD COLUMN bot_nades TEXT NOT NULL DEFAULT 'normal'")
  }
  if (!roomCols.includes('bot_proteam')) {
    db.exec('ALTER TABLE rooms ADD COLUMN bot_proteam TEXT')
  }
  if (!roomCols.includes('captain_a')) {
    db.exec('ALTER TABLE rooms ADD COLUMN captain_a TEXT')
  }
  if (!roomCols.includes('captain_b')) {
    db.exec('ALTER TABLE rooms ADD COLUMN captain_b TEXT')
  }
  if (!roomCols.includes('bp_phase')) {
    db.exec('ALTER TABLE rooms ADD COLUMN bp_phase TEXT')
  }
  if (!roomCols.includes('side_choices')) {
    db.exec('ALTER TABLE rooms ADD COLUMN side_choices TEXT')
  }
  if (!roomCols.includes('side_pending_for')) {
    db.exec('ALTER TABLE rooms ADD COLUMN side_pending_for TEXT')
  }
  if (!roomCols.includes('display_names')) {
    // 对局内显示名(比赛用 id,与房间绑定):{ steamId: name },开赛时写入比赛 JSON 的玩家名
    db.exec("ALTER TABLE rooms ADD COLUMN display_names TEXT NOT NULL DEFAULT '{}'")
  }
  if (!roomCols.includes('overtime_enabled')) {
    db.exec('ALTER TABLE rooms ADD COLUMN overtime_enabled INTEGER NOT NULL DEFAULT 1')
  }
  db.exec('UPDATE rooms SET overtime_enabled = 1 WHERE best_of = 3 AND overtime_enabled = 0')
  if (!roomCols.includes('record_demo')) {
    // 房间「对局录像」开关:1=开启(默认,GOTV 录制并在赛后收集 demo) 0=关闭(不录制 demo,完赛后立即解除冷却)
    db.exec('ALTER TABLE rooms ADD COLUMN record_demo INTEGER NOT NULL DEFAULT 1')
  }
  if (!roomCols.includes('allow_display_name')) {
    // 房间「允许玩家修改显示名」开关:0=关闭(默认,仅管理员可设置) 1=玩家可改自己
    db.exec('ALTER TABLE rooms ADD COLUMN allow_display_name INTEGER NOT NULL DEFAULT 0')
  }
  if (!roomCols.includes('spectator_join')) {
    // 房间「允许中途加入观战」开关:1=开启(默认) 0=关闭(本房间不接收非名单观战申请)
    // 平台级总开关在 settings.spectator_join(管理员,默认开启) —— 两者都开才允许申请
    db.exec('ALTER TABLE rooms ADD COLUMN spectator_join INTEGER NOT NULL DEFAULT 1')
  }
  if (!roomCols.includes('map_pool_kind')) {
    // 单挑对决(1v1)「地图池选择」:total=总竞技图池(官方图,默认) duel=单挑图池(社区图勾选「单挑对决」)
    // 仅 pickMode=direct 时决定房间地图池;custom 房间恒为 total
    db.exec("ALTER TABLE rooms ADD COLUMN map_pool_kind TEXT NOT NULL DEFAULT 'total'")
  }
  if (!roomCols.includes('max_rounds')) {
    // 单挑对决(1v1)回合局数(mp_maxrounds,默认 31=16 胜):NULL=默认;仅 duel 房间可改,必须为奇数
    db.exec('ALTER TABLE rooms ADD COLUMN max_rounds INTEGER')
  }
  if (!roomCols.includes('duel_preset')) {
    // 单挑对决(1v1)玩法类型:rifle=长枪决斗(默认)/ pistol=手枪决斗 / sniper=狙击决斗 / solo=Solo三项
    // (solo = 51 回合 = 10 手枪 + 28 长枪 + 13 狙击;仅 duel 房间可改,custom 房间忽略)
    db.exec("ALTER TABLE rooms ADD COLUMN duel_preset TEXT NOT NULL DEFAULT 'rifle'")
  }

  // 拼刀选边默认关闭(2026-09-19,产品决策):存量 duel 房间统一纠正为关闭 —— 单挑固定无刀局,
  // /config 对 duel 房传 knifeRound=true 已 400。进行中的比赛不受影响(比赛 JSON 开赛时已生成)。
  // 幂等:每次启动执行(兼作不变量兜底);knife_round 列的 schema 默认值仅对新库生效(建表语句),
  // 旧库列默认仍为 1,但建房 INSERT 恒显式传值,不受影响。
  db.exec("UPDATE rooms SET knife_round = 0 WHERE match_type = 'duel' AND knife_round != 0")

  const matchCols = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name)
  if (!matchCols.includes('spectators_extra')) {
    // 非名单中途观战:经 matchzy_addplayer 追加进实例名单的 steamid 列表(JSON 数组;席位计数 + 幂等)
    db.exec("ALTER TABLE matches ADD COLUMN spectators_extra TEXT NOT NULL DEFAULT '[]'")
  }
  if (!matchCols.includes('arena_match_sha256')) {
    db.exec('ALTER TABLE matches ADD COLUMN arena_match_sha256 TEXT')
  }
  if (!matchCols.includes('arena_match_bind_started')) {
    db.exec('ALTER TABLE matches ADD COLUMN arena_match_bind_started INTEGER NOT NULL DEFAULT 0')
  }
  if (!matchCols.includes('arena_match_close_confirmed')) {
    db.exec('ALTER TABLE matches ADD COLUMN arena_match_close_confirmed INTEGER NOT NULL DEFAULT 0')
  }
  if (!matchCols.includes('arena_match_result_seq')) {
    db.exec('ALTER TABLE matches ADD COLUMN arena_match_result_seq INTEGER NOT NULL DEFAULT 0')
  }
  if (!matchCols.includes('arena_match_result_json')) {
    db.exec('ALTER TABLE matches ADD COLUMN arena_match_result_json TEXT')
  }

  // game_servers 种子(config.js 仅首次运行使用)
  const gsCount = db.prepare('SELECT COUNT(*) AS c FROM game_servers').get().c
  if (gsCount === 0) {
    const insert = db.prepare(
      'INSERT INTO game_servers (id, name, host_ip, region, bridge_url, bridge_token, bridge_mode, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const s of config.gameServers) {
      insert.run(s.id, s.name, s.host_ip, s.region, s.bridge_url, s.bridge_token, s.bridge_mode ?? 'http', s.is_active ?? 1, Date.now())
    }
  }
  const gsCols = db.prepare('PRAGMA table_info(game_servers)').all().map((c) => c.name)
  if (!gsCols.includes('bridge_mode')) {
    db.exec("ALTER TABLE game_servers ADD COLUMN bridge_mode TEXT NOT NULL DEFAULT 'http'")
  }

  // instances 迁移 + 种子
  const instCols = db.prepare('PRAGMA table_info(instances)').all().map((c) => c.name)
  if (!instCols.includes('game_server_id')) {
    db.exec('ALTER TABLE instances ADD COLUMN game_server_id TEXT')
  }
  if (!instCols.includes('admin_only')) {
    db.exec('ALTER TABLE instances ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0')
  }
  // M5 建删实例闭环:编号(idx:主机注册表在平台的镜像,组内唯一)/ 供给状态 / 来源
  if (!instCols.includes('idx')) {
    db.exec('ALTER TABLE instances ADD COLUMN idx INTEGER')
  }
  if (!instCols.includes('provision_state')) {
    // null(正常)| creating(正在建)| deleting(正在删)| failed(失败可重试)
    // 非 null 期间实例不可被自动分配/手动选择(实例供给状态约定)
    db.exec('ALTER TABLE instances ADD COLUMN provision_state TEXT')
  }
  if (!instCols.includes('provision_error')) {
    db.exec('ALTER TABLE instances ADD COLUMN provision_error TEXT')
  }
  if (!instCols.includes('source')) {
    // seed(首次种子)| panel(面板建/改)| bridge_report(主机侧 cs new 上报,待确认)
    db.exec("ALTER TABLE instances ADD COLUMN source TEXT NOT NULL DEFAULT 'seed'")
  }
  if (!instCols.includes('created_at')) {
    db.exec('ALTER TABLE instances ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0')
  }
  db.exec('UPDATE instances SET game_server_id = (SELECT id FROM game_servers ORDER BY rowid LIMIT 1) WHERE game_server_id IS NULL')
  // 回填(幂等):created_at 取 updated_at;idx 按同组 rowid 顺序编号,只补 idx 为空的行
  // (缺号不回收,新实例取组内 max+1 —— 与桥侧注册表、M5 建实例同口径)
  db.exec('UPDATE instances SET created_at = updated_at WHERE created_at = 0')
  for (const g of db.prepare('SELECT id FROM game_servers ORDER BY rowid').all()) {
    const startIdx = db.prepare('SELECT COALESCE(MAX(idx), 0) + 1 AS n FROM instances WHERE game_server_id = ?').get(g.id).n
    const unnumbered = db.prepare('SELECT name FROM instances WHERE game_server_id = ? AND idx IS NULL ORDER BY rowid').all(g.id)
    const updIdx = db.prepare('UPDATE instances SET idx = ? WHERE name = ?')
    let n = startIdx
    for (const r of unnumbered) updIdx.run(n++, r.name)
  }

  const instCount = db.prepare('SELECT COUNT(*) AS c FROM instances').get().c
  if (instCount === 0) {
    const insert = db.prepare(
      'INSERT INTO instances (name, port, state, game_server_id, admin_only, idx, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const s of config.gameServers) {
      let idx = 1
      for (const inst of s.instances || []) {
        const ts = Date.now()
        insert.run(inst.name, inst.port, 'idle', s.id, inst.adminOnly ? 1 : 0, idx++, 'seed', ts, ts)
      }
    }
  }

  // maps 目录种子(官方名称 + 中文显示名;INSERT OR IGNORE 不覆盖管理员录入)
  const insMap = db.prepare('INSERT OR IGNORE INTO maps (full_name, display_name, created_at) VALUES (?, ?, ?)')
  for (const m of config.mapDefs) {
    insMap.run(m.fullName, m.displayName, Date.now())
  }

  // maps 迁移:社区图列(kind / workshop_id / internal_name / match_types)
  const mapCols = db.prepare('PRAGMA table_info(maps)').all().map((c) => c.name)
  if (!mapCols.includes('kind')) {
    db.exec("ALTER TABLE maps ADD COLUMN kind TEXT NOT NULL DEFAULT 'official'")
  }
  if (!mapCols.includes('workshop_id')) {
    db.exec('ALTER TABLE maps ADD COLUMN workshop_id TEXT')
  }
  if (!mapCols.includes('internal_name')) {
    db.exec('ALTER TABLE maps ADD COLUMN internal_name TEXT')
  }
  if (!mapCols.includes('match_types')) {
    db.exec("ALTER TABLE maps ADD COLUMN match_types TEXT NOT NULL DEFAULT '[\"custom\",\"duel\"]'")
  }
  if (!mapCols.includes('local_map')) {
    // 本地自维护社区图(方案②):1 = 该图以本地文件(base maps/<internal>.vpk + 各实例 symlink)部署,
    // 开赛**跳过 host_workshop_map**(不再挂载工坊 addon),改为预检本地文件存在(见 lib/instances.js)
    db.exec('ALTER TABLE maps ADD COLUMN local_map INTEGER NOT NULL DEFAULT 0')
  }

  // 迁移:旧 7 图短 id(mirage)→ 官方名(de_mirage);地图 id 统一为官方名称
  const LEGACY_SHORT_TO_FULL = {
    mirage: 'de_mirage',
    inferno: 'de_inferno',
    nuke: 'de_nuke',
    dust2: 'de_dust2',
    ancient: 'de_ancient',
    anubis: 'de_anubis',
    vertigo: 'de_vertigo',
  }
  const normMapList = (arr) => (Array.isArray(arr) ? arr.map((id) => LEGACY_SHORT_TO_FULL[id] || id) : arr)

  // settings:default_map_pool(短 id)→ active_map_pool(官方名,服役池恒 7 张)
  const activePoolRow = db.prepare("SELECT value FROM settings WHERE key = 'active_map_pool'").get()
  if (!activePoolRow) {
    const legacyPool = db.prepare("SELECT value FROM settings WHERE key = 'default_map_pool'").get()
    let pool
    try {
      pool = legacyPool ? normMapList(JSON.parse(legacyPool.value)) : config.defaultActiveMapPool
    } catch {
      pool = config.defaultActiveMapPool
    }
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('active_map_pool', JSON.stringify(pool), Date.now())
    db.prepare("DELETE FROM settings WHERE key = 'default_map_pool'").run()
  }

  // rooms:map_pool / banned / picked / veto_history 短 id → 官方名
  const roomRows = db.prepare('SELECT id, map_pool, banned, picked, veto_history FROM rooms').all()
  const updRoom = db.prepare('UPDATE rooms SET map_pool = ?, banned = ?, picked = ?, veto_history = ? WHERE id = ?')
  for (const row of roomRows) {
    // 先检查原始值是否含旧短 id(转换后检查恒为 false)
    const hasShort = [row.map_pool, row.banned, row.picked].some((v) => /"mirage"|"inferno"|"nuke"|"dust2"|"ancient"|"anubis"|"vertigo"/.test(v))
    if (!hasShort) continue
    try {
      const mapPool = normMapList(JSON.parse(row.map_pool))
      const banned = normMapList(JSON.parse(row.banned))
      const picked = normMapList(JSON.parse(row.picked))
      const history = JSON.parse(row.veto_history).map((h) => ({ ...h, mapId: LEGACY_SHORT_TO_FULL[h.mapId] || h.mapId }))
      updRoom.run(JSON.stringify(mapPool), JSON.stringify(banned), JSON.stringify(picked), JSON.stringify(history), row.id)
    } catch {}
  }

  // records:maps 短 id → 官方名
  const recRows = db.prepare('SELECT id, maps FROM records').all()
  const updRec = db.prepare('UPDATE records SET maps = ? WHERE id = ?')
  for (const row of recRows) {
    if (!/"mirage"|"inferno"|"nuke"|"dust2"|"ancient"|"anubis"|"vertigo"/.test(row.maps)) continue
    try {
      updRec.run(JSON.stringify(normMapList(JSON.parse(row.maps))), row.id)
    } catch {}
  }

  return db
}

export function getDb() {
  if (!db) throw new Error('db not initialized')
  return db
}

export function now() {
  return Date.now()
}

export function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(0, chars.length)]
  return out
}
