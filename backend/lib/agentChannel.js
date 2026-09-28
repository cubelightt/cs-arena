// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 反向 agent 通道:桥(agent)主动连接后端的 WebSocket(路径 /api/agent)
// 命令:后端 → 桥 cmd;结果/推送:桥 → 后端(result / push)
// - 鉴权:hello 携带 bridge_token,匹配 game_servers.bridge_token
// - 命令:cmdId → Promise,超时兜底;断线失败全部 pending
// - 健康:桥每 5s 推送 health,后端缓存(getHealthCache 带新鲜度)
// - 控制台:console_subscribe/unsubscribe + 桥 tail 推送(output/reset/state),断线重放活跃订阅
// - 保活:后端每 AGENT_PING_MS 发应用层 ping;超过 AGENT_STALE_MS 收不到桥的任何帧
//   (ping 不计,须有 health/result/push)判定为半开连接并主动断开重连
import { WebSocketServer } from 'ws'
import { getDb, now } from '../db.js'
import { cacheInstances, confirmArenaMatchClose } from './instances.js'
import { serverInstanceNames } from './gameServers.js'
import {
  createJob, getJob, updateJob, isTerminal, setMaintenance, clearMaintenanceByJob, listMaintenance,
} from './jobs.js'
import { convergeInstanceJob, convergeInstancesReport } from './provisioning.js'
import config from '../config.js'

const CLIENTS = new Map() // serverId → ws
const PENDING = new Map() // cmdId → { resolve, reject, timer, serverId }
const HEALTH = new Map() // serverId → { instances, at }
const REPORTED = new Map() // serverId → 桥 hello 上报的实例名数组(首次连接种子 / 交叉校验仅警告用)
const CAPABILITIES = new Map() // serverId → 桥声明的能力(v2 增补;旧桥为空 = 按旧桥对待)
const CONSOLE_SUBS = new Map() // serverId → Map(instance → { offset })
const JOB_SUBS = new Map() // serverId → Map(jobId → { offset })(M4:任务日志订阅,断线重放)
const LAST_SEEN = new Map() // serverId → 最近收到桥任何数据帧的时间(半开连接自检)
const OFFLINE_SINCE = new Map() // serverId → 桥断开时刻(平台告警算'离线多久';连上即清)
const ARENA_MATCH_WAITERS = new Map() // `${instance}:${matchId}` → { resolve, reject, timer, sha256 }
const ARENA_MATCH_RECOVERY_IN_FLIGHT = new Set() // serverId; serialize reconnect cleanup per bridge
const ARENA_MATCH_RECOVERY_RETRY_AFTER = new Map() // serverId → next retry time after a cleanup failure
let cmdSeq = 1
let consolePushHandler = null
let jobPushHandler = null

// 保活参数(env 可调,smoke 用小值加速)
const PING_MS = Number(process.env.AGENT_PING_MS || 10000)
const STALE_MS = Number(process.env.AGENT_STALE_MS || 30000)
const MAX_PENDING = Number(process.env.AGENT_MAX_PENDING || 256)

export function setConsolePushHandler(fn) {
  consolePushHandler = fn
}

/** 任务推送/上报的观察者(server.js 注册:中继到 admins socket 频道)。 */
export function setJobPushHandler(fn) {
  jobPushHandler = fn
}

export function getServerByToken(token) {
  return getDb().prepare('SELECT * FROM game_servers WHERE bridge_token = ?').get(token)
}

// 桥 hello 上报的实例名清单(供管理面板/交叉校验展示;null = 未知/离线)
export function getReportedInstances(serverId) {
  return REPORTED.get(serverId) ?? null
}

// 桥声明的能力(空数组 = 旧桥:后端只发旧帧/旧 op)
export function getCapabilities(serverId) {
  return CAPABILITIES.get(serverId) ?? []
}

export function hasCapability(serverId, cap) {
  return getCapabilities(serverId).includes(cap)
}

/**
 * 实例清单上报:主机侧 cs new/del 或每次连上的 reconcile 全量。
 * 新增项登记为待确认，端口差异生成告警；显式删除墓碑用于删除 DB 行。
 * 全量上报中缺少某项不代表已删除。
 */
function handleInstancesReport(serverId, msg) {
  const rows = Array.isArray(msg.instances) ? msg.instances.filter((r) => r && typeof r.name === 'string') : []
  console.log(`[agent] ${serverId} instances_report(origin=${msg.origin || '?'}) ${rows.length} 个实例`)
  // added → 登记/补空缺(「待确认」不参与分配);
  // removed → 主机侧已显式删除(cs del 墓碑)→ 删行。按 name 幂等。
  const { added, removed, updated } = convergeInstancesReport(serverId, rows)
  if (added || removed || updated) {
    console.log(`[agent] ${serverId} 清单对账:新增 ${added} / 移除 ${removed} / 更新 ${updated}`)
  }
  // 缺报只告警(不自动删行):缺报可能只是桥没连上/配置未同步,与"显式删除"不同
  const reported = new Set(rows.filter((r) => (r.action || 'added') !== 'removed').map((r) => r.name))
  const known = new Set(serverInstanceNames(serverId))
  const missing = [...known].filter((n) => !reported.has(n))
  if (missing.length > 0 && msg.origin === 'reconcile') {
    console.warn(`[agent] ${serverId} 平台 DB 有但主机未上报: ${missing.join(', ')}(可能是主机侧已删除,待同步)`)
  }
}

// 后端为实例清单唯一权威:桥上报清单**仅**用于空组首次连接时种子入库
// (端口未知 → 占位 0,管理员经 PUT 补齐;已存在实例的组不覆盖、重连不重复种子)
function seedInstancesFromBridge(serverId, names) {
  const db = getDb()
  const count = db.prepare('SELECT COUNT(*) AS c FROM instances WHERE game_server_id = ?').get(serverId).c
  if (count > 0) return 0
  const insert = db.prepare(
    'INSERT INTO instances (name, port, state, game_server_id, idx, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  let idx = Number(db.prepare('SELECT COALESCE(MAX(idx), 0) AS m FROM instances WHERE game_server_id = ?').get(serverId).m) + 1
  let n = 0
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue
    if (db.prepare('SELECT name FROM instances WHERE name = ?').get(name)) continue
    const ts = now()
    insert.run(name, 0, 'idle', serverId, idx++, 'bridge_report', ts, ts)
    n++
  }
  if (n > 0) {
    cacheInstances()
    console.log(`[agent] ${serverId} 首次连接:按桥上报清单种子 ${n} 个实例(端口占位 0,请经管理面板补齐)`)
  }
  return n
}

// ---- v2 协议增补:能力协商与 hello_ack----
// 只对**声明了能力**的桥发新帧;旧桥(bridge.py)不看 capabilities,故本段对旧桥零影响。

/** 桥声明 config_sync 能力 = 它能收下发的权威清单(hello_ack / config_sync)。 */
const CAP_CONFIG_SYNC = 'config_sync'

/** 桥在 hello 里声明的能力列表(缺省 = 旧桥)。 */
function bridgeCapabilities(msg) {
  return Array.isArray(msg.capabilities) ? msg.capabilities.filter((c) => typeof c === 'string') : []
}

// 清单/元数据版本号:平台改清单/元数据时必须递增(M3 起在 config_sync 触发点调用;
// 当前只有 hello_ack 使用,值只增不减即可满足"单调递增"约定)
let configVersion = 1
export function bumpConfigVersion() {
  configVersion += 1
  return configVersion
}

/** hello_ack 的实例元数据(端口以 DB 为准;GOTV 端口 = 端口 + 100)。 */
function buildInstanceMeta(serverId) {
  const rows = getDb()
    .prepare('SELECT name, port, state, admin_only, idx FROM instances WHERE game_server_id = ? ORDER BY (idx IS NULL), idx, rowid')
    .all(serverId)
  return rows.map((r, i) => ({
    name: r.name,
    port: r.port,
    gotvPort: r.port ? r.port + 100 : 0,
    idx: r.idx ?? i + 1, // 编号以 DB 列为准(M5 起持久化;缺号的行按行序兜底,只为展示)
    adminOnly: !!r.admin_only,
    botCapable: r.name === config.botInstanceName,
    state: r.state,
    matchId: null,
  }))
}

/** 维护态(按组;权威在平台 maintenance 表,M4 起下发)。 */
function buildMaintenance() {
  return listMaintenance().map((m) => ({
    groupId: m.groupId,
    enabled: true,
    reason: m.reason,
    jobId: m.jobId ?? null,
  }))
}

/**
 * 下发权威清单/元数据:桥据此刷新白名单(不重启、不写本地配置文件)。
 * demoDir 不下发 —— 桥用本地 config.yaml 的 demo_dir。
 */
function sendHelloAck(serverId, ws) {
  const msg = {
    type: 'hello_ack',
    serverId,
    instances: serverInstanceNames(serverId),
    instanceMeta: buildInstanceMeta(serverId),
    maintenance: buildMaintenance(),
    configVersion,
  }
  try {
    ws.send(JSON.stringify(msg))
    console.log(`[agent] ${serverId} hello_ack 下发 ${msg.instances.length} 个实例(configVersion ${configVersion})`)
  } catch (e) {
    console.log(`[agent] ${serverId} hello_ack 下发失败: ${e.message}`)
  }
}

function resolveCmd(cmdId, msg) {
  const p = PENDING.get(cmdId)
  if (!p) return
  PENDING.delete(cmdId)
  clearTimeout(p.timer)
  p.resolve({ ok: msg.ok !== false, data: msg.data, raw: msg })
}

function failPending(serverId, reason) {
  for (const [cmdId, p] of PENDING) {
    if (p.serverId === serverId) {
      PENDING.delete(cmdId)
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
  }
}

function failWaiters(serverId, reason) {
  const serverInsts = new Set(serverInstanceNames(serverId))
  for (const [key, w] of ARENA_MATCH_WAITERS) {
    const inst = key.split(':')[0]
    if (serverInsts.has(inst)) {
      ARENA_MATCH_WAITERS.delete(key)
      clearTimeout(w.timer)
      w.reject(new Error(reason))
    }
  }
}

/**
 * 注册并等待 ArenaMatch 插件装载确认结果帧
 */
export function waitForArenaMatchResult(instance, matchId, sha256, timeoutMs = 15000) {
  const key = `${instance}:${matchId}`
  if (ARENA_MATCH_WAITERS.has(key)) {
    const old = ARENA_MATCH_WAITERS.get(key)
    clearTimeout(old.timer)
    old.reject(new Error(`新装载请求替代了先前的等待: ${key}`))
    ARENA_MATCH_WAITERS.delete(key)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ARENA_MATCH_WAITERS.delete(key)
      reject(new Error(`等待 ArenaMatch 装载结果超时 (${timeoutMs}ms; inst=${instance}, matchId=${matchId})`))
    }, timeoutMs)
    timer.unref?.()
    ARENA_MATCH_WAITERS.set(key, { resolve, reject, timer, sha256 })
  })
}

export function cancelArenaMatchResultWait(instance, matchId) {
  const key = `${instance}:${matchId}`
  const waiter = ARENA_MATCH_WAITERS.get(key)
  if (!waiter) return
  ARENA_MATCH_WAITERS.delete(key)
  clearTimeout(waiter.timer)
  waiter.reject(new Error(`ArenaMatch 装载等待已取消: ${key}`))
}

/**
 * 离线/测试桩模拟触发装载结果
 */
export function simulateArenaMatchResult(msg) {
  const { instance, matchId, sha256, resultSeq = 1, ok = true, code = '', reason = '' } = msg
  const key = `${instance}:${matchId}`
  const waiter = ARENA_MATCH_WAITERS.get(key)
  if (waiter) {
    clearTimeout(waiter.timer)
    ARENA_MATCH_WAITERS.delete(key)
    if (waiter.sha256 && waiter.sha256 !== sha256) {
      waiter.reject(new Error(`ArenaMatch 装载 SHA-256 不匹配: 期望 ${waiter.sha256}, 收到 ${sha256}`))
      return false
    }
    if (ok) {
      waiter.resolve({ ok: true, instance, matchId, sha256, resultSeq })
    } else {
      waiter.reject(new Error(`ArenaMatch 插件装载失败: code=${code || 'unknown'}, reason=${reason || 'unknown'}`))
    }
    return true
  }
  return false
}

/**
 * 处理桥上报的 arena_match_result
 */
function handleArenaMatchResult(serverId, ws, msg) {
  const { instance, matchId, sha256, resultSeq, ok, code, reason } = msg
  const id = matchId
  const seq = resultSeq
  if (
    typeof instance !== 'string' || !instance ||
    typeof id !== 'number' || typeof seq !== 'number' ||
    !Number.isSafeInteger(id) || id <= 0 ||
    typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) ||
    !Number.isSafeInteger(seq) || seq <= 0 ||
    typeof ok !== 'boolean' ||
    (code != null && typeof code !== 'string') ||
    (reason != null && typeof reason !== 'string')
  ) {
    console.warn(`[agent] ${serverId} 收到非法 arena_match_result:`, msg)
    return
  }
  if (CLIENTS.get(serverId) !== ws) return

  const db = getDb()
  // instance 的归属以平台 DB 为准，不能信任桥自报的 instance 字段。
  const owner = db.prepare('SELECT game_server_id FROM instances WHERE name = ?').get(instance)
  if (owner?.game_server_id !== serverId) {
    console.warn(`[agent] ${serverId} arena_match_result 实例归属不匹配: ${instance}`)
    return
  }

  const match = db
    .prepare(
      `SELECT instance_name, status, arena_match_sha256, arena_match_result_seq, arena_match_result_json
       FROM matches WHERE id = ?`,
    )
    .get(id)
  if (
    !match || match.instance_name !== instance || match.arena_match_sha256 !== sha256 ||
    !['pending', 'live'].includes(match.status)
  ) {
    console.warn(`[agent] ${serverId} arena_match_result 无匹配的活动绑定(inst=${instance}, matchId=${id})`)
    return
  }

  const key = `${instance}:${id}`
  const waiter = ARENA_MATCH_WAITERS.get(key)
  const normalized = {
    instance,
    matchId: id,
    sha256,
    resultSeq: seq,
    ok,
    code: code || '',
    reason: reason || '',
  }
  const resultJson = JSON.stringify(normalized)
  const previousSeq = Number(match.arena_match_result_seq || 0)
  const duplicate = seq === previousSeq && match.arena_match_result_json === resultJson
  const validWaiter = !!waiter && waiter.sha256 === sha256

  if (seq < previousSeq || (seq === previousSeq && !duplicate)) {
    console.warn(`[agent] ${serverId} arena_match_result 序号冲突/过期(inst=${instance}, matchId=${id}, seq=${seq})`)
    return
  }
  // 新结果只能用于当前进程中仍在等待装载的开赛请求。进程重启后没有 waiter，旧的
  // pending 比赛不会因桥重放而误获 ACK；新序号也不能覆盖已进入 live 的比赛结果。
  if (!duplicate && (!validWaiter || match.status !== 'pending')) {
    console.warn(`[agent] ${serverId} arena_match_result 没有有效的开赛等待器(inst=${instance}, matchId=${id})`)
    return
  }
  if (duplicate && match.status === 'pending' && !validWaiter) {
    console.warn(`[agent] ${serverId} arena_match_result 属于重启后未恢复的比赛(inst=${instance}, matchId=${id})`)
    return
  }
  if (waiter && waiter.sha256 !== sha256) {
    console.warn(`[agent] ${serverId} arena_match_result SHA 与等待器不匹配(inst=${instance}, matchId=${id})`)
    return
  }

  if (!duplicate) {
    const saved = db
      .prepare(
        `UPDATE matches SET arena_match_result_seq = ?, arena_match_result_json = ?
         WHERE id = ? AND instance_name = ? AND arena_match_sha256 = ? AND status = 'pending'
           AND arena_match_result_seq < ?`,
      )
      .run(seq, resultJson, id, instance, sha256, seq)
    if (saved.changes !== 1) return
  }

  const ack = JSON.stringify({ type: 'arena_match_ack', instance, matchId: id, sha256, resultSeq: seq })
  try {
    ws.send(ack, (err) => {
      if (err) {
        console.warn(`[agent] ${serverId} 回复 arena_match_ack 失败:`, err.message)
        return
      }
      // 只有结果已校验、持久化且 ACK 写入 socket 后，才唤醒开赛流程。
      const current = ARENA_MATCH_WAITERS.get(key)
      if (!current || current !== waiter) return
      clearTimeout(current.timer)
      ARENA_MATCH_WAITERS.delete(key)
      if (ok) current.resolve(normalized)
      else current.reject(new Error(`ArenaMatch 插件装载失败: code=${code || 'unknown'}, reason=${reason || 'unknown'}`))
    })
  } catch (err) {
    console.warn(`[agent] ${serverId} 回复 arena_match_ack 失败:`, err.message)
  }
}

/**
 * Retry terminal ArenaMatch bindings after reconnect/heartbeat. Both aborted loads and
 * completed matches keep ownership until the Go bridge confirms close.
 */
async function recoverTerminalArenaMatches(serverId, ws) {
  if (CLIENTS.get(serverId) !== ws || !hasCapability(serverId, 'arena_match_ipc')) return
  if (ARENA_MATCH_RECOVERY_IN_FLIGHT.has(serverId)) return
  if (Date.now() < (ARENA_MATCH_RECOVERY_RETRY_AFTER.get(serverId) || 0)) return
  const db = getDb()
  const matches = db
    .prepare(
      `SELECT m.id, m.instance_name, m.status, i.state
       FROM matches m
       JOIN instances i ON i.name = m.instance_name
       WHERE i.game_server_id = ? AND i.state IN ('booting', 'cooling', 'in_match') AND i.match_id = m.id
         AND m.status IN ('aborted', 'ended') AND (m.arena_match_bind_started = 1 OR m.arena_match_sha256 IS NOT NULL)
         AND (m.arena_match_close_confirmed = 0 OR i.state IN ('booting', 'in_match'))
       ORDER BY m.id`,
    )
    .all(serverId)
  if (matches.length === 0) return

  ARENA_MATCH_RECOVERY_IN_FLIGHT.add(serverId)
  ARENA_MATCH_RECOVERY_RETRY_AFTER.set(serverId, Date.now() + 30000)
  try {
    for (const match of matches) {
      if (CLIENTS.get(serverId) !== ws) break
      if (match.state === 'booting' || (match.state === 'in_match' && match.status === 'aborted')) {
        // 开赛失败或重启中止时，插件可能已进入 warmup；结束命令尽力发送。
        try {
          const ended = await sendAgentCmd(serverId, 'send', {
            instance: match.instance_name,
            payload: { cmd: 'css_endmatch' },
          }, 30000)
          if (!ended.ok) console.warn(`[arena-match] 恢复中止 ${match.id}: css_endmatch 未确认(${match.instance_name})`)
        } catch (err) {
          console.warn(`[arena-match] 恢复中止 ${match.id}: css_endmatch 失败(${match.instance_name}): ${err.message}`)
        }
      }
      if (await confirmArenaMatchClose(match.instance_name, match.id)) {
        console.log(`[arena-match] 终态 ${match.id}: 桥绑定已关闭,实例 ${match.instance_name} 进入录像冷却或已释放`)
      } else {
        console.warn(`[arena-match] 终态 ${match.id}: 关闭桥绑定未确认(${match.instance_name}),继续占锁`)
      }
    }
  } finally {
    ARENA_MATCH_RECOVERY_IN_FLIGHT.delete(serverId)
  }
}

function handlePush(serverId, msg) {
  if (msg.kind === 'health') {
    HEALTH.set(serverId, { instances: msg.instances || {}, at: now() })
    return
  }
  if (msg.kind === 'console' || msg.kind === 'console_reset' || msg.kind === 'console_state') {
    consolePushHandler?.(msg.instance, msg.kind === 'console' ? 'output' : msg.kind === 'console_reset' ? 'reset' : 'state', msg)
    return
  }
  if (msg.kind === 'job') {
    handleJobPush(serverId, msg)
    return
  }
}

/**
 * 任务进度推送:
 * 写 jobs 行(平台侧状态镜像)→ 终态自动清维护 → 交给 admins socket 中继。
 */
function handleJobPush(serverId, msg) {
  const jobId = Number(msg.jobId)
  if (!Number.isFinite(jobId)) return
  const cur = getJob(jobId)
  if (cur) {
    const patch = { status: msg.status ?? cur.status }
    if (msg.step !== undefined) patch.step = msg.step
    if (msg.stepIndex !== undefined) patch.stepIndex = msg.stepIndex
    if (msg.stepTotal !== undefined) patch.stepTotal = msg.stepTotal
    if (msg.progress !== undefined) patch.progress = msg.progress
    if (msg.error !== undefined) patch.error = msg.error
    // 终态帧带 result(建删实例的 port/idx/freedBytes 等)—— 平台据此收敛实例行,免回源 job_status
    if (msg.result !== undefined && msg.result !== null) patch.result = msg.result
    if (isTerminal(patch.status)) patch.finishedAt = now()
    updateJob(jobId, patch)
    if (isTerminal(patch.status)) {
      const cleared = clearMaintenanceByJob(jobId)
      if (cleared > 0) console.log(`[agent] 任务 ${jobId} 终态(${patch.status}),已解除该组维护`)
      convergeInstanceJob(getJob(jobId)) // 建/删实例:终态收敛 instances 行(其他 kind 内部直接返回)
    }
  } else {
    console.warn(`[agent] ${serverId} 收到未知任务 ${jobId} 的推送(平台无该行;CLI 发起的任务应先 job_report)`)
  }
  jobPushHandler?.(serverId, msg)
}

/**
 * 主机侧(CLI/离线)任务上报:
 * 平台登记该任务(origin:'cli')并把该组标维护;终态则解除维护。
 */
function handleJobReport(serverId, msg) {
  const r = msg.job || {}
  const jobId = Number(r.jobId)
  if (!Number.isFinite(jobId) || jobId <= 0) return
  const groupId = r.groupId || serverId
  const status = String(r.status || 'running')
  const exists = getJob(jobId)
  if (!exists) {
    createJob({
      id: jobId,
      kind: r.kind || 'unknown',
      serverId,
      groupId,
      instanceName: r.instance || null, // M5:建删实例任务带实例名(面板任务列表可显示)
      params: r.instance ? { name: r.instance } : {},
      origin: 'cli',
      createdBy: r.cliUser ? `cli:${r.cliUser}` : 'cli',
    })
  }
  const patch = { status }
  if (r.result !== undefined && r.result !== null) patch.result = r.result
  if (r.step !== undefined) patch.step = r.step
  if (r.stepIndex !== undefined) patch.stepIndex = r.stepIndex
  if (r.stepTotal !== undefined) patch.stepTotal = r.stepTotal
  if (r.progress !== undefined) patch.progress = r.progress
  if (r.error) patch.error = r.error
  if (r.startedAt) patch.startedAt = r.startedAt
  if (isTerminal(status)) {
    patch.finishedAt = r.finishedAt || now()
  }
  updateJob(jobId, patch)
  if (isTerminal(status)) {
    clearMaintenanceByJob(jobId)
    convergeInstanceJob(getJob(jobId)) // 主机侧 cs new/cs del 的终态同样收敛实例行
    console.log(`[agent] ${serverId} job_report(job ${jobId} ${r.kind}):${status}`)
  } else {
    setMaintenance(groupId, {
      enabled: true,
      reason: reasonForKind(r.kind, jobId),
      jobId,
      by: r.cliUser ? `cli:${r.cliUser}` : 'cli',
    })
    console.log(`[agent] ${serverId} job_report(job ${jobId} ${r.kind}):${status},该组标为维护中`)
  }
  jobPushHandler?.(serverId, { kind: 'job', jobId, status, step: r.step, stepIndex: r.stepIndex, stepTotal: r.stepTotal, progress: r.progress, origin: 'cli' })
}

function reasonForKind(kind, jobId) {
  const label = {
    game_update: '游戏更新',
    instance_create: '新建实例',
    instance_delete: '删除实例',
    plugin_sync: '插件同步',
    plugin_deploy: '插件部署',
    demo_collect: '录像归集',
    host_cleanup: '主机清理',
  }[kind] || kind || '任务'
  return `${label}进行中(job ${jobId})`
}

function replayJobSubs(serverId, ws) {
  const subs = JOB_SUBS.get(serverId)
  if (!subs || subs.size === 0) return
  for (const [jobId, { offset }] of subs) {
    ws.send(JSON.stringify({ type: 'cmd', cmdId: `j${cmdSeq++}`, op: 'job_subscribe', payload: { jobId, offset } }))
  }
  console.log(`[agent] ${serverId} 重放 ${subs.size} 个任务订阅`)
}

function replayConsoleSubs(serverId, ws) {
  const subs = CONSOLE_SUBS.get(serverId)
  if (!subs || subs.size === 0) return
  for (const [instance, { offset }] of subs) {
    ws.send(JSON.stringify({ type: 'cmd', cmdId: `r${cmdSeq++}`, op: 'console_subscribe', instance, payload: { offset } }))
  }
  console.log(`[agent] ${serverId} 重放 ${subs.size} 个控制台订阅`)
}

export function initAgentChannel(httpServer) {
  // noServer + 手动 upgrade 分流:仅接管 /api/agent,其余(engine.io 等)放行
  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = ''
    try {
      pathname = new URL(req.url, 'http://x').pathname
    } catch {
      return
    }
    if (pathname !== '/api/agent') return
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    let serverId = null
    const helloTimer = setTimeout(() => {
      ws.close(1008, 'hello timeout')
    }, 10000)

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (serverId) LAST_SEEN.set(serverId, now())
      if (serverId) OFFLINE_SINCE.delete(serverId)
      if (msg.type === 'hello') {
        const srv = getServerByToken(String(msg.token || ''))
        if (!srv) {
          ws.close(1008, 'bad token')
          return
        }
        // serverId 参与绑定:必须与 token 对应行一致,防配错
        if (msg.serverId && String(msg.serverId) !== srv.id) {
          ws.close(1008, 'server id mismatch')
          return
        }
        serverId = srv.id
        LAST_SEEN.set(serverId, now())
        OFFLINE_SINCE.delete(serverId)
        clearTimeout(helloTimer)
        const old = CLIENTS.get(serverId)
        if (old && old !== ws) {
          try {
            old.close(1008, 'replaced')
          } catch {}
        }
        CLIENTS.set(serverId, ws)
        // 实例清单上报:仅用于空组首次连接种子 + 交叉校验(警告),后端 DB 始终为唯一权威
        if (Array.isArray(msg.instances)) {
          const names = msg.instances.filter((n) => typeof n === 'string')
          REPORTED.set(serverId, names)
          seedInstancesFromBridge(serverId, names)
        }
        // 能力协商:只对声明了能力的桥发新帧 —— 旧桥(bridge.py)不看 capabilities,
        // 因此这里天然只影响 v2 桥;hello_ack 是 v2 的清单/元数据权威下发帧。
        const caps = bridgeCapabilities(msg)
        CAPABILITIES.set(serverId, caps)
        if (caps.includes(CAP_CONFIG_SYNC)) {
          sendHelloAck(serverId, ws)
        }
        console.log(`[agent] ${serverId} connected`)
        replayConsoleSubs(serverId, ws)
        replayJobSubs(serverId, ws)
        ARENA_MATCH_RECOVERY_RETRY_AFTER.delete(serverId)
        void recoverTerminalArenaMatches(serverId, ws)
        return
      }
      if (!serverId) return
      if (msg.type === 'result') {
        resolveCmd(msg.cmdId, msg)
        return
      }
      if (msg.type === 'arena_match_result') {
        handleArenaMatchResult(serverId, ws, msg)
        return
      }
      if (msg.type === 'push') {
        handlePush(serverId, msg)
      }
      if (msg.type === 'instances_report') {
        handleInstancesReport(serverId, msg)
      }
      if (msg.type === 'job_report') {
        handleJobReport(serverId, msg)
      }
    })

    ws.on('error', (e) => console.log(`[agent] ws error: ${e.message}`))
    ws.on('close', (code, reason) => {
      console.log(`[agent] ws close code=${code} reason=${reason?.toString()}`)
      if (serverId && CLIENTS.get(serverId) === ws) {
        CLIENTS.delete(serverId)
        REPORTED.delete(serverId)
        CAPABILITIES.delete(serverId)
        LAST_SEEN.delete(serverId)
        OFFLINE_SINCE.set(serverId, Date.now())
        JOB_SUBS.delete(serverId)
        failPending(serverId, 'agent 连接断开')
        failWaiters(serverId, 'agent 连接断开')
        console.log(`[agent] ${serverId} disconnected`)
      }
    })
  })

  // 保活:定期 ping + 半开连接自检(链路被静默黑洞时 TCP 不会报错,只靠对端帧判断)
  const hb = setInterval(() => {
    for (const [id, ws] of CLIENTS) {
      if (ws.readyState !== 1) continue
      void recoverTerminalArenaMatches(id, ws)
      const seen = LAST_SEEN.get(id) || 0
      if (now() - seen > STALE_MS) {
        console.warn(`[agent] ${id} 已 ${STALE_MS}ms 无任何数据帧,判定连接失效并断开(将自动重连)`)
        LAST_SEEN.delete(id)
        try {
          ws.terminate()
        } catch {}
        continue
      }
      try {
        ws.send(JSON.stringify({ type: 'ping', at: now() }))
      } catch {}
    }
  }, PING_MS)
  hb.unref?.()

  return wss
}

export function agentConnected(serverId) {
  const ws = CLIENTS.get(serverId)
  return !!ws && ws.readyState === 1
}

// 主动断开某组的桥连接(删除服务器组时调用)
export function disconnectAgent(serverId) {
  const ws = CLIENTS.get(serverId)
  if (ws) {
    CLIENTS.delete(serverId)
    REPORTED.delete(serverId)
    CAPABILITIES.delete(serverId)
    failPending(serverId, 'agent 已下线')
    try {
      ws.close(1000, 'server deleted')
    } catch {}
  }
}

// 各组桥的连接态势:连接态 + 最近收帧时间 + 离线起始时刻(平台告警 lib/alerts.js 用)
export function agentBridgeStatus() {
  const out = {}
  for (const [id, ws] of CLIENTS) {
    out[id] = { connected: !!ws && ws.readyState === 1, lastSeenAt: LAST_SEEN.get(id) ?? null, offlineSince: null }
  }
  for (const [id, ts] of OFFLINE_SINCE) {
    if (!out[id]) out[id] = { connected: false, lastSeenAt: null, offlineSince: ts }
  }
  return out
}

// 各服务器组当前连接状态(供管理面板展示)
export function agentConnectedMap() {
  const out = {}
  for (const [id, ws] of CLIENTS) out[id] = !!ws && ws.readyState === 1
  return out
}

export async function sendAgentCmd(serverId, op, { instance, payload } = {}, timeoutMs) {
  const ws = CLIENTS.get(serverId)
  if (!ws || ws.readyState !== 1) throw new Error(`agent ${serverId} 未连接`)
  // 队列上限:桥单条命令最长可跑 msm timeout(120s),无上限排队会堆积僵尸命令
  if (PENDING.size >= MAX_PENDING) throw new Error(`agent 命令队列已满(${MAX_PENDING} 条),请稍后重试`)
  const cmdId = `c${cmdSeq++}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      PENDING.delete(cmdId)
      reject(new Error(`agent 命令超时: ${op}`))
    }, timeoutMs)
    PENDING.set(cmdId, { resolve, reject, timer, serverId, op })
    ws.send(JSON.stringify({ type: 'cmd', cmdId, op, instance, payload }))
  })
}

export function getHealthCache(serverId, maxAgeMs = 1500) {
  const h = HEALTH.get(serverId)
  if (h && now() - h.at < maxAgeMs) return h.instances
  return null
}

export async function subscribeAgentConsole(serverId, instance, offset) {
  if (!CONSOLE_SUBS.has(serverId)) CONSOLE_SUBS.set(serverId, new Map())
  CONSOLE_SUBS.get(serverId).set(instance, { offset: offset ?? 0 })
  return sendAgentCmd(serverId, 'console_subscribe', { instance, payload: { offset: offset ?? 0 } }, 15000)
}

export async function unsubscribeAgentConsole(serverId, instance) {
  CONSOLE_SUBS.get(serverId)?.delete(instance)
  return sendAgentCmd(serverId, 'console_unsubscribe', { instance }, 15000)
}

// ---- 任务订阅(M4;与控制台订阅同款:断线重放,offset 续推)------------------

export async function subscribeAgentJob(serverId, jobId, offset) {
  if (!JOB_SUBS.has(serverId)) JOB_SUBS.set(serverId, new Map())
  JOB_SUBS.get(serverId).set(Number(jobId), { offset: offset ?? 0 })
  return sendAgentCmd(serverId, 'job_subscribe', { payload: { jobId: Number(jobId), offset: offset ?? 0 } }, 15000)
}

export async function unsubscribeAgentJob(serverId, jobId) {
  JOB_SUBS.get(serverId)?.delete(Number(jobId))
  return sendAgentCmd(serverId, 'job_unsubscribe', { payload: { jobId: Number(jobId) } }, 15000)
}

export function subscribedJobs(serverId) {
  return [...(JOB_SUBS.get(serverId)?.keys() ?? [])]
}
