// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 与 MatchZy 主机上的桥接 agent(bridge.py)通信
// 传输只有一种:reverse —— 桥主动连后端 WebSocket(/api/agent),走 lib/agentChannel 通道,
// 主机不开放任何入站端口;mode = 'stub' 时用本地脚本(scripts/msm-stub.sh)模拟 msm,便于无主机环境全链路验证。
// 历史 http 模式(后端主动连桥 /v1/*)已移除;mode 仅接受 stub / reverse,其余值在启动时即报错(见 config.js)。
// 服务器组记录(game_servers)只在 reverse 下用于定位归属/令牌,桥地址字段已不参与传输。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import config from '../config.js'
import { instanceServer, allInstanceNames, listGameServers, serverInstanceNames } from './gameServers.js'
import { getDb } from '../db.js'
import { sendAgentCmd, getHealthCache } from './agentChannel.js'
import { maxPlayersEnv } from './roomlimits.js'

const execFileP = promisify(execFile)

const REVERSE_OP_TIMEOUTS = {
  status: 10000,
  start: 150000,
  stop: 60000,
  restart: 150000,
  send: 30000,
  console: 30000,
  matchfile: 30000,
  log: 20000,
  probe: 30000,
  locate: 40000,
  ps: 20000,
  health: 15000,
  workshop_status: 20000,
  mapfile_status: 15000,
  matchcleanup: 30000,
  // v2 增补:主机级只读盘点
  host_status: 30000,
  instances_list: 15000,
  // v2 增补:job 框架与按组批量启停
  job_start: 20000,
  job_status: 15000,
  job_log: 20000,
  job_cancel: 20000,
  job_subscribe: 15000,
  job_unsubscribe: 15000,
  start_all: 150000,
  stop_all: 150000,
  restart_all: 150000,
  // ArenaMatch 独立开赛与绑定
  arena_match_bind: 30000,
  arena_match_close: 15000,
}

function serverIdOf(instance) {
  const srv = instanceServer(instance)
  if (!srv) throw new Error(`实例 ${instance} 无归属服务器`)
  return srv.id
}

function parseState(stdout) {
  const text = stdout || ''
  if (/BOOTING/i.test(text)) return 'BOOTING'
  if (/RUNNING/i.test(text)) return 'RUNNING'
  if (/STOPPED/i.test(text)) return 'STOPPED'
  if (/UNKNOWN/i.test(text) || /not.?found/i.test(text)) return 'UNKNOWN'
  return 'STOPPED'
}

async function viaStub(instance, op, cmd, env) {
  const args = [`@${instance}`, op]
  if (cmd) args.push(cmd)
  const { stdout, stderr } = await execFileP(config.msm.stubPath, args, {
    timeout: 60000,
    // 与真实 msm 一致:启动项覆盖走环境变量(MAXPLAYERS=… cs2-server @inst start)
    env: { ...process.env, ...(env || {}) },
  })
  return { ok: true, stdout, stderr: stderr || '' }
}

export async function rawCommandPublic(instance, op, cmd, env) {
  if (config.bridge.mode === 'reverse') {
    // 校验前移:实例归属 + send 前缀白名单
    // (主机桥只做单行/长度与实例白名单校验,前缀白名单的唯一执行点在后台 config.bridge.sendPrefixes)
    const serverId = serverIdOf(instance)
    if (op === 'send') {
      const first = String(cmd || '').split(/\s+/)[0]
      if (!config.bridge.sendPrefixes.includes(first)) {
        throw new Error(`command prefix not allowed: ${first}`)
      }
    }
    const r = await sendAgentCmd(
      serverId,
      op,
      { instance, payload: op === 'send' ? { cmd } : env ? { env } : undefined },
      REVERSE_OP_TIMEOUTS[op] ?? config.bridge.timeoutMs,
    )
    const d = r.data || {}
    // 桥按 msm returncode 报 ok:失败不再被静默吞掉(旧行为:回包 ok 恒为真)
    // status 除外 —— 实例未运行时 msm 可能非 0 退出,状态由 data.state 表达
    if (!r.ok && op !== 'status') {
      console.warn(`[bridge] ${instance} ${op} 失败: ${d.error || d.stderr || 'unknown'}`)
    }
    return {
      ok: r.ok,
      stdout: d.stdout || '',
      stderr: d.stderr || '',
      returncode: d.returncode,
      state: d.state,
      error: d.error,
      raw: r,
    }
  }
  if (config.bridge.mode !== 'stub') {
    throw new Error(`不支持的桥模式 ${config.bridge.mode}(仅 stub / reverse)`)
  }
  return viaStub(instance, op, cmd, env)
}

async function rawCommand(instance, op, cmd, env) {
  return rawCommandPublic(instance, op, cmd, env)
}

// 返回实例状态:RUNNING / STOPPED / BOOTING / UNKNOWN
/**
 * 主机级 op(无实例参数):host_status / instances_list 等 v2 增补。
 * 只有声明了对应能力的桥才可用 —— 调用方负责先查能力(见 lib/hostinfo.js)。
 */
export async function hostOp(serverId, op, payload, timeoutMs) {
  if (config.bridge.mode === 'stub') {
    // stub 模式:读 <ARENA_STUB_DIR>/host-status.json 夹具(前端无需真机即可联调);
    // 没有夹具时给一份可用的合成数据(实例来自 DB,版本/磁盘给稳定假值)。
    return stubHostStatus(op, serverId)
  }
  const r = await sendAgentCmd(serverId, op, { payload }, timeoutMs ?? REVERSE_OP_TIMEOUTS[op] ?? config.bridge.timeoutMs)
  const d = r.data || {}
  if (!r.ok) throw new Error(d.error || `${op} 失败`)
  return d
}

export async function hostStatus(serverId, refresh = false) {
  return hostOp(serverId, 'host_status', refresh ? { refresh: true } : {}, REVERSE_OP_TIMEOUTS.host_status)
}

// ---- 任务框架-----------------------------------------

/** 任务级 op(主机级,无实例参数)。只有声明 jobs 能力的 v2 桥可用。 */
export async function jobOp(serverId, op, payload = {}, timeoutMs) {
  if (config.bridge.mode === 'stub') {
    return stubJobOp(serverId, op, payload)
  }
  const r = await sendAgentCmd(serverId, op, { payload }, timeoutMs ?? REVERSE_OP_TIMEOUTS[op] ?? config.bridge.timeoutMs)
  const d = r.data || {}
  if (!r.ok) throw new Error(d.error || `${op} 失败`)
  return d
}

export const jobStart = (serverId, kind, params, { confirm, jobId } = {}) =>
  jobOp(serverId, 'job_start', { kind, params: params || {}, confirm, jobId }, REVERSE_OP_TIMEOUTS.job_start)
export const jobStatus = (serverId, jobId) => jobOp(serverId, 'job_status', { jobId }, REVERSE_OP_TIMEOUTS.job_status)
export const jobLog = (serverId, jobId, { offset, lines } = {}) =>
  jobOp(serverId, 'job_log', { jobId, offset, lines }, REVERSE_OP_TIMEOUTS.job_log)
export const jobCancel = (serverId, jobId, force = false) => jobOp(serverId, 'job_cancel', { jobId, force }, REVERSE_OP_TIMEOUTS.job_cancel)
export const startAll = (serverId, group) => jobOp(serverId, 'start_all', { group }, REVERSE_OP_TIMEOUTS.start_all)
export const stopAll = (serverId, group) => jobOp(serverId, 'stop_all', { group }, REVERSE_OP_TIMEOUTS.stop_all)
export const restartAll = (serverId, group) => jobOp(serverId, 'restart_all', { group }, REVERSE_OP_TIMEOUTS.restart_all)

/**
 * stub 模式的任务 op 兼容:进程内假任务 + <STUB_DIR>/jobs/<id>.log 节拍推进,
 * 让面板/前端无需真机即可联调任务 UI。stub 只支持 game_update(够覆盖 UI 状态机)。
 */
const STUB_JOBS = new Map()
let stubJobSeq = 1
// stub 假任务的步骤表与终态结果(按 kind;M5 起支持建删实例,让面板无需真机即可联调这两种任务)
const STUB_PLANS = {
  game_update: {
    steps: ['前置检查(磁盘余量/msm 可执行)', '停止全部实例', '备份关键产物', 'msm update(steamcmd)', '启动全部实例', '回读状态与版本', '提示复测主机侧补丁'],
    result: () => ({ build: '2000908' }),
  },
  instance_create: {
    steps: ['前置检查(磁盘/msm/来源/端口)', 'msm clone', '清理 SwiftlyS2 残留', '拷贝插件树(纯拷贝,无 rsync)', '共享 steamapps(工坊图零拷贝)', '回读端口 + 写注册表', '完成提示'],
    // 与真桥一致:端口回读平台下发的 params.port(缺省 = msm 自动分配的示例值),GOTV 跟随 +100
    result: (payload) => {
      const port = Number(payload.params?.port) > 0 ? Number(payload.params.port) : 27119
      return { name: payload.params?.name, idx: 5, port, gotvPort: port + 100 }
    },
  },
  instance_delete: {
    steps: ['前置检查 + 停实例', '删除实例目录与配置目录', '注册表移除条目', '完成提示'],
    result: (payload) => ({ name: payload.params?.name, freedBytes: 3145728, removed: [] }),
  },
  // 录像归集 / 主机清理的面板入口(步骤与结果键按真桥 kinds_files.go 同形,面板据此联调)
  demo_collect: {
    steps: ['归集对局录像'],
    result: (payload) => ({
      moved: payload.params?.dryRun
        ? []
        : [{
            from: '/home/example/msm.d/cs2/inst-main/game/csgo/MatchZy/match-94.dem',
            to: '/home/example/arena-data/demos/main/2026-09-21/match-94.dem',
            bytes: 52428800,
          }],
      skipped: 0,
      freedFromInstanceBytes: payload.params?.dryRun ? 0 : 52428800,
      dryRun: !!payload.params?.dryRun,
    }),
  },
  host_cleanup: {
    steps: ['清理(白名单模式)'],
    result: (payload) => {
      const patterns = Array.isArray(payload.params?.patterns) ? payload.params.patterns : ['backup:old']
      const items = patterns.map((pattern) => ({
        pattern,
        path: `/home/example/backup/old-${pattern.replace(':', '-')}-20260827-201018`,
        bytes: 6688337,
        files: 4,
      }))
      return { items, totalBytes: items.reduce((n, it) => n + it.bytes, 0), dryRun: payload.params?.dryRun !== false }
    },
  },
}
const STUB_STEPS = STUB_PLANS.game_update.steps

async function stubJobOp(serverId, op, payload) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = process.env.ARENA_STUB_DIR || '/tmp/arena-stub'
  const jobsDir = path.join(dir, 'jobs')
  const tick = Number(process.env.STUB_UPDATE_MS || 400)

  if (op === 'job_start') {
    const plan = STUB_PLANS[payload.kind] || STUB_PLANS.game_update
    const steps = plan.steps
    // 平台下发的 jobId 优先(真桥回包同款):否则库里的历史任务会让假任务自增号错位
    // → 面板任务条停在 0%、取消无效。自增号随之跳过已用号。
    const wantId = Number(payload.jobId) || 0
    const id = wantId > 0 ? wantId : stubJobSeq++
    if (wantId >= stubJobSeq) stubJobSeq = wantId + 1
    // 失败模式(联调用):实例名以 fail 开头 → 在 `msm clone` 步失败(桥侧回滚半成品,同款终态),
    // 让面板/前端无需真机就能联调「创建失败 + 预留行撤回 + 幽灵行清理」这条路径
    const failAt = String(payload.params?.name || '').startsWith('fail') ? 2 : 0
    const job = {
      jobId: id, kind: payload.kind, groupId: serverId, status: 'running',
      step: steps[0], stepIndex: 1, stepTotal: steps.length, progress: 0,
      startedAt: Date.now(), finishedAt: 0, error: '', origin: 'panel',
      result: null,
    }
    STUB_JOBS.set(id, job)
    fs.mkdirSync(jobsDir, { recursive: true })
    const logPath = path.join(jobsDir, `${id}.log`)
    fs.writeFileSync(logPath, `[cs] 任务 ${id}(${payload.kind})开始(组 ${serverId})
`)
    const timer = setInterval(() => {
      const cur = STUB_JOBS.get(id)
      if (!cur || cur.status !== 'running') return clearInterval(timer)
      cur.stepIndex += 1
      if (failAt && cur.stepIndex >= failAt) {
        cur.status = 'failed'
        cur.error = 'stub: msm clone 失败(半成品已回滚,可重试)'
        cur.finishedAt = Date.now()
        fs.appendFileSync(logPath, `[cs] 任务失败:msm clone 失败(半成品已回滚)\n`)
        clearInterval(timer)
        return
      }
      if (cur.stepIndex > cur.stepTotal) {
        cur.status = 'done'
        cur.progress = 100
        cur.finishedAt = Date.now()
        cur.result = plan.result(payload)
        fs.appendFileSync(logPath, `[cs] 任务结束:done(${JSON.stringify(cur.result)})
`)
        clearInterval(timer)
        return
      }
      cur.step = steps[cur.stepIndex - 1]
      cur.progress = Math.round(((cur.stepIndex - 1) / cur.stepTotal) * 100)
      fs.appendFileSync(logPath, `${cur.step} | stub 第 ${cur.stepIndex} 步
`)
    }, tick)
    timer.unref?.()
    return { ok: true, jobId: id, kind: payload.kind, status: 'running' }
  }
  if (op === 'job_status') {
    const job = STUB_JOBS.get(Number(payload.jobId))
    if (!job) throw new Error(`任务不存在(job ${payload.jobId})`)
    return { ok: true, job: { ...job } }
  }
  if (op === 'job_log') {
    const id = Number(payload.jobId)
    if (!STUB_JOBS.has(id)) throw new Error(`任务不存在(job ${id})`)
    const logPath = path.join(jobsDir, `${id}.log`)
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
    const all = text.split('\n').filter(Boolean)
    return { ok: true, jobId: id, lines: all.slice(-200), size: Buffer.byteLength(text) }
  }
  if (op === 'job_cancel') {
    const job = STUB_JOBS.get(Number(payload.jobId))
    if (!job) throw new Error(`任务不存在(job ${payload.jobId})`)
    if (job.status !== 'running') throw new Error(`任务已结束(job ${job.jobId},${job.status})`)
    job.status = payload.force ? 'cancelled' : 'cancelling'
    job.finishedAt = Date.now()
    if (payload.force) job.error = '强制取消:游戏目录可能处于半更新状态,请随后执行 cs update 或 msm validate'
    return { ok: true, jobId: job.jobId, status: job.status }
  }
  if (op === 'job_subscribe' || op === 'job_unsubscribe') {
    return { ok: true, jobId: Number(payload.jobId) }
  }
  if (op === 'start_all' || op === 'stop_all' || op === 'restart_all') {
    const names = serverInstanceNames(serverId)
    return { ok: true, results: names.map((n) => ({ name: n, ok: true })) }
  }
  throw new Error(`stub 不支持的任务 op: ${op}`)
}

export async function instanceStatus(instance) {
  const r = await rawCommand(instance, 'status')
  // 桥显式解析的状态优先(reverse);stub 模式无该字段 → 回退解析 msm stdout
  if (r.state) return r.state
  // 桥/msm 明确失败且拿不到状态:抛错(旧行为是当成 STOPPED,把故障误报成"实例未运行")
  if (r.ok === false) throw new Error(`bridge status 失败: ${r.error || r.stderr || 'unknown'}`)
  return parseState(r.stdout || '')
}

// 一次获取某台服务器(agent)下全部实例状态:{ name: RUNNING/STOPPED/... }
// reverse:桥上报(health 推送缓存优先);stub:遍历 DB 实例逐个查
export async function bridgeHealth(server) {
  if (config.bridge.mode === 'reverse') {
    const id = server?.id
    if (!id) throw new Error('缺少 server.id')
    const cached = getHealthCache(id, 1500)
    if (cached) return { instances: cached }
    const r = await sendAgentCmd(id, 'health', {}, REVERSE_OP_TIMEOUTS.health)
    return { instances: r.data?.instances || {} }
  }
  const out = {}
  for (const name of allInstanceNames()) {
    out[name] = await instanceStatus(name)
  }
  return { instances: out }
}

// 等待实例进入 RUNNING;系统绝不启动实例(STOPPED 只能由管理员手动唤醒)
// maxPlayers:本次启动的房间级 -maxplayers(经 env MAXPLAYERS 覆盖 MSM preset 弱默认)
export async function startAndWait(instance, { pollMs, timeoutMs, maxPlayers } = {}) {
  pollMs = pollMs ?? config.bootPollMs
  timeoutMs = timeoutMs ?? config.bootTimeoutMs
  const startedAt = Date.now()
  const env = maxPlayers != null ? maxPlayersEnv(maxPlayers) : undefined

  const cur = await instanceStatus(instance)
  if (cur !== 'RUNNING') {
    throw new Error(`实例 @${instance} 未运行,系统不会自动启动(请联系管理员启动)`)
  }
  if (config.restartIfRunning !== false) {
    // 已有实例在跑:重启以保证 MatchZy 未 setup 的干净状态;
    // 重启与 start 走同一条 MSM 启动路径,同样吃 MAXPLAYERS 覆盖(实机验证)
    await rawCommand(instance, 'restart', undefined, env)
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = await instanceStatus(instance)
    if (st === 'RUNNING') return
    if (st === 'UNKNOWN') {
      throw new Error(`实例 @${instance} 状态异常(maybe not found in msm)`)
    }
    if (st === 'STOPPED' && Date.now() - startedAt > 10000) {
      throw new Error(`实例 @${instance} 重启后退出(进程停止),请检查主机`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(`实例 @${instance} 未在 ${timeoutMs}ms 内进入 RUNNING`)
}

// 向运行中实例的控制台发送命令(msm send 通道)
// 注意:返回值里的 ok 反映桥/msm 是否成功(桥按 returncode 判定),调用方可据此判断是否真的送达;
// 失败时这里只记日志、不抛错 —— 保持既有调用链语义(startMatch 等按后续事件/超时判定)
export async function sendCommand(instance, cmd) {
  const r = await rawCommand(instance, 'send', cmd)
  return r
}

export async function stopInstance(instance) {
  return rawCommand(instance, 'stop')
}

// 管理控制台:向实例执行任意单行控制台命令(不走 send 前缀白名单)
export async function bridgeConsole(instance, command) {
  if (config.bridge.mode === 'reverse') {
    if (command.includes('\n') || command.includes('\r')) throw new Error('命令必须为单行')
    if (command.length > config.consoleCommandMaxLen) throw new Error(`命令过长(上限 ${config.consoleCommandMaxLen} 字符)`)
    return reverseCmd(serverIdOf(instance), 'console', { instance, command: command.trim() }, 'console')
  }
  // stub 模式:经 stub send 通道执行(记录到 stub 日志)
  const r = await viaStub(instance, 'send', command)
  return { status: 200, data: { ok: true, ...r } }
}

// ---- 诊断 ----

// reverse 模式下统一命令回传格式({status, data})
async function reverseCmd(serverId, op, payload, timeoutKey) {
  const r = await sendAgentCmd(serverId, op, { payload }, REVERSE_OP_TIMEOUTS[timeoutKey] ?? config.bridge.timeoutMs)
  return { status: 200, data: { ok: r.ok, ...(r.data || {}) } }
}

// 从 MatchZy 主机直连探测 URL(验证游戏服→后端可达性);server 缺省取第一个活跃组
export async function bridgeProbe(url, server) {
  if (config.bridge.mode === 'reverse') {
    const id = server?.id || listActiveServerId()
    if (!id) throw new Error('无可用 agent')
    return reverseCmd(id, 'probe', { url }, 'probe')
  }
  // stub 模式:本地直连即可
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const text = await r.text().catch(() => '')
    return { status: 200, data: { http_code: r.status, ok_body: text.slice(0, 200), error: null } }
  } catch (err) {
    return { status: 200, data: { http_code: null, ok_body: null, error: err.message } }
  }
}

function listActiveServerId() {
  // 诊断类端点(probe/locate/ps)不带实例名:取第一个活跃服务器组
  return listGameServers({ activeOnly: true })[0]?.id || null
}

// 读取实例控制台日志尾段(定位 loadmatch 失败原因)
export async function bridgeLog(instance, lines = 100) {
  if (config.bridge.mode === 'reverse') {
    return reverseCmd(serverIdOf(instance), 'log', { instance, lines: Number(lines) || 100 }, 'log')
  }
  return bridgeGetStub(`/v1/log?instance=${encodeURIComponent(instance)}&lines=${Number(lines) || 100}`, 'stub-log')
}

// 增量读取实例控制台日志(带字节偏移,管理面板实时流用)
export async function bridgeLogWithOffset(instance, offset = 0) {
  if (config.bridge.mode === 'reverse') {
    return reverseCmd(serverIdOf(instance), 'log', { instance, offset: Number(offset) || 0 }, 'log')
  }
  return bridgeGetStub(`/v1/log?instance=${encodeURIComponent(instance)}&offset=${Number(offset) || 0}`, 'stub-log-offset')
}

// 主机侧诊断:搜索日志文件 / 列出 CS2 进程
export async function bridgeLocate() {
  if (config.bridge.mode === 'reverse') {
    const id = listActiveServerId()
    if (!id) throw new Error('无可用 agent')
    return reverseCmd(id, 'locate', {}, 'locate')
  }
  return bridgeGetStub('', 'stub-locate') // stub 模式无真实端点,直接读 stub 目录
}

export async function bridgePs() {
  if (config.bridge.mode === 'reverse') {
    const id = listActiveServerId()
    if (!id) throw new Error('无可用 agent')
    return reverseCmd(id, 'ps', {}, 'ps')
  }
  return bridgeGetStub('', 'stub-ps')
}

// 查询实例所在主机的 workshop 社区地图共享目录(文件系统真源,见 bridge.py workshop_status op)
// 返回 { status, data: { ok, instance, dir, items: { '<id>': { size, mtime } } } }
// 目录不存在(模板未命中/一台主机还没下载过任何图)→ items 为空表,不是错误
export async function bridgeWorkshopStatus(instance) {
  if (config.bridge.mode === 'reverse') {
    return reverseCmd(serverIdOf(instance), 'workshop_status', { instance }, 'workshop_status')
  }
  // stub 模式:读 ARENA_STUB_DIR/workshop/content/730(与 reverse 模式 bridge.py 的 stub 路径一致)
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = path.join(process.env.ARENA_STUB_DIR || '/tmp/arena-stub', 'workshop', 'content', '730')
  const items = {}
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d{6,20}$/.test(name)) continue
      const p = path.join(dir, name)
      if (!fs.statSync(p).isDirectory()) continue
      let total = 0
      let mtime = 0
      const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f)
          const st = fs.statSync(fp)
          if (st.isDirectory()) walk(fp)
          else {
            total += st.size
            mtime = Math.max(mtime, Math.floor(st.mtimeMs / 1000))
          }
        }
      }
      walk(p)
      items[name] = { size: total, mtime }
    }
  }
  return { status: 200, data: { ok: true, instance, dir: fs.existsSync(dir) ? dir : null, items } }
}

// 检查实例本地地图文件 maps/<filename> 是否存在(本地自维护社区图预检,见 bridge.py mapfile_status op)
// 返回 { status, data: { ok, present, path, size } }
export async function bridgeMapFileStatus(instance, filename) {
  if (config.bridge.mode === 'reverse') {
    return reverseCmd(serverIdOf(instance), 'mapfile_status', { instance, filename }, 'mapfile_status')
  }
  // stub 模式:检查 <ARENA_STUB_DIR>/maps/<filename>
  const fs = await import('node:fs')
  const path = await import('node:path')
  const p = path.join(process.env.ARENA_STUB_DIR || '/tmp/arena-stub', 'maps', filename)
  const present = fs.existsSync(p) && fs.statSync(p).isFile()
  return { status: 200, data: { ok: true, instance, filename, present, path: p, size: present ? fs.statSync(p).size : 0 } }
}

// 比赛结束后的实例侧清理:删该场次的 MatchZy 中间产物(回合备份 JSON / 回合恢复残留 / 强制名 ini /
// 引擎回合备份),并把**平台比赛 JSON 归档到实例目录之外**(<archive_dir>/matchjson/<instance>/,不删除)。
// 对局录像(.dem)不在清理范围(保留,去向待定)。
// 失败不抛给调用方业务流:调用点统一 .catch 记日志(清理失败只影响磁盘整洁,不影响比赛状态)
export async function matchCleanup(instance, { matchId, all = false, keepMatchIds } = {}) {
  if (config.bridge.mode === 'reverse') {
    return reverseCmd(serverIdOf(instance), 'matchcleanup', { instance, matchId, all, keepMatchIds }, 'matchcleanup')
  }
  // stub 模式:由 scripts/msm-stub.sh 在 stub 目录内模拟(供 smoke 断言)
  const r = await viaStub(instance, 'matchcleanup', all ? 'all' : String(matchId ?? ''))
  return { status: 200, data: { ok: true, ...r } }
}

// 把比赛 JSON 写入实例的 csgo/ 目录(供 matchzy_loadmatch 读取,避免 tmux 吞 URL)
export async function bridgeWriteMatchFile(instance, filename, payload) {
  if (config.bridge.mode === 'reverse') {
    return reverseCmd(serverIdOf(instance), 'matchfile', { instance, filename, json: payload }, 'matchfile')
  }
  // stub 模式:写入 stub 目录,由 msm-stub.sh 模拟读取
  const fs = await import('node:fs')
  const dir = process.env.ARENA_STUB_DIR || '/tmp/arena-stub'
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${dir}/${filename}`, JSON.stringify(payload))
  return { status: 200, data: { ok: true, path: `${dir}/${filename}` } }
}

// 把文本 cfg 写入实例 cfg/ 目录(桥 matchfile op 的 subdir+text 扩展,见 bridge.py 2026-08-28 补丁)
// 用途:增强人机就位 cfg 固化(挂 MatchZy warmup/live cfg 链),全程不经控制台通道
export async function bridgeWriteCfg(instance, filename, text) {
  if (config.bridge.mode === 'reverse') {
    return reverseCmd(serverIdOf(instance), 'matchfile', { instance, filename, subdir: 'cfg', text }, 'matchfile')
  }
  // stub 模式:写 STUB_DIR/cfg/(smoke 断言用)
  const fs = await import('node:fs')
  const dir = process.env.ARENA_STUB_DIR || '/tmp/arena-stub'
  fs.mkdirSync(`${dir}/cfg`, { recursive: true })
  fs.writeFileSync(`${dir}/cfg/${filename}`, text)
  return { status: 200, data: { ok: true, path: `${dir}/cfg/${filename}` } }
}

// 向桥下发 arena_match_bind 绑定比赛并获取 SHA-256
export async function bridgeArenaMatchBind(instance, matchId, payload) {
  if (config.bridge.mode === 'reverse') {
    return reverseCmd(serverIdOf(instance), 'arena_match_bind', { instance, matchId: Number(matchId), json: payload }, 'arena_match_bind')
  }
  // stub 模式:写 STUB_DIR/.arena-match/match_<id>.json 并计算 sha256
  const fs = await import('node:fs')
  const crypto = await import('node:crypto')
  const dir = `${process.env.ARENA_STUB_DIR || '/tmp/arena-stub'}/.arena-match`
  fs.mkdirSync(dir, { recursive: true })
  const cleanJson = JSON.stringify(payload)
  fs.writeFileSync(`${dir}/match_${matchId}.json`, cleanJson)
  const sha256 = crypto.createHash('sha256').update(cleanJson).digest('hex')
  return { status: 200, data: { ok: true, instance, matchId: Number(matchId), sha256, status: 'bound' } }
}

// 向桥下发 arena_match_close 结束比赛绑定
export async function bridgeArenaMatchClose(instance, matchId) {
  if (config.bridge.mode === 'reverse') {
    const r = await sendAgentCmd(serverIdOf(instance), 'arena_match_close', {
      payload: { instance, matchId: Number(matchId) },
    }, REVERSE_OP_TIMEOUTS.arena_match_close)
    // 实例回收必须同时确认 WS 命令执行成功和桥业务层完成关闭。
    return { status: r.ok && r.data?.ok === true ? 200 : 502, data: { ...r.data, ok: r.ok && r.data?.ok === true } }
  }
  return { status: 200, data: { ok: true, instance, matchId: Number(matchId), status: 'closed' } }
}

// stub 模式的日志/诊断读取(读 ARENA_STUB_DIR 下的模拟文件;reverse 由桥返回)
async function bridgeGetStub(path, stubMode) {
  const fs = await import('node:fs')
  const dir = process.env.ARENA_STUB_DIR || '/tmp/arena-stub'
  const q = new URLSearchParams((path.split('?')[1] || '').replace(/^\/v1\/log\?/, ''))
  const inst = q.get('instance') || ''
  if (stubMode === 'stub-log' || stubMode === 'stub-log-offset') {
    const p = `${dir}/${inst}.log`
    if (!fs.existsSync(p)) return { status: 404, data: { error: 'log not found' } }
    if (stubMode === 'stub-log-offset') {
      const buf = fs.readFileSync(p, 'utf8')
      const offset = Number(q.get('offset') || 0)
      const rest = buf.slice(offset)
      const lines = rest.split('\n')
      const complete = buf.endsWith('\n') ? lines : lines.slice(0, -1)
      return {
        status: 200,
        data: { instance: inst, path: p, offset: buf.length, lines: complete.filter((l) => l !== '') },
      }
    }
    const all = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    return { status: 200, data: { instance: inst, path: p, lines: all.slice(-100) } }
  }
  if (stubMode === 'stub-locate') {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => ({ path: `${dir}/${f}`, size: 0, mtime: 0 })) : []
    return { status: 200, data: { count: files.length, files } }
  }
  return { status: 200, data: { processes: [] } }
}

/**
 * stub 模式的 host_status:优先读 <ARENA_STUB_DIR>/host-status.json 夹具(可整份或部分覆盖),
 * 否则按 DB 实例合成一份 —— 目的是让**前端无需真机即可联调**(真机数据只在 reverse 模式出现)。
 * 合成数据**只含 serverId 这一组的实例**(多组时面板每张卡各显示本组,不会串)——
 * 注意夹具若自带 `instances`,则整份覆盖、对所有组生效(前端自造场景时自行把握)。
 */
async function stubHostStatus(op, serverId) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = process.env.ARENA_STUB_DIR || '/tmp/arena-stub'
  const fixture = path.join(dir, 'host-status.json')

  let base = null
  if (fs.existsSync(fixture)) {
    try {
      base = JSON.parse(fs.readFileSync(fixture, 'utf8'))
    } catch (e) {
      throw new Error(`host-status.json 夹具解析失败: ${e.message}`)
    }
  }

  const instances = []
  const groups = listGameServers().filter((g) => !serverId || g.id === serverId)
  for (const g of groups) {
    for (const [i, name] of serverInstanceNames(g.id).entries()) {
      const row = getDb().prepare('SELECT port, state, match_id FROM instances WHERE name = ?').get(name) || {}
      const logPath = path.join(dir, `${name}.log`)
      let running = false
      try {
        running = fs.readFileSync(path.join(dir, `${name}.state`), 'utf8').trim() === 'RUNNING'
      } catch {}
      instances.push({
        name,
        idx: i + 1,
        port: row.port || 0,
        gotvPort: row.port ? row.port + 100 : 0,
        process: { running, pid: running ? 1000 + i : 0, uptimeSec: running ? 3600 : 0, tmuxSession: `cs2@${name}` },
        health: running ? 'RUNNING' : 'STOPPED',
        logPath,
        logBytes: fs.existsSync(logPath) ? fs.statSync(logPath).size : 0,
        addonsBytes: 0,
        demBytes: 0,
        platformState: row.state || 'idle',
        matchId: row.match_id ?? null,
      })
    }
  }

  const synthesized = {
    ok: true,
    host: { name: 'stub-host', ip: '127.0.0.1', agentVersion: 'stub', capabilities: ['config_sync', 'host_status', 'instances_report'] },
    disk: { totalBytes: 100 * 1024 ** 3, freeBytes: 42 * 1024 ** 3, usedPct: 58, warn: false, minFreeBytes: 15 * 1024 ** 3 },
    memory: { totalBytes: 32 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 },
    game: {
      installed: { build: '25218825', steamInfPath: path.join(dir, 'appmanifest_730.acf'), mtime: Math.floor(Date.now() / 1000) },
      latest: { build: '25218825', queriedAt: Date.now(), source: 'fixture' },
      updateAvailable: false,
    },
    instances,
    residual: { backup: { path: path.join(dir, 'backup'), bytes: 0, files: 0 }, msmLog: { path: path.join(dir, 'log'), bytes: 0, files: 0 } },
    maintenance: [],
    // 实例清单实际来自 DB(平台权威),不是离线缓存 —— 置 backend 以免面板在 stub 联调时
    // 显示「离线缓存」降级徽章(真机 reverse 由桥侧按 backend/cache/none 如实上报)
    instancesSource: 'backend',
  }
  // 夹具可只覆盖部分字段(disk/game 深合并一层),方便前端造"低磁盘/有更新/残留"等场景
  const merged = base
    ? { ...synthesized, ...base, disk: { ...synthesized.disk, ...(base.disk || {}) }, game: { ...synthesized.game, ...(base.game || {}) } }
    : synthesized

  if (op === 'instances_list') {
    return {
      ok: true,
      instances: (merged.instances || []).map((i) => ({
        idx: i.idx, name: i.name, port: i.port, gotvPort: i.gotvPort,
        running: i.process?.running ?? false, uptimeSec: i.process?.uptimeSec ?? 0,
      })),
    }
  }
  return merged
}
