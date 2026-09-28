// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 全链路 smoke:起真实 server(stub 桥模式)→ 登录 → 建房 → 配置 → 开赛 → 事件回流 → 收尾
// 运行:npm run smoke
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { io } from 'socket.io-client'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { initDb, getDb } from '../db.js'
import { buildMatchJson } from '../lib/matchjson.js'
import { bridgeArenaMatchBind, bridgeArenaMatchClose } from '../lib/bridge.js'
import { initAgentChannel, waitForArenaMatchResult, simulateArenaMatchResult, cancelArenaMatchResultWait } from '../lib/agentChannel.js'
import { recoverPendingArenaMatchesOnStartup, cacheInstances, tryReleaseCooling, confirmArenaMatchClose } from '../lib/instances.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PORT = 8099
const BASE = `http://127.0.0.1:${PORT}`
const STUB_DIR = mkdtempSync(path.join(tmpdir(), 'arena-smoke-'))
process.env.ARENA_STUB_DIR = STUB_DIR

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

// ---- 简易 cookie jar + fetch 封装 ----
let cookie = ''
async function req(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  return { status: res.status, data }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等到实例空闲(默认 main;用于自动分配开赛的用例)。加速计时下(DEMO/强制冷却 2~4s + 300ms 清扫),
// 上一场结束到下一场开赛之间可能仍处冷却窗口 —— 显式等待,不靠时序碰运气(消 flaky;等不到则如实失败)
async function waitInstanceFree(name = 'main', timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    const inst = (await req('GET', '/api/instances', null)).data?.find((i) => i.name === name)
    if (!inst || inst.state === 'idle') return inst?.state ?? null
    if (Date.now() - t0 > timeoutMs) {
      console.log(`  WARN  等待 ${name} 空闲超时(现状态 ${inst.state})`)
      return inst.state
    }
    await sleep(150)
  }
}

// 原始字节上传(demo);MatchZy 真实请求带 application/octet-stream
async function rawPost(url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/octet-stream', ...headers },
  })
  const text = await res.text()
  return { status: res.status, data: text ? JSON.parse(text) : null }
}

// 原始字节请求(带当前 cookie 会话;缩略图上传等用)
async function rawReq(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    body,
    headers: { 'content-type': 'application/octet-stream', ...(cookie ? { cookie } : {}) },
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { status: res.status, data }
}

// ---- Socket.io 广播验证 ----
async function withSocket(roomId, fn) {
  const { io } = await import('socket.io-client')
  const socket = io(BASE, { transports: ['websocket'], reconnection: false })
  const updates = []
  socket.on('room:update', (room) => {
    if (room.id === roomId) updates.push(room)
  })
  socket.on('match:event', (ev) => updates.push(ev))
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve)
    socket.on('connect_error', reject)
    setTimeout(() => reject(new Error('socket connect timeout')), 5000)
  })
  socket.emit('join', { roomId })
  try {
    return await fn({ updates })
  } finally {
    socket.close()
  }
}

// 管理员 socket(握手带会话 cookie)
async function withAdminSocket(instance, fn, { cookie: sidCookie } = {}) {
  const { io } = await import('socket.io-client')
  const socket = io(BASE, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: sidCookie ? { cookie: sidCookie } : {},
  })
  const events = []
  const want = ['console:output', 'console:reset', 'console:state', 'console:error', 'console:history_result', 'console:command_result']
  for (const ev of want) {
    socket.on(ev, (data) => events.push({ ev, data }))
  }
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve)
    socket.on('connect_error', reject)
    setTimeout(() => reject(new Error('socket connect timeout')), 5000)
  })
  socket.emit('console:subscribe', { instance, offset: 0 })
  // ask:emit 请求并等待对应响应事件
  const ask = (ev, payload, respEvent, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`socket ${ev} 响应超时`)), timeoutMs)
      const onResp = (data) => {
        clearTimeout(timer)
        socket.off(respEvent, onResp)
        resolve(data)
      }
      socket.once(respEvent, onResp)
      socket.emit(ev, payload)
    })
  try {
    return await fn({ events, socket, ask })
  } finally {
    socket.close()
  }
}

async function withAdminsSocket(fn, { cookie: sidCookie } = {}) {
  const { io } = await import('socket.io-client')
  const socket = io(BASE, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: sidCookie ? { cookie: sidCookie } : {},
  })
  const events = []
  for (const ev of ['instances:update', 'job:update', 'job:done', 'job:error']) {
    socket.on(ev, (data) => events.push({ ev, data }))
  }
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve)
    socket.on('connect_error', reject)
    setTimeout(() => reject(new Error('socket connect timeout')), 5000)
  })
  socket.emit('admins:subscribe')
  await sleep(100)
  try {
    return await fn({ events, socket })
  } finally {
    socket.close()
  }
}

async function main() {
  console.log('[smoke] starting server (stub bridge) ...')
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
      DB_PATH: path.join(STUB_DIR, 'arena.db'),
      BRIDGE_MODE: process.env.SMOKE_BRIDGE_MODE || 'stub',
      DEMO_ARCHIVE: 'off', // 录像定期归档调度器:主用例里关闭,专项用例另起隔离实例
      ...(process.env.SMOKE_BRIDGE_URL ? { BRIDGE_URL: process.env.SMOKE_BRIDGE_URL } : {}),
      ...(process.env.SMOKE_BRIDGE_TOKEN ? { BRIDGE_TOKEN: process.env.SMOKE_BRIDGE_TOKEN } : {}),
      ARENA_STUB_DIR: STUB_DIR,
      STUB_BOOT_S: '1',
      // agent 保活自检加速(reverse 用例:静默连接应被后端断开);桥的 health_push_ms 同步设小
      AGENT_PING_MS: '300',
      AGENT_STALE_MS: '1500',
      // 平台告警:桥离线阈值调小,便于在用例里做确定性断言(默认 120s)
      BRIDGE_OFFLINE_ALERT_MS: process.env.SMOKE_ALERT_MS || '1200',
      VETO_TURN_TIMEOUT_MS: process.env.SMOKE_VETO_TIMEOUT_MS || '2500',
      ROOM_DISCONNECT_GRACE_MS: '800',
      PLUGIN_READY_DELAY_MS: '0',
      DEMO_STORAGE_DIR: path.join(STUB_DIR, 'demos'),
      DEMO_COOLING_TIMEOUT_MS: process.env.SMOKE_COOLING_TIMEOUT_MS || '4000',
      FORCE_END_COOLING_TIMEOUT_MS: '2000',
      DEMO_COOLING_SWEEP_MS: '300',
      ADMIN_STEAM_IDS: '76561199000000000', // 隔离用管理员测试号
      STEAM_PROXY: '', // smoke 内禁止 Steam 网络解析(登录均带 name)
      BOT_INSTANCE_NAME: 'match3',
      ADMIN_PASSWORD_MIN_LENGTH: '6',
      CONSOLE_POLL_MS: '300',
      // 社区图下载/缩略图(smoke 内加速轮询 + 隔离存储目录)
      MAP_IMAGE_DIR: path.join(STUB_DIR, 'map-images'),
      WORKSHOP_DOWNLOAD_INSTANCE: 'main',
      WORKSHOP_DOWNLOAD_POLL_MS: '200',
      WORKSHOP_DOWNLOAD_STABLE_POLLS: '3',
      WORKSHOP_DOWNLOAD_TIMEOUT_MS: '20000',
      WORKSHOP_LOAD_CONFIRM_MS: '8000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`))
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`))

  // reverse 模式:本地 spawn 桥反向连接测试后端
  //   BRIDGE_BIN=<cs 路径> → 用 v2 Go 二进制跑;不设则用生产同款 agent/bridge.py
  let bridgeProc = null
  if (process.env.SMOKE_BRIDGE_MODE === 'reverse') {
    // reverse smoke 连接的是本机 ws://127.0.0.1；代理环境会让 Python websocket-client
    // 把 localhost 也发给代理，产生“Connection to remote host was lost”。
    const bridgeEnv = { ...process.env, ARENA_STUB_DIR: STUB_DIR }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete bridgeEnv[key]
    }
    const stubPath = path.join(ROOT, 'scripts', 'msm-stub.sh')
    const fs2 = await import('node:fs')
    const bridgeBin = process.env.BRIDGE_BIN || ''
    if (bridgeBin) {
      // v2 config.yaml:最小键集 —— server_id/instances 由后端 hello_ack 下发,
      // mode/send_prefixes/log_dirs 等旧键已弃用(写了只警告忽略,这里索性不写)
      const cfgPath = path.join(STUB_DIR, 'config.yaml')
      fs2.writeFileSync(
        cfgPath,
        [
          'token: replace-this-before-use',
          `backend_ws: ws://127.0.0.1:${PORT}/api/agent`,
          `msm: ${stubPath}`,
          `msm_dir: ${path.join(ROOT, 'scripts')}`,
          // 清理/归档落点:与 stub 模式(msm-stub.sh)一致,便于断言
          `archive_dir: ${path.join(STUB_DIR, 'arena-data')}`,
          'console_tail_ms: 300',
          // 保活:后端 AGENT_STALE_MS=1500,桥必须比它更勤地推帧(否则健康连接会被误判为半开)
          'health_push_ms: 500',
        ].join('\n') + '\n',
      )
      bridgeProc = spawn(bridgeBin, ['agent', '--config', cfgPath], {
        env: bridgeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      bridgeProc.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`))
      bridgeProc.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`))
      console.log(`[smoke] reverse mode: v2 桥二进制 spawned (${bridgeBin})`)
    } else {
      const bridgeCfg = path.join(STUB_DIR, 'bridge-reverse.json')
      fs2.writeFileSync(
        bridgeCfg,
        JSON.stringify(
          {
            mode: 'reverse',
            token: 'replace-this-before-use',
            server_id: 'g1',
            backend_ws: `ws://127.0.0.1:${PORT}/api/agent`,
            msm: stubPath,
            msm_dir: path.join(ROOT, 'scripts'),
            instances: ['main', 'match1', 'match2', 'match3'],
            // 清理/归档落点:与 stub 模式(msm-stub.sh)一致,便于断言
            archive_dir: path.join(STUB_DIR, 'arena-data'),
            send_prefixes: [
              'matchzy_loadmatch', 'matchzy_loadmatch_url', 'get5_loadmatch_url',
              'matchzy_remote_log_url', 'matchzy_remote_log_header_key', 'matchzy_remote_log_header_value',
              'matchzy_endmatch', 'get5_endmatch', 'css_endmatch', 'changelevel', 'css_restart',
            ],
            console_tail_ms: 300,
            // 保活:后端 AGENT_STALE_MS=1500,桥必须比它更勤地推帧(否则健康连接会被误判为半开)
            health_push_ms: 500,
          },
          null,
          2,
        ),
      )
      bridgeProc = spawn('python3', [path.join(ROOT, 'agent', 'bridge.py'), '--config', bridgeCfg], {
        env: bridgeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      bridgeProc.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`))
      bridgeProc.stderr.on('data', (d) => process.stderr.write(`[bridge-err] ${d}`))
      console.log('[smoke] reverse mode: bridge.py spawned')
    }
  }

  try {
    // 等健康检查
    let healthy = false
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${BASE}/api/health`)
        if (r.ok) {
          healthy = true
          break
        }
      } catch {}
      await sleep(500)
    }
    check('health', healthy)
    if (!healthy) throw new Error('server did not start')

    // 0. 桥 agent 自检:reverse 模式检查 Go v2；独立 stub smoke 不含已退役的 Python 桥。
    {
      const bridgeBin = process.env.BRIDGE_BIN || ''
      const legacyCheck = path.join(ROOT, 'scripts', 'bridge-selfcheck.py')
      if (bridgeBin || existsSync(legacyCheck)) {
        const selfcheck = bridgeBin
          ? spawn(bridgeBin, ['selftest', '--json'], { cwd: ROOT })
          : spawn('python3', [legacyCheck], { cwd: ROOT })
        let buf = ''
        let errBuf = ''
        selfcheck.stdout.on('data', (d) => (buf += String(d)))
        selfcheck.stderr.on('data', (d) => (errBuf += String(d)))
        const code = await new Promise((resolve) => {
          selfcheck.on('close', resolve)
          setTimeout(() => {
            selfcheck.kill('SIGKILL')
            resolve('timeout')
          }, 30000)
        })
        const line = buf.trim().split('\n').filter(Boolean).pop() || '{}'
        let verdict = {}
        try {
          verdict = JSON.parse(line)
        } catch {}
        const failed = Object.entries(verdict)
          .filter(([, v]) => v !== true)
          .map(([k]) => k)
        check(
          'bridge selfcheck (allowlist/ok/error-isolation/partial-line)',
          code === 0 && failed.length === 0 && Object.keys(verdict).length >= 10,
          `exit=${code} failed=${failed.join(',')} ${errBuf.slice(-200)}`,
        )
      } else {
        console.log('[smoke] skip legacy Python bridge selfcheck; Go bridge checks live in cs-arena-agent')
      }
    }

    // 0b. 桥 http 模式已移除:BRIDGE_MODE=http 启动必须当场失败(否则会静默退化为 stub)
    {
      const guard = spawn('node', ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: '8098', DB_PATH: path.join(STUB_DIR, 'http-guard.db'), BRIDGE_MODE: 'http' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let gbuf = ''
      guard.stdout.on('data', (d) => (gbuf += String(d)))
      guard.stderr.on('data', (d) => (gbuf += String(d)))
      const code = await new Promise((resolve) => {
        guard.on('close', resolve)
        setTimeout(() => {
          guard.kill('SIGKILL')
          resolve('timeout')
        }, 8000)
      })
      check('BRIDGE_MODE=http rejected at startup', code === 1 && gbuf.includes('不受支持'), `exit=${code} out=${gbuf.slice(-200)}`)
    }

    // 1. 登录两个用户
    let r = await req('POST', '/api/auth/login', { steamId: '76561190000000001', name: '玩家A', avatarUrl: '' })
    check('login A', r.status === 200 && r.data.user.steamId === '76561190000000001')
    const hostCookie = cookie

    // 1b. 服务器状态(未登录 401;先清空 cookie)
    cookie = ''
    r = await req('GET', '/api/servers/status', null)
    check('servers status 401 without login', r.status === 401)
    r = await req('GET', '/api/servers', null)
    check('servers alias 401 without login', r.status === 401)
    cookie = hostCookie
    r = await req('GET', '/api/servers/status', null)
    check(
      'servers initial all stopped',
      r.status === 200 &&
        r.data.length === 1 &&
        r.data[0].groupId === 'g1' &&
        r.data[0].groupName === '示例服务器组' &&
        r.data[0].servers.length === 4 &&
        r.data[0].summary.stopped === 4,
      JSON.stringify(r.data),
    )

    cookie = ''
    r = await req('POST', '/api/auth/login', { steamId: '76561190000000002', name: '玩家B', avatarUrl: '' })
    check('login B', r.status === 200)
    check('non-admin isAdmin false', r.data.user.isAdmin === false, JSON.stringify(r.data.user))
    const guestCookie = cookie

    // 1c. 管理员密码流(测试管理员 76561199000000000)
    const ADMIN = '76561199000000000'
    cookie = ''
    r = await req('POST', '/api/auth/login', { steamId: ADMIN, name: 'AdminTest', avatarUrl: '' })
    check('admin first login -> SETUP_REQUIRED', r.status === 403 && r.data.code === 'PASSWORD_SETUP_REQUIRED', JSON.stringify(r.data))
    r = await req('POST', '/api/auth/set-password', { steamId: ADMIN, password: '123' })
    check('set-password too short -> 400', r.status === 400)
    r = await req('POST', '/api/auth/set-password', { steamId: ADMIN, password: 'admin123', name: 'AdminTest' })
    check('set-password ok + auto login + isAdmin', r.status === 200 && r.data.user.isAdmin === true, JSON.stringify(r.data))
    r = await req('POST', '/api/auth/set-password', { steamId: ADMIN, password: 'admin123', name: 'AdminTest' })
    check('set-password twice -> 409', r.status === 409)
    r = await req('POST', '/api/auth/logout', {})
    cookie = ''
    r = await req('POST', '/api/auth/login', { steamId: ADMIN, password: 'wrong-pass', name: 'AdminTest' })
    check('admin wrong password -> 401', r.status === 401)
    r = await req('POST', '/api/auth/login', { steamId: ADMIN, password: 'admin123', name: 'AdminTest' })
    check('admin login with password ok', r.status === 200 && r.data.user.isAdmin === true)
    r = await req('GET', '/api/auth/me', null)
    check('admin /auth/me isAdmin', r.status === 200 && r.data.user.isAdmin === true && r.data.user.steamId === ADMIN)
    r = await req('POST', '/api/auth/set-password', { steamId: '76561190000000002', password: 'whatever' })
    check('set-password for non-admin -> 403', r.status === 403)
    // 1d. 主机概况(stub 夹具;M3 起):仅管理员 + 字段形状 + 低磁盘/有更新标记
    {
      const saved = cookie
      cookie = ''
      const anon = await req('GET', '/api/host/status')
      check('host status 401 without login', anon.status === 401)
      const anonGroups = await req('GET', '/api/host/groups')
      check('host groups 401 without login', anonGroups.status === 401)
      cookie = saved

      const fsHs = await import('node:fs')
      const pathHs = await import('node:path')
      fsHs.writeFileSync(
        pathHs.join(STUB_DIR, 'host-status.json'),
        JSON.stringify({
          disk: { freeBytes: 5 * 1024 ** 3, usedPct: 92.5, warn: true },
          game: { latest: { build: '2000912', queriedAt: 1789917000000, source: 'fixture' }, updateAvailable: true },
        }),
      )
      const hs = await req('GET', '/api/host/status')
      const g = hs.data?.groups?.[0] || {}
      const bridgeBinMode = !!process.env.BRIDGE_BIN
      if (process.env.SMOKE_BRIDGE_MODE === 'reverse' && !bridgeBinMode) {
        // 旧 Python 桥:未声明 host_status 能力 → 必须**降级**(200 + error),不得 5xx(前端要能显示"旧桥不支持")
        check(
          'host status degrades on old bridge (capability gate)',
          hs.status === 200 && g.ok === false && typeof g.error === 'string' && g.error.includes('host_status'),
          JSON.stringify(g),
        )
        check('host status low-disk fixture ignored on old bridge', g.disk === undefined, JSON.stringify(g.disk))
      } else if (bridgeBinMode) {
        // v2 二进制桥:走真实 op(CI 环境无 msm 布局 → 实例为空属正常,只断言形状与来源)
        check(
          'host status served by v2 bridge (agent data source)',
          hs.status === 200 && g.ok === true && g.dataSource === 'agent' && g.host?.agentVersion !== undefined &&
            Array.isArray(g.instances) && g.residual && typeof g.instancesSource === 'string',
          JSON.stringify({ host: g.host, n: g.instances?.length, src: g.instancesSource }),
        )
        check('host status low-disk fixture ignored by v2 bridge', g.disk?.warn === false || g.disk?.warn === undefined, JSON.stringify(g.disk))
      } else {
        check(
          'host status exposes disk/game/instances/residual (stub fixture)',
          hs.status === 200 && g.ok === true && g.dataSource === 'stub' &&
            g.disk?.totalBytes > 0 && g.game?.installed?.build === '25218825' &&
            Array.isArray(g.instances) && g.instances.length === 4 &&
            g.instances.every((i) => i.gotvPort === i.port + 100) &&
            g.residual && typeof g.residual === 'object' &&
            Array.isArray(g.maintenance) && typeof g.instancesSource === 'string',
          JSON.stringify({ disk: g.disk, build: g.game?.installed?.build, n: g.instances?.length }),
        )
        check(
          'host status flags low disk + update available',
          g.disk?.warn === true && g.disk?.freeBytes === 5 * 1024 ** 3 && g.game?.latest?.build === '2000912' && g.game?.updateAvailable === true,
          JSON.stringify({ disk: g.disk, game: g.game }),
        )
      }
      const one = await req('GET', '/api/host/status?groupId=g1')
      check('host status groupId filter', one.status === 200 && one.data.groups.length === 1 && one.data.groups[0].groupId === 'g1')
      const bad = await req('GET', '/api/host/status?groupId=nope')
      check('host status unknown group 404', bad.status === 404)
      fsHs.unlinkSync(pathHs.join(STUB_DIR, 'host-status.json'))
    }

    // 分配规则:系统不自动启动实例 → 管理员手动启动 main 供自动分配使用
    r = await req('POST', '/api/instances/main/start', {})
    check('admin manually starts main (auto allocation needs RUNNING)', r.status === 200, JSON.stringify(r.data))
    cookie = hostCookie
    cookie = hostCookie

    // 2. 建房
    r = await req('POST', '/api/rooms', { name: 'smoke房', matchType: 'custom' })
    check('create room', r.status === 201 && r.data.code)
    const roomId = r.data.id
    const code = r.data.code

    // 3. B 加入(自动进 T)
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${roomId}/join`, {})
    check('join room', r.status === 200 && r.data.slots.length === 2)

    // 4. 房主配置 1v1 + direct pick 1 图
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${roomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    check('config 1v1 direct', r.status === 200 && r.data.teamA === 1)
    r = await req('POST', `/api/rooms/${roomId}/directpick`, { mapId: 'de_mirage' })
    check('direct pick mirage', r.status === 200 && r.data.picked.length === 1)

    // 5-10. 开赛 → 事件回流 → 收尾,全程保持一条 Socket.io 连接收集推送
    await withSocket(roomId, async ({ updates }) => {
      await waitInstanceFree('main')
      r = await req('POST', `/api/rooms/${roomId}/start`, {})
      check('start match', r.status === 200 && r.data.matchId, JSON.stringify(r.data))
      const matchId = r.data.matchId
      const instance = r.data.instance
      check('instance allocated', typeof instance === 'string' && instance.length > 0, String(instance))
      check('room live + server info', r.data.room.status === 'live' && r.data.room.server?.port > 0)
      check('server ip from game_servers host_ip', r.data.room.server?.ip === '192.0.2.211', JSON.stringify(r.data.room.server))

      r = await req('GET', '/api/rooms', null)
      check('live room visible in lobby list', r.data.some((x) => x.id === roomId), JSON.stringify(r.data.map((x) => x.id)))

      r = await req('GET', '/api/servers/status', null)
      const svMain = r.data[0].servers.find((s) => s.name === instance)
      check('servers: match instance in_match', svMain && svMain.status === 'in_match' && svMain.statusLabel === '比赛中', JSON.stringify(r.data[0].servers))

      // 6. 服务器已成功 GET 比赛 JSON(stub 日志验证;http 模式时 stub 由 bridge 进程运行)
      const stubDir = process.env.SMOKE_STUB_DIR || STUB_DIR
      const stubLog = path.join(stubDir, `${instance}.log`)
      await sleep(500)
      const log = existsSync(stubLog) ? readFileSync(stubLog, 'utf8') : ''
      check('LOADMATCH OK (game->web pull)', /LOADMATCH OK/.test(log), log.split('\n').slice(-3).join(' | '))

      // 7. 比赛 JSON 鉴权与内容
      r = await req('GET', `/api/rooms/${roomId}/status`, null)
      const m = r.data.match
      const badRes = await fetch(`${BASE}/api/match/${m.id}?token=bad`)
      check('match JSON 401 on bad token', badRes.status === 401)
      r = await req('POST', '/api/events', { event: 'series_start', matchid: matchId }, { 'x-arena-token': 'wrong' })
      check('events 401 on bad token', r.status === 401)

      // 用正确 token:直接查询 sqlite(server 同一进程共享 DB 文件)
      const { DatabaseSync } = await import('node:sqlite')
      const sdb = new DatabaseSync(path.join(STUB_DIR, 'arena.db'))
      const matchRow = sdb.prepare('SELECT * FROM matches WHERE id = ?').get(matchId)
      const token = matchRow.token
      const payload = JSON.parse(matchRow.payload)
      check('match JSON maplist uses full map names', JSON.stringify(payload.maplist) === JSON.stringify(['de_mirage']), JSON.stringify(payload.maplist))
      check(
        'match JSON: 友军伤害默认开启不下发 cvar 覆盖',
        !('mp_friendlyfire' in payload.cvars) && !('ff_damage_reduction_bullets' in payload.cvars),
        JSON.stringify(payload.cvars),
      )
      check(
        'match JSON 开局公告:默认房拼刀红字(默认关闭)+友军伤害绿字、无投掷物提醒',
        payload.cvars.matchzy_match_start_message === '当前比赛 拼刀选边 {Red}已关闭{Default}，友军伤害 {Green}已开启{Default}',
        JSON.stringify(payload.cvars.matchzy_match_start_message),
      )

      r = await req('POST', '/api/events', { event: 'series_start', matchid: matchId }, { 'x-arena-token': token })
      check('series_start stored', r.status === 200 && r.data.stored === true)

      const roundEnd = {
        event: 'round_end',
        matchid: matchId,
        map_number: 1,
        round_number: 1,
        round_time: 90,
        reason: 7,
        winner: { side: 'ct', team: 'team1' },
        team1: { series_score: 1, score: 16, score_ct: 9, score_t: 7, players: [] },
        team2: { series_score: 0, score: 4, score_ct: 2, score_t: 2, players: [] },
      }
      r = await req('POST', '/api/events', roundEnd, { 'x-arena-token': token })
      check('round_end stored', r.status === 200 && r.data.stored === true)

      r = await req('POST', '/api/events', roundEnd, { 'x-arena-token': token })
      check('round_end dedup (repost skipped)', r.status === 200 && r.data.stored === false)

      r = await req('GET', `/api/rooms/${roomId}/status`, null)
      check('current_scores updated', r.data.match?.currentScores?.winner?.team === 'team1')

      // 比赛结束后的实例侧整理(0.4.3+):伪造该场与另一场的产物,验证只清本场、且比赛 JSON 被归档到
      // 实例目录之外(对局录像不在清理范围)
      mkdirSync(path.join(STUB_DIR, 'MatchZyDataBackup'), { recursive: true })
      mkdirSync(path.join(STUB_DIR, 'MatchZyPlayerNames'), { recursive: true })
      mkdirSync(path.join(STUB_DIR, 'MatchZy'), { recursive: true })
      writeFileSync(path.join(STUB_DIR, 'MatchZyDataBackup', `matchzy_${matchId}_0_round00.json`), '{}')
      writeFileSync(path.join(STUB_DIR, `matchzy_${matchId}_0_round00.txt`), 'backup')
      writeFileSync(path.join(STUB_DIR, 'MatchZyPlayerNames', `Match_${matchId}.ini`), '"Names" {}')
      writeFileSync(path.join(STUB_DIR, 'backup_round00.txt'), 'engine-backup')
      writeFileSync(path.join(STUB_DIR, 'MatchZyDataBackup', 'matchzy_999999_0_round00.json'), '{}')
      writeFileSync(path.join(STUB_DIR, 'MatchZyPlayerNames', 'Match_999999.ini'), '"Names" {}')
      writeFileSync(
        path.join(STUB_DIR, 'MatchZy', 'demo-decoy.dem'),
        'demo-keep',
      ) // 录像:不得被清理

      r = await req(
        'POST',
        '/api/events',
        {
          event: 'series_end',
          matchid: matchId,
          time_until_restore: 10,
          winner: { side: 'ct', team: 'team1' },
          team1_series_score: 1,
          team2_series_score: 0,
        },
        { 'x-arena-token': token },
      )
      check('series_end stored', r.status === 200 && r.data.stored === true)

      await sleep(100)
      r = await req('GET', `/api/rooms/${roomId}/status`, null)
      check('room returns waiting with cleared picks after series_end', r.data.room.status === 'waiting' && r.data.room.picked.length === 0 && r.data.room.banned.length === 0)
      check('completed match clears room server (P-3)', r.data.room.server === undefined)
      check('match ended', r.data.match.status === 'ended')

      // series_end → 实例进入冷却(等 demo 上传到账)
      r = await req('GET', '/api/instances', null)
      let inst = r.data.find((i) => i.name === instance)
      check('instance cooling after series_end', inst && inst.state === 'cooling', JSON.stringify(inst))
      await sleep(400)
      r = await req('GET', '/api/instances', null)
      inst = r.data.find((i) => i.name === instance)
      check('旧赛事无 map_result 时仍等待首张 Demo', inst && inst.state === 'cooling', JSON.stringify(inst))
      // 等桥清理完成(反向通道往返;stub 本地很快)—— 最多 6s
      const archDir = path.join(STUB_DIR, 'arena-data', 'matchjson', instance)
      for (let i = 0; i < 30 && !existsSync(path.join(archDir, `matchzy_load_${matchId}.json`)); i++) await sleep(200)
      const listDir = (d) => (existsSync(d) ? readdirSync(d) : ['(missing)'])
      // 该场产物已删、录像保留、另一场(999999)产物不受影响;比赛 JSON 归档到 stub 的 arena-data/(实例目录之外)
      check(
        'matchcleanup: 该场次产物已清理(回合备份 JSON/恢复残留/强制名/引擎回合备份)',
        !existsSync(path.join(STUB_DIR, 'MatchZyDataBackup', `matchzy_${matchId}_0_round00.json`)) &&
          !existsSync(path.join(STUB_DIR, `matchzy_${matchId}_0_round00.txt`)) &&
          !existsSync(path.join(STUB_DIR, 'MatchZyPlayerNames', `Match_${matchId}.ini`)) &&
          !existsSync(path.join(STUB_DIR, 'backup_round00.txt')),
        JSON.stringify(listDir(STUB_DIR)),
      )
      check(
        'matchcleanup: 平台比赛 JSON 归档到实例目录之外(matchzy_load_<id>.json)',
        !existsSync(path.join(STUB_DIR, `matchzy_load_${matchId}.json`)) &&
          existsSync(path.join(STUB_DIR, 'arena-data', 'matchjson', instance, `matchzy_load_${matchId}.json`)),
        JSON.stringify(listDir(archDir).slice(0, 5)),
      )
      check(
        'matchcleanup: 只清本场 + 对局录像保留',
        existsSync(path.join(STUB_DIR, 'MatchZyDataBackup', 'matchzy_999999_0_round00.json')) &&
          existsSync(path.join(STUB_DIR, 'MatchZyPlayerNames', 'Match_999999.ini')) &&
          existsSync(path.join(STUB_DIR, 'MatchZy', 'demo-decoy.dem')),
        JSON.stringify(listDir(path.join(STUB_DIR, 'MatchZy'))),
      )
      if (process.env.SMOKE_BRIDGE_MODE !== 'reverse') {
        // stub 模式断言下发痕迹;reverse 模式由真实 bridge.py 直接执行(效果断言在上面)
        const cleanupLog = readFileSync(path.join(STUB_DIR, `${instance}.log`), 'utf8')
        check(
          'matchcleanup: 经桥下发 matchcleanup <matchId>',
          cleanupLog.includes(`MATCHCLEANUP ${matchId} deleted=4 moved=1`),
          cleanupLog.split('\n').filter((l) => l.includes('MATCHCLEANUP')).join(' | '),
        )
      }


      // demo 上传(带 token + MatchZy 头)→ 到齐即解除冷却
      r = await rawPost(
        '/api/demos',
        Buffer.from('fake-demo-bytes'),
        {
          'x-arena-token': token,
          'matchzy-filename': 'demo_mirage_match1.dem',
          'matchzy-matchid': String(matchId),
          'matchzy-mapnumber': '0',
          'matchzy-roundnumber': '16',
        },
      )
      check('demo upload 200', r.status === 200 && r.data.ok === true)
      r = await rawPost(
        '/api/demos',
        Buffer.from('fake-demo-bytes'),
        {
          'x-arena-token': token,
          'matchzy-filename': 'demo_mirage_match1.dem',
          'matchzy-matchid': String(matchId),
          'matchzy-mapnumber': '0',
        },
      )
      check('demo upload dedup 200', r.status === 200)
      r = await rawPost(
        '/api/demos',
        Buffer.from('x'),
        { 'x-arena-token': token, 'matchzy-filename': 'x.dem', 'matchzy-matchid': '9999' },
      )
      check('demo upload matchid mismatch rejected', r.status === 400)
      r = await rawPost('/api/demos', Buffer.from('x'), { 'matchzy-filename': 'x.dem', 'matchzy-matchid': String(matchId) })
      check('demo upload bad token rejected', r.status === 401)

      r = await req('GET', '/api/instances', null)
      inst = r.data.find((i) => i.name === instance)
      check('instance released after demos complete', inst && inst.state === 'idle', JSON.stringify(inst))

      r = await req('GET', '/api/servers/status', null)
      const svAfter = r.data[0].servers.find((s) => s.name === instance)
      check('servers: instance back to idle', svAfter && svAfter.status === 'idle' && svAfter.statusLabel === '空闲', JSON.stringify(svAfter))

      r = await req('GET', `/api/demos?matchId=${matchId}`, null)
      check('demo listed (no download)', r.data.length === 1 && r.data[0].fileName.includes('.dem'))

      // Socket.io 广播断言
      await sleep(300)
      const liveSeen = updates.filter((u) => u.status === 'live')
      check('socket: room:update live pushed', liveSeen.length > 0)
      check('socket: server info pushed', liveSeen.at(-1)?.server?.port > 0)
      const ended = updates.filter((u) => u.status === 'waiting' && !u.server)
      check('socket: room:update waiting pushed after match', ended.length > 0)
      const evs = updates.filter((u) => u.matchId === matchId && u.event?.event === 'series_end')
      check('socket: match:event series_end pushed', evs.length > 0)
      const roundEvs = updates.filter((u) => u.matchId === matchId && u.event?.event === 'round_end')
      check('socket: match:event round_end pushed', roundEvs.length > 0)
    })

    r = await req('GET', '/api/records', null)
    check('record created', r.data.length === 1 && r.data[0].score1 === 1 && r.data[0].winner === 'team1')
    check('record maps stored as official names', JSON.stringify(r.data[0].maps) === JSON.stringify(['de_mirage']), JSON.stringify(r.data[0].maps))

    // 9. 自然完赛保留房间，刷新列表仍可见，成员可以回到原房间
    r = await req('GET', '/api/rooms', null)
    const listed = r.data.find((x) => x.id === roomId)
    check('completed room remains listed', !!listed && listed.status === 'waiting')
    cookie = guestCookie
    r = await req('POST', '/api/rooms', { name: '第二个房', matchType: 'custom' })
    const room2Id = r.data.id
    r = await req('GET', '/api/rooms', null)
    const listed2 = r.data.find((x) => x.id === room2Id)
    check('waiting room listed without password', !!listed2 && listed2.password === undefined)
    await req('DELETE', `/api/rooms/${room2Id}`, {})

    // 10. 开赛校验:未满员不可开赛
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${roomId}/end`, {})
    check('force end', r.status === 200)
    r = await req('POST', `/api/rooms/${roomId}/start`, {})
    check('start rejected when no maps (after end reset)', r.status === 500)
    // 单房间守卫(2026-09-22):同一用户同一时间只能持有一个活跃房间 —— 本块用完即删,
    // 否则后续用例(同一 hostCookie)建房会被 409 拦住(结束比赛后房间回到 waiting,仍算活跃)
    await req('DELETE', `/api/rooms/${roomId}`, {})

    // ============ BO1 BP:6 ban 交替 + TeamB 选边(含队长权限) ============
    // 预先创建第三名玩家会话，避免登录耗时占用 BP 选边计时。
    cookie = ''
    await req('POST', '/api/auth/login', { steamId: '76561190000000003', name: '玩家C', avatarUrl: '' })
    const bpCCookie = cookie
    cookie = hostCookie

    r = await req('POST', '/api/rooms', { name: 'BP测试房', matchType: 'custom' })
    const vetoRoomId = r.data.id
    r = await req('POST', `/api/rooms/${vetoRoomId}/config`, { bestOf: 1, pickMode: 'veto', teamA: 2, teamB: 1 })
    check('veto room config', r.status === 200)
    // B 加入成为 t 队队长(房主 A 为 ct 队队长)
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${vetoRoomId}/join`, {})
    check('B joined BP room (t captain)', r.status === 200 && r.data.captainB === '76561190000000002')
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${vetoRoomId}/veto/start`, {})
    check('veto start -> vetoing + bp ban', r.status === 200 && r.data.status === 'vetoing' && r.data.bpPhase === 'ban' && r.data.vetoDeadlineAt > Date.now())

    // 第 0 轮(ct):t 队长操作 → 403;房主 ban
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${vetoRoomId}/veto`, { mapId: 'de_mirage', type: 'ban' })
    check('veto: non-turn captain rejected (403)', r.status === 403, JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${vetoRoomId}/veto`, { mapId: 'de_mirage', type: 'ban' })
    check('BO1 ban #1 (ct) ok', r.status === 200 && r.data.banned.length === 1)
    // 第 1 轮(t):t 队长 ban
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${vetoRoomId}/veto`, { mapId: 'de_inferno', type: 'ban' })
    check('BO1 ban #2 (t captain) ok', r.status === 200 && r.data.banned.length === 2)
    // 交替完成 6 ban(ct: host / t: B)
    for (const [turn, mapId] of [[2, 'de_nuke'], [3, 'de_dust2'], [4, 'de_ancient'], [5, 'de_anubis']]) {
      cookie = turn % 2 === 0 ? hostCookie : guestCookie
      r = await req('POST', `/api/rooms/${vetoRoomId}/veto`, { mapId, type: 'ban' })
      check(`BO1 ban turn${turn} ok`, r.status === 200 && r.data.banned.length === turn + 1)
    }
    r = await req('GET', `/api/rooms/${vetoRoomId}/status`, null)
    check(
      'BO1 after 6 bans -> side phase (TeamB pending), no pick needed',
      r.data.room.status === 'vetoing' && r.data.room.bpPhase === 'side' && r.data.room.sidePendingFor === 'team2',
      JSON.stringify({ phase: r.data.room.bpPhase, pending: r.data.room.sidePendingFor, picked: r.data.room.picked }),
    )
    check('BO1 decider auto-filled into picked', r.data.room.picked.length === 1, JSON.stringify(r.data.room.picked))
    // 选边阶段禁止 ban(房主尝试)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${vetoRoomId}/veto`, { mapId: 'de_vertigo', type: 'ban' })
    check('BO1 ban during side phase rejected', r.status === 409 && /选边阶段/.test(r.data.error), JSON.stringify(r.data))
    // 非待选边队伍的队长不可选边:ct 队队员 C(非队长/非房主)
    cookie = bpCCookie
    await req('POST', `/api/rooms/${vetoRoomId}/join`, {}) // C → ct
    r = await req('POST', `/api/rooms/${vetoRoomId}/side`, { side: 'ct' })
    check('side rejected for non-pending captain (403)', r.status === 403, JSON.stringify(r.data))
    // TeamB 队长选边
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${vetoRoomId}/side`, { side: 'ct' })
    check('BO1 side by TeamB ok -> waiting', r.status === 200 && r.data.status === 'waiting' && r.data.sidePendingFor === null, JSON.stringify(r.data))
    check('BO1 sideChoices team2_ct', r.data.sideChoices[0] === 'team2_ct', JSON.stringify(r.data.sideChoices))
    check('BO1 veto history = 6 bans', r.data.vetoHistory.length === 6)
    // 开赛 payload map_sides
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${vetoRoomId}/start`, {})
    check('BO1 veto start ok', r.status === 200, JSON.stringify(r.data))
    const { DatabaseSync: SdbBP } = await import('node:sqlite')
    const sdbBP = new SdbBP(path.join(STUB_DIR, 'arena.db'))
    const bp = JSON.parse(sdbBP.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(vetoRoomId).payload)
    check('BO1 payload map_sides team2_ct', JSON.stringify(bp.map_sides) === JSON.stringify(['team2_ct']), JSON.stringify(bp.map_sides))
    await req('DELETE', `/api/rooms/${vetoRoomId}`, {})
    cookie = ''
    await req('POST', '/api/auth/login', { steamId: ADMIN, password: 'admin123', name: 'AdminTest' })
    await req('POST', '/api/instances/main/reset', {})
    cookie = hostCookie

    // ============ BO3 BP:B,B,P,P,B,B + 每图即时选边 + 图三刀局 ============
    r = await req('POST', '/api/rooms', { name: 'BO3BP房', matchType: 'custom' })
    const bo3bpRoomId = r.data.id
    await req('POST', `/api/rooms/${bo3bpRoomId}/config`, { bestOf: 3, pickMode: 'veto', teamA: 1, teamB: 1 })
    cookie = guestCookie
    await req('POST', `/api/rooms/${bo3bpRoomId}/join`, {}) // B → t 队长
    cookie = hostCookie
    await req('POST', `/api/rooms/${bo3bpRoomId}/veto/start`, {})
    // ban,ban
    await req('POST', `/api/rooms/${bo3bpRoomId}/veto`, { mapId: 'de_mirage', type: 'ban' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${bo3bpRoomId}/veto`, { mapId: 'de_inferno', type: 'ban' })
    // pick1(TA) → TeamB 选边
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${bo3bpRoomId}/veto`, { mapId: 'de_nuke', type: 'pick' })
    check('BO3 pick1 -> side pending team2', r.status === 200 && r.data.sidePendingFor === 'team2', JSON.stringify(r.data.sidePendingFor))
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${bo3bpRoomId}/side`, { side: 't' })
    check('BO3 side1 (TeamB=t) ok', r.status === 200 && r.data.sideChoices[0] === 'team2_t')
    // pick2(TB) → TeamA 选边
    r = await req('POST', `/api/rooms/${bo3bpRoomId}/veto`, { mapId: 'de_dust2', type: 'pick' })
    check('BO3 pick2 -> side pending team1', r.status === 200 && r.data.sidePendingFor === 'team1')
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${bo3bpRoomId}/side`, { side: 'ct' })
    check('BO3 side2 (TeamA=ct) ok', r.status === 200 && r.data.sideChoices[1] === 'team1_ct')
    // ban,ban → done,图三自动
    cookie = hostCookie
    await req('POST', `/api/rooms/${bo3bpRoomId}/veto`, { mapId: 'de_ancient', type: 'ban' })
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${bo3bpRoomId}/veto`, { mapId: 'de_anubis', type: 'ban' })
    check('BO3 done -> waiting, picked 3 (图三自动)', r.status === 200 && r.data.status === 'waiting' && r.data.picked.length === 3, JSON.stringify({ status: r.data.status, picked: r.data.picked }))
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${bo3bpRoomId}/start`, {})
    check('BO3 veto start ok', r.status === 200, JSON.stringify(r.data))
    const { DatabaseSync: SdbB3 } = await import('node:sqlite')
    const sdbB3 = new SdbB3(path.join(STUB_DIR, 'arena.db'))
    const b3 = JSON.parse(sdbB3.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(bo3bpRoomId).payload)
    check('BO3 payload map_sides [team2_t,team1_ct,knife]', JSON.stringify(b3.map_sides) === JSON.stringify(['team2_t', 'team1_ct', 'knife']), JSON.stringify(b3.map_sides))
    await req('DELETE', `/api/rooms/${bo3bpRoomId}`, {})
    cookie = ''
    await req('POST', '/api/auth/login', { steamId: ADMIN, password: 'admin123', name: 'AdminTest' })
    await req('POST', '/api/instances/main/reset', {})
    cookie = hostCookie

    // ============ BO1 选边超时默认 CT ============
    r = await req('POST', '/api/rooms', { name: '选边超时房', matchType: 'custom' })
    const sideTmoRoomId = r.data.id
    await req('POST', `/api/rooms/${sideTmoRoomId}/config`, { bestOf: 1, pickMode: 'veto' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${sideTmoRoomId}/join`, {}) // B → t 队长
    cookie = hostCookie
    await req('POST', `/api/rooms/${sideTmoRoomId}/veto/start`, {})
    for (const [turn, mapId] of [[0, 'de_mirage'], [1, 'de_inferno'], [2, 'de_nuke'], [3, 'de_dust2'], [4, 'de_ancient'], [5, 'de_anubis']]) {
      cookie = turn % 2 === 0 ? hostCookie : guestCookie
      await req('POST', `/api/rooms/${sideTmoRoomId}/veto`, { mapId, type: 'ban' })
    }
    r = await req('GET', `/api/rooms/${sideTmoRoomId}/status`, null)
    check('side timeout room reaches side pending team2', r.data.room.bpPhase === 'side' && r.data.room.sidePendingFor === 'team2')
    // 等待超时(短超时环境)→ 自动默认 CT
    await sleep(Number(process.env.SMOKE_VETO_TIMEOUT_MS || 2500) + 2000)
    r = await req('GET', `/api/rooms/${sideTmoRoomId}/status`, null)
    check(
      'side timeout auto default CT -> waiting',
      r.data.room.status === 'waiting' && r.data.room.sideChoices[0] === 'team2_ct',
      JSON.stringify({ status: r.data.room.status, side: r.data.room.sideChoices }),
    )
    cookie = hostCookie // 删除需房主(此前遗留 guestCookie → 403,房间残留会撞单房间守卫)
    await req('DELETE', `/api/rooms/${sideTmoRoomId}`, {})

    // ============ Bug-3 回归:不等人数按各自名额校验 ============
    r = await req('POST', '/api/rooms', { name: '不等人数房', matchType: 'custom' })
    const mixRoomId = r.data.id
    cookie = guestCookie
    await req('POST', `/api/rooms/${mixRoomId}/join`, {})
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${mixRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 4 })
    check('config 1v4', r.status === 200)
    r = await req('POST', `/api/rooms/${mixRoomId}/directpick`, { mapId: 'de_vertigo' })
    check('direct pick', r.status === 200)
    r = await req('POST', `/api/rooms/${mixRoomId}/start`, {})
    check('1v4 start rejected (T needs 4)', r.status === 500 && /T 4/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${mixRoomId}/config`, { teamA: 1, teamB: 1 })
    check('config 1v1', r.status === 200)
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${mixRoomId}/start`, {})
    check('1v1 start ok (per-team check)', r.status === 200, JSON.stringify(r.data))
    const mixInstance = r.data.instance

    // 强制结束 → 冷却 → 无 demo 时靠兜底超时解除
    await req('DELETE', `/api/rooms/${mixRoomId}`, {})
    {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(path.join(STUB_DIR, 'arena.db'))
      const oldMatch = db.prepare('SELECT * FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(mixRoomId)
      const late = await req('POST', '/api/events', { event: 'series_start', matchid: oldMatch.id }, { 'x-arena-token': oldMatch.token })
      const row = db.prepare('SELECT status FROM matches WHERE id = ?').get(oldMatch.id)
      check('强退后迟到事件可确认且不复活比赛', late.status === 200 && late.data?.ok === true && row.status === 'aborted')
      db.close()
    }
    r = await req('GET', '/api/instances', null)
    const coolingInst = r.data.find((i) => i.name === mixInstance)
    check(
      '强退未开图比赛直接释放或进入冷却',
      coolingInst && ['idle', 'cooling'].includes(coolingInst.state),
      JSON.stringify(coolingInst),
    )
    await sleep(Number(process.env.SMOKE_COOLING_TIMEOUT_MS || 4000) + 1500)
    r = await req('GET', '/api/instances', null)
    const cooledInst = r.data.find((i) => i.name === mixInstance)
    check('cooling fallback timeout releases', cooledInst && cooledInst.state === 'idle', JSON.stringify(cooledInst))

    // ============ ready 阈值:players_per_team 取大队(全员 ready 才开赛),min_players_to_ready 取小队 ============
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '2v1房', matchType: 'custom' })
    const unevenRoomId = r.data.id
    await req('POST', `/api/rooms/${unevenRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 2, teamB: 1 })
    await req('POST', `/api/rooms/${unevenRoomId}/directpick`, { mapId: 'de_anubis' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${unevenRoomId}/join`, {}) // B → t
    r = await req('POST', '/api/auth/login', { steamId: '76561190000000003', name: '玩家C', avatarUrl: '' })
    const cCookieU = cookie
    await req('POST', `/api/rooms/${unevenRoomId}/join`, {}) // C → ct
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${unevenRoomId}/start`, {})
    check('2v1 start ok', r.status === 200, JSON.stringify(r.data))
    const { DatabaseSync: SdbU } = await import('node:sqlite')
    const sdbU = new SdbU(path.join(STUB_DIR, 'arena.db'))
    const up = JSON.parse(sdbU.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(unevenRoomId).payload)
    check(
      '不等人数:players_per_team = max(2,1) = 2(任一队缺人/未 ready 都不开赛),min_players_to_ready = min = 1(少人队 forceready 门槛)',
      up.players_per_team === 2 && up.min_players_to_ready === 1,
      JSON.stringify({ ppt: up.players_per_team, mpr: up.min_players_to_ready }),
    )
    await req('DELETE', `/api/rooms/${unevenRoomId}`, {})
    cookie = ''
    await req('POST', '/api/auth/login', { steamId: ADMIN, password: 'admin123', name: 'AdminTest' })
    await req('POST', '/api/instances/main/reset', {})
    cookie = hostCookie

    // ============ 地图名映射:未知地图拒绝开赛(池外地图无法经 API 选中;注库模拟篡改兜底) ============
    r = await req('POST', '/api/rooms', { name: '坏地图房', matchType: 'custom' })
    const badMapRoomId = r.data.id
    r = await req('POST', `/api/rooms/${badMapRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    r = await req('POST', `/api/rooms/${badMapRoomId}/directpick`, { mapId: 'cs_office' })
    check('map outside pool rejected', r.status === 400, JSON.stringify(r.data))
    // /mappool 已移除:房间地图池由全局池决定(veto=服役 7 张 / direct=总池),不可自定义
    r = await req('POST', `/api/rooms/${badMapRoomId}/mappool`, { mapIds: ['cs_office', 'de_mirage'] })
    check('mappool endpoint removed (404)', r.status === 404, JSON.stringify(r.data))
    // 直接注库注入目录外地图 → 开赛仍被拒(未知地图兜底校验)
    const { DatabaseSync: SdbBad } = await import('node:sqlite')
    const sdbBad = new SdbBad(path.join(STUB_DIR, 'arena.db'))
    sdbBad.prepare("UPDATE rooms SET picked = '[\"cs_office\"]', map_pool = '[\"cs_office\"]' WHERE id = ?").run(badMapRoomId)
    cookie = guestCookie
    await req('POST', `/api/rooms/${badMapRoomId}/join`, {})
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${badMapRoomId}/start`, {})
    check('unknown map start rejected', r.status === 500 && /未知地图/.test(r.data.error), JSON.stringify(r.data))
    await req('DELETE', `/api/rooms/${badMapRoomId}`, {})

    // ============ 变更1/2:BO1 多选不限张数 + finalMap 随机单图 ============
    r = await req('POST', '/api/rooms', { name: 'BO1多选房', matchType: 'custom' })
    const multiRoomId = r.data.id
    check('default team names', r.data.teamAName === 'TEAM A' && r.data.teamBName === 'TEAM B')
    check('竞技房默认开启加时', r.data.overtimeEnabled === true)
    r = await req('POST', `/api/rooms/${multiRoomId}/config`, { overtimeEnabled: 'false' })
    check('加时开关拒绝字符串', r.status === 400)
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${multiRoomId}/config`, { overtimeEnabled: false })
    check('非房主不能修改加时', r.status === 403)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${multiRoomId}/config`, { overtimeEnabled: false })
    check('房主可关闭加时', r.status === 200 && r.data.overtimeEnabled === false)
    r = await req('GET', `/api/rooms/${multiRoomId}`)
    check('加时开关持久化后读取一致', r.data.overtimeEnabled === false)
    r = await req('POST', `/api/rooms/${multiRoomId}/config`, {
      bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1,
      teamAName: 'Red"Team\nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      teamBName: 'Blue队',
    })
    check('team names sanitized', r.status === 200 && r.data.teamAName === 'RedTeamXXXXXXXXXXXXXXXXXXXXXXXXX', JSON.stringify(r.data.teamAName))
    r = await req('POST', `/api/rooms/${multiRoomId}/config`, { teamBName: '  ' })
    check('empty team name rejected', r.status === 400)
    for (const mapId of ['de_mirage', 'de_inferno', 'de_nuke']) {
      r = await req('POST', `/api/rooms/${multiRoomId}/directpick`, { mapId })
      check(`BO1 multi pick ${mapId} ok (no limit)`, r.status === 200)
    }
    check('BO1 picked 3 maps', r.data.picked.length === 3)
    cookie = guestCookie
    await req('POST', `/api/rooms/${multiRoomId}/join`, {})
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${multiRoomId}/start`, {})
    check('BO1 start ok with finalMap', r.status === 200 && r.data.finalMap && ['de_mirage','de_inferno','de_nuke'].includes(r.data.finalMap), JSON.stringify(r.data))
    const { DatabaseSync: Sdb2 } = await import('node:sqlite')
    const sdb2 = new Sdb2(path.join(STUB_DIR, 'arena.db'))
    const mrow2 = sdb2.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(multiRoomId)
    const p2 = JSON.parse(mrow2.payload)
    check('BO1 match JSON single map', JSON.stringify(p2.maplist) === JSON.stringify([r.data.finalMap]), JSON.stringify(p2.maplist))
    check('BO1 picked preserved (not overwritten)', r.data.room.picked.length === 3)
    check('BO1 payload team name from room', p2.team1.name === 'RedTeamXXXXXXXXXXXXXXXXXXXXXXXXX' && p2.team2.name === 'Blue队', `${p2.team1.name}/${p2.team2.name}`)
    check('关闭加时的 BO1 开赛快照下发引擎 0', p2.cvars.mp_overtime_enable === '0' && p2.cvars.mp_maxrounds === '24')
    await req('DELETE', `/api/rooms/${multiRoomId}`, {})

    // ============ 变更1:BO3 仍限 bestOf 张 ============
    r = await req('POST', '/api/rooms', { name: 'BO3限张房', matchType: 'custom' })
    const bo3RoomId = r.data.id
    r = await req('POST', `/api/rooms/${bo3RoomId}/config`, { overtimeEnabled: false })
    r = await req('POST', `/api/rooms/${bo3RoomId}/config`, { bestOf: 3, overtimeEnabled: false })
    check('同时升级 BO3 与关闭加时被拒绝', r.status === 400)
    r = await req('POST', `/api/rooms/${bo3RoomId}/config`, { bestOf: 3 })
    check('BO1 关闭加时后升级 BO3 自动开启', r.status === 200 && r.data.overtimeEnabled === true)
    r = await req('POST', `/api/rooms/${bo3RoomId}/config`, { overtimeEnabled: false })
    check('BO3 房间不能关闭加时', r.status === 400 && /BO3/.test(r.data.error))
    r = await req('GET', `/api/rooms/${bo3RoomId}`)
    check('关闭失败后 BO3 加时仍开启', r.data.bestOf === 3 && r.data.overtimeEnabled === true)
    r = await req('POST', `/api/rooms/${bo3RoomId}/config`, { bestOf: 3, pickMode: 'direct', teamA: 1, teamB: 1 })
    for (const mapId of ['de_mirage', 'de_inferno', 'de_nuke']) {
      r = await req('POST', `/api/rooms/${bo3RoomId}/directpick`, { mapId })
      check(`BO3 pick ${mapId} ok`, r.status === 200)
    }
    r = await req('POST', `/api/rooms/${bo3RoomId}/directpick`, { mapId: 'de_dust2' })
    check('BO3 4th pick rejected (limit bestOf)', r.status === 409, JSON.stringify(r.data))
    // 原为 DELETE bo3bpRoomId(上一块的房间)—— BO3限张房 从未删除,单房间守卫上线后会让后续建房 409
    await req('DELETE', `/api/rooms/${bo3RoomId}`, {})

    // ============ 缺失-1:BP 超时自动操作 ============
    const VETO_T = Number(process.env.SMOKE_VETO_TIMEOUT_MS || 2500)
    r = await req('POST', '/api/rooms', { name: '超时自动房', matchType: 'custom' })
    const autoRoomId = r.data.id
    r = await req('POST', `/api/rooms/${autoRoomId}/veto/start`, {})
    check('auto room veto start', r.status === 200 && r.data.vetoDeadlineAt > Date.now())
    await sleep(VETO_T + 2500)
    r = await req('GET', `/api/rooms/${autoRoomId}/status`, null)
    const autoRoom = r.data.room
    check(
      'auto ban performed after timeout',
      autoRoom.status === 'vetoing' && autoRoom.vetoHistory.length >= 1 && autoRoom.vetoTurn >= 1,
      JSON.stringify({ status: autoRoom.status, history: autoRoom.vetoHistory.length, turn: autoRoom.vetoTurn }),
    )
    check('auto action is ban (first phase)', autoRoom.vetoHistory[0]?.type === 'ban')
    await req('DELETE', `/api/rooms/${autoRoomId}`, {})

    // ============ 管理员面板:鉴权收紧 ============
    cookie = guestCookie
    r = await req('POST', '/api/instances/main/start', {})
    check('instance op rejected for non-admin (403)', r.status === 403)
    r = await req('POST', '/api/instances/reset', {})
    check('global reset rejected for non-admin (403)', r.status === 403)
    r = await req('GET', '/api/debug/ps', null)
    check('debug ps rejected for non-admin (403)', r.status === 403)
    r = await req('GET', '/api/debug/probe?url=http%3A%2F%2F127.0.0.1%3A8099', null)
    check('debug probe rejected for non-admin (403)', r.status === 403)

    // 管理员:实例启停/单实例重置
    cookie = ''
    r = await req('POST', '/api/auth/login', { steamId: ADMIN, password: 'admin123', name: 'AdminTest' })
    const adminCookie = cookie
    r = await req('POST', '/api/instances/match1/start', {})
    check('admin instance start ok', r.status === 200, JSON.stringify(r.data))
    r = await req('POST', '/api/instances/match1/reset', {})
    check('admin per-instance reset ok', r.status === 200 && r.data.instance.state === 'idle')
    r = await req('POST', '/api/instances/match1/stop', {})
    check('admin instance stop ok', r.status === 200)
    r = await req('POST', '/api/instances/nonexist/reset', {})
    check('per-instance reset 404', r.status === 404)
    r = await req('GET', '/api/debug/ps', null)
    check('admin debug ps ok', r.status === 200)

    // ============ 管理员面板:服务器组 CRUD ============
    r = await req('GET', '/api/game-servers', null)
    check('game-servers list admin ok', r.status === 200 && r.data.length === 1 && r.data[0].bridgeMode === 'http' && typeof r.data[0].connected === 'boolean')
    cookie = guestCookie
    r = await req('GET', '/api/game-servers', null)
    check('game-servers list rejected for non-admin', r.status === 403)
    cookie = adminCookie
    // bridge_token 唯一性:与 g1 相同 token 应 409
    r = await req('POST', '/api/game-servers', {
      name: '重复token组', hostIp: '192.0.2.212', region: 'cn-east',
      bridgeUrl: 'http://192.0.2.212:3001', bridgeToken: 'replace-this-before-use', bridgeMode: 'http',
      instances: [{ name: 'dup1', port: 28001 }],
    })
    check('game-servers duplicate token rejected (409)', r.status === 409, JSON.stringify(r.data))
    r = await req('POST', '/api/game-servers', {
      name: '服务器组-2', hostIp: '192.0.2.212', region: 'cn-east',
      bridgeUrl: 'http://192.0.2.212:3001', bridgeToken: 'token-2', bridgeMode: 'http',
      instances: [{ name: 'srv2a', port: 28001 }, { name: 'srv2b', port: 28002 }],
    })
    check('game-servers create ok', r.status === 201 && r.data.id === 'g2' && r.data.instances.length === 2, JSON.stringify(r.data))
    r = await req('POST', '/api/game-servers', {
      name: 'X', hostIp: '1.1.1.1', region: 'x', bridgeUrl: 'http://1.1.1.1:3001',
      bridgeToken: 't', bridgeMode: 'stub', instances: [{ name: 'y', port: 1 }],
    })
    check('game-servers bridgeMode stub rejected', r.status === 400)
    // PUT 换 token 与其他组冲突 → 409
    r = await req('PUT', '/api/game-servers/g2', {
      name: '服务器组-2改', hostIp: '192.0.2.213', region: 'cn-east',
      bridgeUrl: 'http://192.0.2.213:3001', bridgeToken: 'replace-this-before-use',
      instances: [{ name: 'srv2c', port: 28003 }],
    })
    check('game-servers update duplicate token rejected (409)', r.status === 409, JSON.stringify(r.data))
    r = await req('PUT', '/api/game-servers/g2', {
      name: '服务器组-2改', hostIp: '192.0.2.213', region: 'cn-east',
      bridgeUrl: 'http://192.0.2.213:3001', bridgeToken: 'token-2-new',
      instances: [{ name: 'srv2c', port: 28003 }],
    })
    check('game-servers update ok (instances replaced)', r.status === 200 && r.data.name === '服务器组-2改' && r.data.instances.length === 1 && r.data.instances[0].name === 'srv2c')
    // 幽灵实例回归(前置修复:cacheInstances 先清后填):整体替换清单后,被移除的实例名
    // 不得再出现在 /api/instances(否则仍会被自动分配/展示;实例可分配状态约定)
    r = await req('GET', '/api/instances', null)
    {
      const names = r.data.map((i) => i.name)
      check('group edit prunes removed instances from cache', names.includes('srv2c') && !names.includes('srv2a') && !names.includes('srv2b'), names.join(','))
    }

    // ---- M5 迁移 + 前置修复 B:idx/来源列 + 清单差量更新 ----
    r = await req('GET', '/api/game-servers', null)
    {
      const g1 = r.data.find((g) => g.id === 'g1')
      const g2 = r.data.find((g) => g.id === 'g2')
      check(
        'game-servers exposes idx/source per instance (M5 migration)',
        g1.instances.map((i) => i.idx).join(',') === '1,2,3,4' &&
          g1.instances.every((i) => i.source === 'seed' && i.provisionState === null) &&
          g2.instances.length === 1 &&
          g2.instances[0].idx === 3 &&
          g2.instances[0].source === 'panel',
        JSON.stringify({ g1: g1.instances, g2: g2.instances }),
      )
    }
    r = await req('GET', '/api/instances', null)
    {
      const main = r.data.find((i) => i.name === 'main')
      check('instances expose idx/source/provisionState', main?.idx === 1 && main?.source === 'seed' && main?.provisionState === null, JSON.stringify(main))
      // 面板卡片副标题用:所属组 + GOTV 端口(主机约定 = 端口 + 100)
      check(
        'instances expose gameServerId/gotvPort',
        main?.gameServerId === 'g1' && main?.gotvPort === 27115 && main?.port === 27015,
        JSON.stringify(main),
      )
    }
    const { DatabaseSync: SdbM5 } = await import('node:sqlite')
    const sdbM5 = new SdbM5(path.join(STUB_DIR, 'arena.db'))
    // 差量更新:实例锁(in_match)与编号必须原样保留(旧"整表删+重插"会抹成 idle/重置列)
    sdbM5.prepare("UPDATE instances SET state = 'in_match' WHERE name = 'srv2c'").run()
    r = await req('PUT', '/api/game-servers/g2', {
      name: '服务器组-2改', hostIp: '192.0.2.213', region: 'cn-east',
      bridgeUrl: 'http://192.0.2.213:3001', bridgeToken: 'token-2-new',
      instances: [{ name: 'srv2c', port: 28003 }],
    })
    {
      const row = sdbM5.prepare("SELECT state, idx, source FROM instances WHERE name = 'srv2c'").get()
      check('group edit preserves instance lock/idx/source', r.status === 200 && row.state === 'in_match' && row.idx === 3 && row.source === 'panel', JSON.stringify(row))
    }
    // 差量更新:移除"使用中"的实例必须 409(防把在用实例悄悄摘掉)
    r = await req('PUT', '/api/game-servers/g2', {
      name: '服务器组-2改', hostIp: '192.0.2.213', region: 'cn-east',
      bridgeUrl: 'http://192.0.2.213:3001', bridgeToken: 'token-2-new',
      instances: [],
    })
    check('group edit removing busy instance rejected (409)', r.status === 409, JSON.stringify(r.data))
    sdbM5.prepare("UPDATE instances SET state = 'idle' WHERE name = 'srv2c'").run()
    r = await req('PUT', '/api/game-servers/g2', {
      name: '服务器组-2改', hostIp: '192.0.2.213', region: 'cn-east',
      bridgeUrl: 'http://192.0.2.213:3001', bridgeToken: 'token-2-new',
      instances: [{ name: 'srv2c', port: 28003 }],
    })
    check('group edit keeps instance after lock released', r.status === 200 && r.data.instances.length === 1 && r.data.instances[0].name === 'srv2c')
    // 2026-09-23:面板「编辑服务器组」不再维护实例列表 —— **不提供 instances 字段时必须完全不动实例表**
    r = await req('PUT', '/api/game-servers/g2', {
      name: '服务器组-2改', hostIp: '192.0.2.213', region: '华南',
      bridgeUrl: 'http://192.0.2.213:3001', bridgeToken: 'token-2-new',
    })
    check(
      'group edit without instances keeps instances (不删行)',
      r.status === 200 && r.data.instances.length === 1 && r.data.instances[0].name === 'srv2c' && r.data.region === '华南',
      JSON.stringify({ n: r.data?.instances?.length, region: r.data?.region }),
    )
    check('区域为自由文本(输入什么存什么)', r.data.region === '华南')
    // 供给中(待确认)实例:服务器状态显示为不可用 + 徽章字段;手动选择/自动分配由后端守卫拒绝
    sdbM5.prepare("UPDATE instances SET provision_state = 'unconfirmed' WHERE name = 'srv2c'").run()
    r = await req('GET', '/api/servers/status', null)
    {
      const entry = (r.data.find((g) => g.groupId === 'g2')?.servers || []).find((s) => s.name === 'srv2c')
      check('unconfirmed instance not allocatable in servers status', entry?.status === 'unknown' && entry?.provisionState === 'unconfirmed', JSON.stringify(entry))
    }
    sdbM5.prepare('UPDATE instances SET provision_state = NULL WHERE name = ?').run('srv2c')
    r = await req('POST', '/api/game-servers/g2/deactivate', {})
    check('game-servers deactivate ok', r.status === 200 && r.data.isActive === false)
    r = await req('GET', '/api/servers/status', null)
    check('deactivated group excluded from servers status', r.data.length === 1 && r.data[0].groupId === 'g1')
    r = await req('POST', '/api/game-servers/g2/activate', {})
    check('game-servers activate ok', r.status === 200 && r.data.isActive === true)

    // 主机概况 stub 夹具:多组时每张卡片只显示**本组**实例(前端反馈的"多组串同一份清单";真机 reverse 无此问题)
    if (process.env.SMOKE_BRIDGE_MODE !== 'reverse' && !process.env.BRIDGE_BIN) {
      const multi = await req('GET', '/api/host/status?refresh=1')
      const groups = multi.data?.groups || []
      const cardG1 = groups.find((x) => x.groupId === 'g1') || {}
      const cardG2 = groups.find((x) => x.groupId === 'g2') || {}
      const namesG1 = (cardG1.instances || []).map((i) => i.name).sort().join(',')
      const namesG2 = (cardG2.instances || []).map((i) => i.name).sort().join(',')
      check(
        'host status stub instances are per-group (+ instancesSource=backend)',
        multi.status === 200 && namesG1 === 'main,match1,match2,match3' && namesG2 === 'srv2c' &&
          cardG1.instancesSource === 'backend' && cardG2.instancesSource === 'backend',
        JSON.stringify({ g1: namesG1, g2: namesG2, src: [cardG1.instancesSource, cardG2.instancesSource] }),
      )
    }

    // ---- 任务框架与按组维护(任务框架与按组维护用例)------------------
    {
      const saved = cookie
      cookie = ''
      const anonJobs = await req('GET', '/api/jobs')
      check('jobs api 401 without login', anonJobs.status === 401)
      const anonUpdate = await req('POST', '/api/host/game-update', { groupId: 'g1', confirm: 'UPDATE' })
      check('game-update 401 without login', anonUpdate.status === 401)
      cookie = saved

      // 二次确认与参数校验(在占任何资源之前)
      const noConfirm = await req('POST', '/api/host/game-update', { groupId: 'g1' })
      check('game-update requires confirm="UPDATE"', noConfirm.status === 400, JSON.stringify(noConfirm.data))
      const badGroup = await req('POST', '/api/host/game-update', { groupId: 'nope', confirm: 'UPDATE' })
      check('game-update unknown group 404', badGroup.status === 404, JSON.stringify(badGroup.data))

      // 手动维护开关(平台权威;不依赖桥)
      let m = await req('POST', '/api/host/maintenance', { groupId: 'g2', enabled: true, reason: 'smoke 维护' })
      check('host maintenance on ok', m.status === 200 && m.data.maintenance?.enabled === true, JSON.stringify(m.data))
      const health = await req('GET', '/api/health')
      check('health exposes maintenance', Array.isArray(health.data.maintenance) && health.data.maintenance.some((x) => x.groupId === 'g2'))

      // 该组维护:组内实例启停/重启一律拒绝;他组不受影响
      const startG2 = await req('POST', '/api/instances/srv2c/start', {})
      check('maintenance blocks start in that group (409)', startG2.status === 409, JSON.stringify(startG2.data))
      const stopG2 = await req('POST', '/api/instances/srv2c/stop', {})
      check('maintenance blocks stop in that group (409)', stopG2.status === 409, JSON.stringify(stopG2.data))
      const startG1 = await req('POST', '/api/instances/main/start', {})
      check('maintenance of another group does not affect this group', startG1.status !== 409, JSON.stringify(startG1.data))
      await req('POST', '/api/instances/main/stop', {})

      // 该组维护:自动分配跳过该组(pickFree 只挑非维护组)
      const pick = await req('GET', '/api/instances')
      check('instances list reachable during maintenance', pick.status === 200)

      // 关掉手动维护 → 恢复
      m = await req('POST', '/api/host/maintenance', { groupId: 'g2', enabled: false })
      check('host maintenance off ok', m.status === 200 && m.data.maintenance?.enabled === false)
      const healthOff = await req('GET', '/api/health')
      check('health maintenance cleared', !(healthOff.data.maintenance || []).some((x) => x.groupId === 'g2'))

      // stub 侧的更新任务闭环:202 → 进度推进 → 终态 → 维护自动清除
      if (process.env.SMOKE_BRIDGE_MODE !== 'reverse' && !process.env.BRIDGE_BIN) {
        const up = await req('POST', '/api/host/game-update', { groupId: 'g2', confirm: 'UPDATE' })
        check(
          'game-update starts job + per-group maintenance (stub)',
          up.status === 202 && up.data.job?.kind === 'game_update' && up.data.job.status === 'running' &&
            up.data.maintenance?.enabled === true,
          JSON.stringify(up.data),
        )
        const jobId = up.data.job?.id
        // 维护中:该组实例启停仍被拒
        const blocked = await req('POST', '/api/instances/srv2c/start', {})
        check('updating group blocks instance start (409)', blocked.status === 409, JSON.stringify(blocked.data))
        // 进度推进(poller 回源 stub job_status)
        let progressed = false
        for (let i = 0; i < 40; i++) {
          await sleep(Number(process.env.STUB_UPDATE_MS || 400))
          const cur = await req('GET', `/api/jobs/${jobId}`)
          if (cur.data?.job?.progress > 0) progressed = true
          if (cur.data?.job?.status === 'done') break
        }
        const fin = await req('GET', `/api/jobs/${jobId}`)
        check(
          'stub job progresses and finishes (done)',
          progressed && fin.data?.job?.status === 'done' && fin.data.job.progress === 100,
          JSON.stringify(fin.data?.job),
        )
        const list = await req('GET', '/api/jobs?limit=5')
        check('jobs list contains the update job', list.status === 200 && (list.data.jobs || []).some((j) => j.id === jobId && j.origin === 'panel'))
        const log = await req('GET', `/api/jobs/${jobId}?lines=50`)
        check('job log readable', log.status === 200 && Array.isArray(log.data.lines) && log.data.lines.length > 0, JSON.stringify(log.data).slice(0, 200))
        const healthAfter = await req('GET', '/api/health')
        check('maintenance auto-cleared when job done', !(healthAfter.data.maintenance || []).some((x) => x.groupId === 'g2'))
        const cancelledAlready = await req('POST', `/api/jobs/${jobId}/cancel`, {})
        check('cancel of finished job 409', cancelledAlready.status === 409)
      } else if (process.env.BRIDGE_BIN) {
        // v2 二进制桥:声明了 jobs 能力 → 任务真的下发。**走 g1**(桥按 server_id=g1 连上来;
        // 用 g2 只会命中"桥未连接",等于没测到真桥 —— 2026-09-22 修正,与 M6 的 demo/cleanup 用例同口径)。
        // CI 无 msm 布局:stub msm / 磁盘余量前置检查会让任务很快失败,属预期。
        const notConnected = await req('POST', '/api/host/game-update', { groupId: 'g2', confirm: 'UPDATE' })
        check(
          'game-update on a group without bridge → 502 (not connected)',
          notConnected.status === 502 && /未连接/.test(String(notConnected.data.error)),
          JSON.stringify(notConnected.data),
        )
        const up = await req('POST', '/api/host/game-update', { groupId: 'g1', confirm: 'UPDATE' })
        check('game-update reaches v2 bridge (202 or clean failure)', [202, 502].includes(up.status), JSON.stringify(up.data).slice(0, 200))
        if (up.status === 202) {
          let st = null
          for (let i = 0; i < 60; i++) {
            await sleep(500)
            const cur = await req('GET', `/api/jobs/${up.data.job.id}?refresh=1`)
            st = cur.data?.job?.status
            if (st === 'done' || st === 'failed' || st === 'cancelled') break
          }
          check('v2 bridge job reaches a terminal state', ['done', 'failed', 'cancelled'].includes(st), `status=${st}`)
          const h = await req('GET', '/api/health')
          check('maintenance cleared after v2 job terminal', !(h.data.maintenance || []).some((x) => x.groupId === 'g2'))
        }
      } else {
        // 旧 Python 桥:未声明 jobs 能力 → 502 + 升级指引(不 5xx 其它路径)
        const up = await req('POST', '/api/host/game-update', { groupId: 'g2', confirm: 'UPDATE' })
        check(
          'game-update against incapable bridge → 502 with hint',
          up.status === 502 && typeof up.data.error === 'string',
          JSON.stringify(up.data),
        )
      }
      // 清理:本块可能真启过实例,别把状态留给后续用例
      await req('POST', '/api/instances/srv2c/stop', {})
      await req('POST', '/api/instances/main/stop', {})
    }

    // ============ M6:录像归集 / 主机清理的面板入口 ============
    {
      // 权限(匿名 → 401;cookie 技巧与 M4 任务用例同款)
      const savedCookie = cookie
      cookie = ''
      const anonDemo = await req('POST', '/api/host/demo-collect', { groupId: 'g2', all: true })
      check('demo-collect 401 without login', anonDemo.status === 401)
      const anonClean = await req('POST', '/api/host/cleanup', { groupId: 'g2', patterns: ['backup:old'] })
      check('host cleanup 401 without login', anonClean.status === 401)
      cookie = savedCookie

      // 参数校验(在占任何资源之前;400 优先于组忙碌判定)
      const demoNoTarget = await req('POST', '/api/host/demo-collect', { groupId: 'g2' })
      check('demo-collect requires matchId or all (400)', demoNoTarget.status === 400, JSON.stringify(demoNoTarget.data))
      const demoNoGroup = await req('POST', '/api/host/demo-collect', { all: true })
      check('demo-collect without group 400', demoNoGroup.status === 400)
      const cleanBadPattern = await req('POST', '/api/host/cleanup', { groupId: 'g2', patterns: ['rm-rf'] })
      check('host cleanup rejects non-whitelist pattern (400)', cleanBadPattern.status === 400, JSON.stringify(cleanBadPattern.data))
      const cleanNoPattern = await req('POST', '/api/host/cleanup', { groupId: 'g2', patterns: [] })
      check('host cleanup without patterns 400', cleanNoPattern.status === 400)
      const cleanNoConfirm = await req('POST', '/api/host/cleanup', { groupId: 'g2', patterns: ['backup:old'], dryRun: false })
      check(
        'host cleanup real delete requires confirm="CLEAN" (400)',
        cleanNoConfirm.status === 400 && /CLEAN/.test(String(cleanNoConfirm.data.error)),
        JSON.stringify(cleanNoConfirm.data),
      )
      const cleanUnknownGroup = await req('POST', '/api/host/cleanup', { groupId: 'nope', patterns: ['backup:old'] })
      check('host cleanup unknown group 404', cleanUnknownGroup.status === 404)

      if (process.env.SMOKE_BRIDGE_MODE !== 'reverse' && !process.env.BRIDGE_BIN) {
        // 归集:默认 dry-run → 202 + 假任务;终态结果 dryRun=true 且 moved 为空(只预览不搬家)
        const demo = await req('POST', '/api/host/demo-collect', { groupId: 'g2', all: true })
        check(
          'demo-collect starts job, dry-run by default (stub)',
          demo.status === 202 && demo.data.job?.kind === 'demo_collect' && demo.data.job.status === 'running' && demo.data.dryRun === true,
          JSON.stringify(demo.data),
        )
        const demoId = demo.data.job?.id
        // 归集不开维护(与更新任务不同):任务在跑也不锁这组实例
        const hRunning = await req('GET', '/api/health')
        check('demo-collect does not open maintenance', !(hRunning.data.maintenance || []).some((x) => x.groupId === 'g2'))
        // 组内已有进行中任务 → 第二个任务被拒
        const busy = await req('POST', '/api/host/cleanup', { groupId: 'g2', patterns: ['backup:old'] })
        check('second job in same group rejected (409)', busy.status === 409, JSON.stringify(busy.data))
        let demoDone = null
        for (let i = 0; i < 40; i++) {
          await sleep(Number(process.env.STUB_UPDATE_MS || 400))
          const cur = await req('GET', `/api/jobs/${demoId}`)
          if (cur.data?.job?.status === 'done') { demoDone = cur.data.job; break }
        }
        check(
          'demo-collect reaches done with dry-run result (stub)',
          demoDone?.progress === 100 && demoDone?.result?.dryRun === true &&
            Array.isArray(demoDone?.result?.moved) && demoDone.result.moved.length === 0,
          JSON.stringify(demoDone),
        )

        // 清理:默认 dry-run;终态 items 按 patterns 展开
        const dry = await req('POST', '/api/host/cleanup', { groupId: 'g2', patterns: ['backup:old', 'logs:rotate'] })
        check('host cleanup dry-run by default (stub)', dry.status === 202 && dry.data.dryRun === true, JSON.stringify(dry.data))
        let dryDone = null
        for (let i = 0; i < 40; i++) {
          await sleep(Number(process.env.STUB_UPDATE_MS || 400))
          const cur = await req('GET', `/api/jobs/${dry.data.job.id}`)
          if (cur.data?.job?.status === 'done') { dryDone = cur.data.job; break }
        }
        check(
          'host cleanup dry-run result lists whitelisted items (stub)',
          dryDone?.result?.dryRun === true && (dryDone?.result?.items || []).length === 2 && dryDone.result.totalBytes > 0,
          JSON.stringify(dryDone?.result),
        )
        const real = await req('POST', '/api/host/cleanup', { groupId: 'g2', patterns: ['backup:old'], dryRun: false, confirm: 'CLEAN' })
        check('host cleanup real delete accepted with CLEAN (stub)', real.status === 202 && real.data.dryRun === false, JSON.stringify(real.data))
        let realDone = null
        for (let i = 0; i < 40; i++) {
          await sleep(Number(process.env.STUB_UPDATE_MS || 400))
          const cur = await req('GET', `/api/jobs/${real.data.job.id}`)
          if (cur.data?.job?.status === 'done') { realDone = cur.data.job; break }
        }
        check('host cleanup real delete result marked dryRun=false (stub)', realDone?.result?.dryRun === false, JSON.stringify(realDone?.result))
      } else if (process.env.BRIDGE_BIN) {
        // v2 二进制桥:**走 g1**(二进制桥按 server_id=g1 连上来;用 g2 会只命中"桥未连接",
        // 等于没测到真桥)。两个任务都只跑 dry-run —— 绝不在跑 smoke 的机器上真删文件。
        const notConnected = await req('POST', '/api/host/demo-collect', { groupId: 'g2', all: true })
        check(
          'demo-collect on a group without bridge → 502 (not connected)',
          notConnected.status === 502 && /未连接/.test(String(notConnected.data.error)),
          JSON.stringify(notConnected.data),
        )

        const demo = await req('POST', '/api/host/demo-collect', { groupId: 'g1', all: true })
        check('demo-collect reaches v2 bridge (202 or clean failure)', [202, 502].includes(demo.status), JSON.stringify(demo.data).slice(0, 200))
        if (demo.status === 202) {
          let st = null
          for (let i = 0; i < 60; i++) {
            await sleep(500)
            const cur = await req('GET', `/api/jobs/${demo.data.job.id}?refresh=1`)
            st = cur.data?.job?.status
            if (['done', 'failed', 'cancelled'].includes(st)) break
          }
          check('v2 demo-collect job reaches a terminal state', ['done', 'failed', 'cancelled'].includes(st), `status=${st}`)
        }
        // logs:rotate 不依赖"备份目录存在"(机器上通常没有 ~/backup),适合在 CI 上跑 dry-run
        const clean = await req('POST', '/api/host/cleanup', { groupId: 'g1', patterns: ['logs:rotate'], maxAgeDays: 30 })
        check('host cleanup (dry-run) reaches v2 bridge (202 or clean failure)', [202, 502].includes(clean.status), JSON.stringify(clean.data).slice(0, 200))
        if (clean.status === 202) {
          let st = null
          for (let i = 0; i < 60; i++) {
            await sleep(500)
            const cur = await req('GET', `/api/jobs/${clean.data.job.id}?refresh=1`)
            st = cur.data?.job?.status
            if (['done', 'failed', 'cancelled'].includes(st)) break
          }
          check('v2 cleanup job reaches a terminal state', ['done', 'failed', 'cancelled'].includes(st), `status=${st}`)
        }
      } else {
        // 旧 Python 桥:未声明 jobs 能力 → 502 + 升级指引(g1 才有旧桥,用 g2 只会命中"未连接")
        const demo = await req('POST', '/api/host/demo-collect', { groupId: 'g1', all: true })
        check(
          'demo-collect against incapable bridge → 502 with hint',
          demo.status === 502 && typeof demo.data.error === 'string',
          JSON.stringify(demo.data),
        )
        const clean = await req('POST', '/api/host/cleanup', { groupId: 'g1', patterns: ['backup:old'] })
        check(
          'host cleanup against incapable bridge → 502 with hint',
          clean.status === 502 && typeof clean.data.error === 'string',
          JSON.stringify(clean.data),
        )
      }

      // ---- 录像定期归档:设置接口(与桥模式无关) ----
      {
        const saved = cookie
        cookie = ''
        const anonGet = await req('GET', '/api/settings/demo-archive')
        check('demo-archive settings 401 without login', anonGet.status === 401)
        const anonPut = await req('PUT', '/api/settings/demo-archive', { hour: 1 })
        check('demo-archive settings PUT 401 without login', anonPut.status === 401)
        cookie = saved

        const cfg = await req('GET', '/api/settings/demo-archive')
        check(
          'demo-archive settings shape',
          cfg.status === 200 && typeof cfg.data.enabled === 'boolean' && Number.isInteger(cfg.data.hour) && 'lastRun' in cfg.data,
          JSON.stringify(cfg.data),
        )
        const badHour = await req('PUT', '/api/settings/demo-archive', { hour: 25 })
        check('demo-archive hour out of range 400', badHour.status === 400, JSON.stringify(badHour.data))
        const badHour2 = await req('PUT', '/api/settings/demo-archive', { hour: 'x' })
        check('demo-archive hour non-numeric 400', badHour2.status === 400)
        const setHour = await req('PUT', '/api/settings/demo-archive', { hour: 3 })
        check('demo-archive hour saved', setHour.status === 200 && setHour.data.hour === 3, JSON.stringify(setHour.data))
        const disabled = await req('PUT', '/api/settings/demo-archive', { enabled: false })
        check(
          'demo-archive disable keeps hour',
          disabled.status === 200 && disabled.data.enabled === false && disabled.data.hour === 3,
          JSON.stringify(disabled.data),
        )
        const restored = await req('PUT', '/api/settings/demo-archive', { enabled: true, hour: 5 })
        check('demo-archive restore default', restored.status === 200 && restored.data.enabled === true && restored.data.hour === 5)

        // 立即归档(手动,仅管理员):stub 下逐组下发 demo_collect(全量、真搬)
        const anonRun = await (async () => {
          const saved2 = cookie
          cookie = ''
          const r = await req('POST', '/api/settings/demo-archive/run', {})
          cookie = saved2
          return r
        })()
        check('demo-archive run 401 without login', anonRun.status === 401)
        const run = await req('POST', '/api/settings/demo-archive/run', {})
        const bridgeCanJobs = !process.env.SMOKE_BRIDGE_MODE || process.env.SMOKE_BRIDGE_MODE !== 'reverse'
        if (bridgeCanJobs || process.env.BRIDGE_BIN) {
          // stub(假任务)/ v2 二进制桥(真任务):都应下发成功
          check(
            'demo-archive run starts demo_collect jobs',
            run.status === 200 && run.data.started >= 1 &&
              run.data.jobs.every(
                (j) => j.kind === 'demo_collect' && j.params?.all === true && j.params?.dryRun === false && j.origin === 'panel',
              ),
            JSON.stringify(run.data).slice(0, 300),
          )
        } else {
          // 旧 Python 桥(未声明 jobs 能力):逐组干净降级,给出原因,不 5xx
          check(
            'demo-archive run degrades cleanly without jobs capability',
            run.status === 200 && run.data.started === 0 &&
              run.data.skipped.length > 0 && run.data.skipped.every((s) => typeof s.reason === 'string'),
            JSON.stringify(run.data).slice(0, 300),
          )
        }
      }
    }

    // ============ M6:录像定期归档调度器(隔离实例:独立端口/DB/stub 目录,自己控制 tick) ============
    // 主用例的调度器是关的(DEMO_ARCHIVE=off);这里端到端验证:关闭时不跑 → 打开后到点跑 →
    // 当天只自动跑一次 → 组忙时手动「立即归档」跳过并给原因。
    if (process.env.SMOKE_BRIDGE_MODE !== 'reverse' && !process.env.BRIDGE_BIN) {
      const srvPort = 8092
      const srvBase = `http://127.0.0.1:${srvPort}`
      const srvStub = mkdtempSync(path.join(tmpdir(), 'arena-da-'))
      const daAdmin = '76561199000000009'
      const srv = spawn('node', ['server.js'], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(srvPort),
          PUBLIC_BASE_URL: srvBase,
          DB_PATH: path.join(srvStub, 'arena.db'),
          BRIDGE_MODE: 'stub',
          ARENA_STUB_DIR: srvStub,
          ADMIN_STEAM_IDS: daAdmin, // 独立管理员号,避免与主用例后端抢 admin 流程
          STEAM_PROXY: '',
          STUB_UPDATE_MS: '2500', // 任务慢一点(2.5s/步),便于稳定断言"组忙 → 跳过"
          DEMO_ARCHIVE_TICK_MS: '700', // 调度器加速巡检
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let srvLog = ''
      srv.stdout.on('data', (d) => { srvLog += d.toString() })
      srv.stderr.on('data', (d) => { srvLog += d.toString() })
      let srvCookie = ''
      const sreq = async (method, url, body) => {
        const res = await fetch(`${srvBase}${url}`, {
          method,
          headers: { 'content-type': 'application/json', ...(srvCookie ? { cookie: srvCookie } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        })
        const text = await res.text()
        const data = text ? JSON.parse(text) : null
        const sc = res.headers.get('set-cookie')
        if (sc) srvCookie = sc.split(';')[0]
        return { status: res.status, data }
      }
      try {
        let up = false
        for (let i = 0; i < 40; i++) {
          try {
            const r = await fetch(`${srvBase}/api/health`)
            if (r.ok) { up = true; break }
          } catch {}
          await sleep(250)
        }
        check('demo-archive: 隔离后端就绪', up, srvLog.slice(-200))
        await sreq('POST', '/api/auth/set-password', { steamId: daAdmin, password: 'smoke-admin-pass' })
        const daLogin = await sreq('POST', '/api/auth/login', { steamId: daAdmin, name: 'DAAdmin', password: 'smoke-admin-pass' })
        check('demo-archive: 管理员登录', daLogin.status === 200, JSON.stringify(daLogin.data))

        // 默认归档时间可能已过:隔离后端在管理员登录期间就会先发一份 schedule 任务。
        // 先关掉巡检并等这份启动任务结束,再开启本轮测试,避免它占住组或污染计数。
        const archiveHour = new Date().getHours()
        await sreq('PUT', '/api/settings/demo-archive', { enabled: false, hour: (archiveHour + 1) % 24 })
        await sleep(800)
        let priorScheduled = []
        for (let i = 0; i < 40; i++) {
          const jobs = await sreq('GET', '/api/jobs')
          priorScheduled = (jobs.data?.jobs ?? []).filter((j) => j.origin === 'schedule')
          if (priorScheduled.every((j) => ['done', 'failed', 'cancelled'].includes(j.status))) break
          await sleep(500)
        }
        const priorScheduledIds = new Set(priorScheduled.map((j) => j.id))

        // ① 先显式把执行时刻设为**当前小时**(默认 hour=5 只有在本地时间 ≥5 点时才"到点"),
        //    否则跨零点跑 smoke 会整段失败(2026-09-23 实测:00:xx 时 bootJobs 恒为空)
        await sreq('PUT', '/api/settings/demo-archive', { enabled: true, hour: archiveHour })
        // 到点(当前小时)→ 首次巡检自动跑一次并记 lastRun
        let bootJobs = []
        for (let i = 0; i < 24; i++) {
          await sleep(700)
          const jobs = await sreq('GET', '/api/jobs')
          bootJobs = (jobs.data?.jobs ?? []).filter((j) => j.origin === 'schedule' && !priorScheduledIds.has(j.id))
          if (bootJobs.length > 0) break
        }
        const nowD = new Date()
        const dayKey = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`
        // job 行先于异步 jobStart 回包和 lastRun 记账落库；等记账完成再继续，
        // 否则后续巡检可能把同一轮归档当成今天尚未执行而重复下发。
        let cfg1
        for (let i = 0; i < 20; i++) {
          cfg1 = await sreq('GET', '/api/settings/demo-archive')
          if (cfg1.data?.lastRun === dayKey) break
          await sleep(250)
        }
        check(
          'demo-archive: 首次启动到点自动下发(schedule)',
          bootJobs.length === 1 && bootJobs[0].kind === 'demo_collect' && bootJobs[0].params?.dryRun === false,
          JSON.stringify(bootJobs).slice(0, 300),
        )
        check('demo-archive: 执行后 lastRun 记为当天', cfg1.data?.lastRun === dayKey, JSON.stringify(cfg1.data))

        // 等首次那份 schedule 任务终态(否则下面的手动下发会命中"组忙")
        for (let i = 0; i < 40; i++) {
          const jobs = await sreq('GET', '/api/jobs')
          const j = (jobs.data?.jobs ?? []).find((x) => x.id === bootJobs[0]?.id)
          if (j && ['done', 'failed', 'cancelled'].includes(j.status)) break
          await sleep(500)
        }

        // ② 手动「立即归档」→ 下发;紧接着再发一次 → 组忙跳过并给原因
        const run1 = await sreq('POST', '/api/settings/demo-archive/run', {})
        check('demo-archive: 立即归档下发任务(panel)', run1.status === 200 && run1.data.started >= 1, JSON.stringify(run1.data).slice(0, 200))
        const busy = await sreq('POST', '/api/settings/demo-archive/run', {})
        check(
          'demo-archive: 组忙时立即归档跳过并给原因',
          busy.status === 200 && busy.data.started === 0 && busy.data.skipped.some((s) => /进行中任务/.test(s.reason)),
          JSON.stringify(busy.data).slice(0, 300),
        )

        // ③ 关闭开关(改时刻会清 lastRun,使"本应到点"成立)→ 到点也不跑(计数不增)
        const off = await sreq('PUT', '/api/settings/demo-archive', { enabled: false, hour: (new Date().getHours() + 1) % 24 })
        check('demo-archive: 关闭并改时刻(清 lastRun)', off.status === 200 && off.data.enabled === false && off.data.lastRun === null, JSON.stringify(off.data))
        await sleep(2200)
        const offJobs = await sreq('GET', '/api/jobs')
        const offScheduled = (offJobs.data?.jobs ?? []).filter((j) => j.origin === 'schedule' && !priorScheduledIds.has(j.id))
        check('demo-archive: 关闭时调度器不跑', offScheduled.length === 1, JSON.stringify(offJobs.data).slice(0, 200))

        // ④ 重新打开(再改回当前小时 → 又清 lastRun)→ 到点应再跑一次
        const on = await sreq('PUT', '/api/settings/demo-archive', { enabled: true, hour: new Date().getHours() })
        check('demo-archive: 重新打开并设当前小时', on.status === 200 && on.data.enabled === true && on.data.lastRun === null, JSON.stringify(on.data))
        let scheduled = offScheduled
        for (let i = 0; i < 24; i++) {
          await sleep(700)
          const jobs = await sreq('GET', '/api/jobs')
          scheduled = (jobs.data?.jobs ?? []).filter((j) => j.origin === 'schedule' && !priorScheduledIds.has(j.id))
          if (scheduled.length > 1) break
        }
        check(
          'demo-archive: 打开后到点自动再跑一次',
          scheduled.length === 2 && scheduled.every((j) => j.kind === 'demo_collect'),
          JSON.stringify(scheduled).slice(0, 300),
        )
        let cfg2
        for (let i = 0; i < 20; i++) {
          cfg2 = await sreq('GET', '/api/settings/demo-archive')
          if (cfg2.data?.lastRun === dayKey) break
          await sleep(250)
        }
        check('demo-archive: 再次执行后 lastRun 更新为当天', cfg2.data?.lastRun === dayKey, JSON.stringify(cfg2.data))

        // ⑤ 再等几个巡检周期:一天只自动跑一次
        await sleep(2400)
        const jobs2 = await sreq('GET', '/api/jobs')
        check(
          'demo-archive: 当天不重复自动执行',
          (jobs2.data?.jobs ?? []).filter((j) => j.origin === 'schedule' && !priorScheduledIds.has(j.id)).length === 2,
          JSON.stringify(jobs2.data?.jobs ?? []).slice(0, 200),
        )
      } finally {
        srv.kill('SIGTERM')
        await sleep(300)
        try { rmSync(srvStub, { recursive: true, force: true }) } catch {}
      }
    }

    // ============ M5:建/删实例(面板路径:实例行 + 任务 + 桥下发) ============
    {
      const badName = await req('POST', '/api/instances', { name: 'bad name!', gameServerId: 'g1' })
      check('create invalid name rejected (400)', badName.status === 400, JSON.stringify(badName.data))
      const noGroup = await req('POST', '/api/instances', { name: 'arena1' })
      check('create without group rejected (400)', noGroup.status === 400, JSON.stringify(noGroup.data))
      const unknownGroup = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'gx' })
      check('create unknown group 404', unknownGroup.status === 404, JSON.stringify(unknownGroup.data))
      const dup = await req('POST', '/api/instances', { name: 'main', gameServerId: 'g1' })
      check('create duplicate name 409', dup.status === 409, JSON.stringify(dup.data))
      // 提前校验:模板实例(cloneFrom)必须在同组、不能是自身;端口非法/冲突也在建任务前拦下
      const selfClone = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1', cloneFrom: 'arena1' })
      check('create cloneFrom self rejected (400)', selfClone.status === 400, JSON.stringify(selfClone.data))
      const badClone = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1', cloneFrom: 'nope-src' })
      check('create cloneFrom unknown rejected (404)', badClone.status === 404, JSON.stringify(badClone.data))
      const crossClone = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1', cloneFrom: 'srv2c' })
      check('create cloneFrom cross-group rejected (404)', crossClone.status === 404, JSON.stringify(crossClone.data))
      const badPort = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1', port: 'abc' })
      check('create invalid port rejected (400)', badPort.status === 400, JSON.stringify(badPort.data))
      const clashPort = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1', port: 27015 })
      check('create conflicting port rejected (409)', clashPort.status === 409, JSON.stringify(clashPort.data))
      const wrongConfirm = await req('DELETE', '/api/instances/srv2c', { confirm: 'wrong' })
      check('delete wrong confirm rejected (400)', wrongConfirm.status === 400, JSON.stringify(wrongConfirm.data))
      const del404 = await req('DELETE', '/api/instances/nope-inst', { confirm: 'nope-inst' })
      check('delete unknown instance 404', del404.status === 404)
      // 非管理员一律 403
      cookie = guestCookie
      const nonAdmin = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1' })
      check('create requires admin (403)', nonAdmin.status === 403)
      const nonAdminDel = await req('DELETE', '/api/instances/srv2c', { confirm: 'srv2c' })
      check('delete requires admin (403)', nonAdminDel.status === 403)
      cookie = adminCookie

      if (process.env.SMOKE_BRIDGE_MODE !== 'reverse' && !process.env.BRIDGE_BIN) {
        // stub:进程内假任务(7 步)推进 → 终态帧带 result → 实例行收敛为可分配。
        // 同时以管理员 admins 频道验证 instances:update 推送(面板不再只靠 5s 轮询兜底)。
        await withAdminsSocket(async ({ events }) => {
          const created = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1', cloneFrom: 'main', port: 27120 })
          check(
            'create starts provision job (201 + provisioning + task)',
            created.status === 201 && created.data.instance?.provisionState === 'creating' &&
              created.data.task?.kind === 'instance_create' && created.data.task?.status === 'running',
            JSON.stringify(created.data),
          )
          await sleep(200)
          const pushes = () => events.filter((e) => e.ev === 'instances:update').map((e) => e.data)
          check(
            'instances:update pushed on panel create',
            pushes().some((d) => (d.added || []).includes('arena1') || (d.updated || []).includes('arena1')),
            JSON.stringify(pushes()),
          )
          const jobId = created.data.task?.id
          // 供给中:服务器状态不可用 + 启停被拒
          const statusMid = await req('GET', '/api/servers/status', null)
          const mid = (statusMid.data.find((g) => g.groupId === 'g1')?.servers || []).find((x) => x.name === 'arena1')
          check('provisioning instance marked unavailable', mid?.status === 'unknown' && mid?.provisionState === 'creating', JSON.stringify(mid))
          const startMid = await req('POST', '/api/instances/arena1/start', {})
          check('provisioning instance cannot be started (409)', startMid.status === 409, JSON.stringify(startMid.data))
          // 推进到终态(poller 回源 stub job_status)
          let progressed = false
          for (let i = 0; i < 40; i++) {
            await sleep(Number(process.env.STUB_UPDATE_MS || 400))
            const cur = await req('GET', `/api/jobs/${jobId}`)
            if (cur.data?.job?.progress > 0) progressed = true
            if (cur.data?.job?.status === 'done') break
          }
          const inst = (await req('GET', '/api/instances', null)).data.find((i) => i.name === 'arena1')
          check(
            'created instance converged (progress + port/idx + allocatable)',
            progressed && !!inst && inst.provisionState === null && inst.port === 27120 && inst.gotvPort === 27220 &&
              inst.idx === 5 && inst.source === 'panel',
            JSON.stringify(inst),
          )
          check(
            'instances:update pushed on job convergence',
            pushes().some((d) => d.reason === 'job' && (d.updated || []).includes('arena1')),
            JSON.stringify(pushes()),
          )
          // 删除(面板路径;stub 假任务 4 步)→ 行消失
          const del = await req('DELETE', '/api/instances/arena1', { confirm: 'arena1' })
          check('delete starts provision job (ok + instance_delete)', del.status === 200 && del.data.task?.kind === 'instance_delete', JSON.stringify(del.data))
          let gone = false
          for (let i = 0; i < 30; i++) {
            await sleep(Number(process.env.STUB_UPDATE_MS || 400))
            const rows = (await req('GET', '/api/instances', null)).data
            if (!rows.some((x) => x.name === 'arena1')) {
              gone = true
              break
            }
          }
          check('deleted instance row removed (converged)', gone)
          check(
            'instances:update pushed on delete (panel + convergence)',
            pushes().some((d) => d.reason === 'panel_delete') && pushes().some((d) => d.reason === 'job' && (d.removed || []).includes('arena1')),
            JSON.stringify(pushes()),
          )
          // 失败路径(stub 夹具:名字以 fail 开头 → 在 msm clone 步失败)→ 预留行撤回,不留幽灵行
          const failCreate = await req('POST', '/api/instances', { name: 'failinst', gameServerId: 'g1' })
          check(
            'stub failing create starts job (201 + creating)',
            failCreate.status === 201 && failCreate.data.instance?.provisionState === 'creating',
            JSON.stringify(failCreate.data),
          )
          let failStatus = null
          for (let i = 0; i < 20; i++) {
            await sleep(Number(process.env.STUB_UPDATE_MS || 400))
            const cur = await req('GET', `/api/jobs/${failCreate.data.task.id}`)
            failStatus = cur.data?.job?.status
            if (['done', 'failed', 'cancelled'].includes(failStatus)) break
          }
          const failRows = (await req('GET', '/api/instances', null)).data
          check(
            'stub create failure withdraws reserved row (no phantom) + push',
            failStatus === 'failed' && !failRows.some((x) => x.name === 'failinst') &&
              pushes().some((d) => (d.removed || []).includes('failinst')),
            `status=${failStatus} rows=${JSON.stringify(failRows.filter((x) => x.name === 'failinst'))}`,
          )
        }, { cookie: adminCookie })
      } else if (process.env.BRIDGE_BIN) {
        // v2 二进制桥:任务真下发。CI 夹具的 msm 布局不完整(msm clone 必失败)→ 要求"干净失败":
        // 预留行被撤回(不留幽灵实例)、任务终态 failed、错误可读
        const created = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1' })
        check('create reaches v2 bridge (201)', created.status === 201, JSON.stringify(created.data).slice(0, 200))
        if (created.status === 201) {
          let st = null
          for (let i = 0; i < 60; i++) {
            await sleep(500)
            const cur = await req('GET', `/api/jobs/${created.data.task.id}?refresh=1`)
            st = cur.data?.job?.status
            if (['done', 'failed', 'cancelled'].includes(st)) break
          }
          const rows = (await req('GET', '/api/instances', null)).data
          const stillCreating = rows.some((x) => x.name === 'arena1' && x.provisionState === 'creating')
          const exists = rows.some((x) => x.name === 'arena1')
          check(
            'v2 bridge create reaches terminal and leaves no phantom row',
            ['done', 'failed'].includes(st) && !stillCreating && (st === 'done' ? exists : !exists),
            `status=${st} exists=${exists}`,
          )
        }
      } else {
        // 旧 Python 桥:未声明 jobs 能力 → 502 + 升级指引
        const created = await req('POST', '/api/instances', { name: 'arena1', gameServerId: 'g1' })
        check(
          'create against incapable bridge → 502 with hint',
          created.status === 502 && /jobs 能力/.test(created.data.error || ''),
          JSON.stringify(created.data),
        )
      }
    }

    // reverse 变体:hello serverId 与 token 行不一致应被拒(close 1008)
    if (process.env.SMOKE_BRIDGE_MODE === 'reverse') {
      const { WebSocket } = await import('ws')
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent`)
      const closed = await new Promise((resolve) => {
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: 'replace-this-before-use', serverId: 'g999' })))
        ws.on('close', (code) => resolve(code))
        ws.on('error', () => resolve('error'))
        setTimeout(() => resolve('timeout'), 4000)
      })
      check('hello serverId mismatch rejected (1008)', closed === 1008, `code=${closed}`)

      // 半开连接自检:连上但不发任何帧(不回应 ping 的假 agent)必须在 AGENT_STALE_MS 后被断开
      {
        const silent = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent`)
        const closed = await new Promise((resolve) => {
          silent.on('open', () => silent.send(JSON.stringify({ type: 'hello', token: 'token-2-new', serverId: 'g2' })))
          silent.on('close', (code) => resolve(code))
          silent.on('error', () => {})
          setTimeout(() => resolve('timeout'), 6000)
        })
        check('silent agent terminated by keepalive', closed !== 'timeout', `code=${closed}`)
      }

      // ok:false 的桥回包不再被当成成功:实例状态改判为 unreachable(routes 捕获异常)
      {
        const liar = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent`)
        const ready = await new Promise((resolve) => {
          liar.on('open', () => {
            liar.send(JSON.stringify({ type: 'hello', token: 'token-2-new', serverId: 'g2' }))
            resolve(true)
          })
          liar.on('error', () => resolve(false))
          setTimeout(() => resolve(false), 2000)
        })
        if (ready) {
          liar.on('message', (raw) => {
            let m = {}
            try {
              m = JSON.parse(raw.toString())
            } catch {}
            if (m.type === 'cmd') {
              liar.send(JSON.stringify({ type: 'result', cmdId: m.cmdId, ok: false, data: { error: 'selfcheck-boom' } }))
            }
          })
          await sleep(300)
          const inst = await req('GET', '/api/instances', null)
          const srv2c = Array.isArray(inst.data) ? inst.data.find((i) => i.name === 'srv2c') : null
          check('bridge ok:false surfaces as unreachable', !!srv2c && srv2c.health === 'unreachable', JSON.stringify(srv2c))
          liar.close()
        } else {
          check('bridge ok:false surfaces as unreachable', false, 'fake agent could not connect')
        }
      }
    }

    // ============ M5:instances_report 收敛(主机侧 cs new/cs del → 平台) ============
    if (process.env.SMOKE_BRIDGE_MODE === 'reverse') {
      const { WebSocket } = await import('ws')
      const fake = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent`)
      const fakeReady = await new Promise((resolve) => {
        fake.on('open', () => {
          fake.send(JSON.stringify({ type: 'hello', token: 'token-2-new', serverId: 'g2' }))
          resolve(true)
        })
        fake.on('error', () => resolve(false))
        setTimeout(() => resolve(false), 2000)
      })
      // 假 agent 不回应用层 ping 会被后端按 AGENT_STALE_MS(冒烟里 1.5s)判半开断开 ——
      // 这里收到任何帧就回一帧,保持连接(fake 需要跨多条断言存活)
      fake.on('message', () => {
        try {
          fake.send(JSON.stringify({ type: 'pong' }))
        } catch {}
      })
      check('fake agent (g2) connected for instances_report', fakeReady)
      if (fakeReady) {
        // added:平台未登记的实例 → 登记为「待确认」(source=bridge_report,不参与分配)
        fake.send(
          JSON.stringify({
            type: 'instances_report', origin: 'reconcile',
            instances: [{ idx: 9, name: 'hostmade', port: 28099, gotvPort: 28199, action: 'added' }],
          }),
        )
        await sleep(400)
        let rows = (await req('GET', '/api/instances', null)).data
        let hostmade = rows.find((i) => i.name === 'hostmade')
        check(
          'instances_report added → unconfirmed row (bridge_report)',
          !!hostmade && hostmade.provisionState === 'unconfirmed' && hostmade.source === 'bridge_report' &&
            hostmade.port === 28099 && hostmade.idx === 9,
          JSON.stringify(hostmade),
        )
        const st = await req('GET', '/api/servers/status', null)
        const entry = (st.data.find((g) => g.groupId === 'g2')?.servers || []).find((x) => x.name === 'hostmade')
        check('unconfirmed instance unavailable in servers status', entry?.status === 'unknown' && entry?.provisionState === 'unconfirmed', JSON.stringify(entry))
        const blockedStart = await req('POST', '/api/instances/hostmade/start', {})
        check('unconfirmed instance cannot be started (409)', blockedStart.status === 409, JSON.stringify(blockedStart.data))
        const conf = await req('POST', '/api/instances/hostmade/confirm', {})
        check('admin confirms 待确认 instance (allocatable)', conf.status === 200 && conf.data.instance?.provisionState === null && conf.data.instance?.idx === 9, JSON.stringify(conf.data))
        const confAgain = await req('POST', '/api/instances/hostmade/confirm', {})
        check('confirm twice rejected (409)', confAgain.status === 409)
        // removed(主机侧 cs del 的墓碑)→ 平台删行
        fake.send(JSON.stringify({ type: 'instances_report', origin: 'reconcile', instances: [{ name: 'hostmade', action: 'removed' }] }))
        await sleep(400)
        rows = (await req('GET', '/api/instances', null)).data
        check('instances_report removed → row converged away', !rows.some((i) => i.name === 'hostmade'))

        // 幽灵「待确认」行根治:CLI 建实例**失败**时,半成品存在期间守护已把它报成 unconfirmed 行,
        // 桥侧回滚后该行必须随任务终态一并清掉 —— 否则 cs del 因目录不存在拒绝、只能人工删库行
        fake.send(
          JSON.stringify({
            type: 'instances_report', origin: 'reconcile',
            instances: [{ name: 'ghostinst', port: 28098, gotvPort: 28198, idx: 10, action: 'added' }],
          }),
        )
        await sleep(300)
        rows = (await req('GET', '/api/instances', null)).data
        const ghost = rows.find((i) => i.name === 'ghostinst')
        check(
          'ghost fixture: CLI 半成品被报成待确认行',
          !!ghost && ghost.provisionState === 'unconfirmed' && ghost.source === 'bridge_report',
          JSON.stringify(ghost),
        )
        // CLI 任务失败上报(job_report)→ 登记为 origin=cli + 终态收敛
        fake.send(
          JSON.stringify({
            type: 'job_report',
            job: {
              jobId: 9001, kind: 'instance_create', status: 'failed', instance: 'ghostinst', groupId: 'g2',
              error: 'stub: msm clone 失败(半成品已回滚)', finishedAt: Date.now(),
            },
          }),
        )
        await sleep(400)
        rows = (await req('GET', '/api/instances', null)).data
        check(
          'failed CLI create clears ghost 待确认 row',
          !rows.some((i) => i.name === 'ghostinst'),
          JSON.stringify(rows.filter((i) => i.gameServerId === 'g2')),
        )
        const ghostJob = await req('GET', '/api/jobs/9001')
        check(
          'CLI job_report registered as origin=cli (failed)',
          ghostJob.data?.job?.status === 'failed' && ghostJob.data?.job?.origin === 'cli' &&
            ghostJob.data?.job?.instanceName === 'ghostinst',
          JSON.stringify(ghostJob.data?.job),
        )
        // 兜底收尾:确保该名字不留库(修复生效时已被清),避免污染后续用例
        fake.send(JSON.stringify({ type: 'instances_report', origin: 'reconcile', instances: [{ name: 'ghostinst', action: 'removed' }] }))
        await sleep(200)
      }
      fake.close()
    }

    // ============ 桥首次连接上报实例清单 → 空组自动种子(后端为唯一权威) ============
    if (process.env.SMOKE_BRIDGE_MODE === 'reverse') {
      const { WebSocket } = await import('ws')
      const waitOpen = (ws, hello, ms = 1500) =>
        new Promise((resolve, reject) => {
          ws.on('open', () => ws.send(JSON.stringify(hello)))
          ws.on('error', reject)
          ws.on('close', (code) => reject(new Error(`ws closed ${code}`)))
          setTimeout(resolve, ms) // 连接保持 = hello 未被拒
        })

      r = await req('POST', '/api/game-servers', {
        name: '种子组', hostIp: '192.0.2.217', region: 'cn-south',
        bridgeToken: 'token-seed', bridgeMode: 'http', instances: [],
      })
      check('seed group created empty', r.status === 201 && r.data.instances.length === 0, JSON.stringify(r.data))
      const seedGroupId = r.data.id

      // 桥连接(hello 带实例清单)→ 空组自动种子入库
      const wsSeed = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent`)
      await waitOpen(wsSeed, { type: 'hello', token: 'token-seed', serverId: seedGroupId, instances: ['seedA', 'seedB'] })
      r = await req('GET', '/api/game-servers', null)
      const seedGroup = r.data.find((g) => g.id === seedGroupId)
      check(
        'first-connect hello seeds empty group instances',
        !!seedGroup &&
          seedGroup.instances.length === 2 &&
          seedGroup.instances.some((i) => i.name === 'seedA' && i.port === 0) &&
          seedGroup.instances.some((i) => i.name === 'seedB'),
        JSON.stringify(seedGroup?.instances),
      )
      check(
        'reportedInstances exposed for cross-check',
        Array.isArray(seedGroup?.reportedInstances) && seedGroup.reportedInstances.length === 2,
        JSON.stringify(seedGroup?.reportedInstances),
      )

      // 交叉校验仅警告:PUT 含未上报实例名 → 200 + warnings(不阻断)
      r = await req('PUT', `/api/game-servers/${seedGroupId}`, {
        name: '种子组', hostIp: '192.0.2.217', region: 'cn-south',
        bridgeToken: 'token-seed', bridgeMode: 'http',
        instances: [{ name: 'seedA', port: 28031 }, { name: 'ghost', port: 28032 }],
      })
      check(
        'PUT with unreported instance warns only (200 + warnings)',
        r.status === 200 && Array.isArray(r.data.warnings) && r.data.warnings.some((w) => w.includes('ghost')),
        JSON.stringify(r.data.warnings),
      )
      r = await req('PUT', `/api/game-servers/${seedGroupId}`, {
        name: '种子组', hostIp: '192.0.2.217', region: 'cn-south',
        bridgeToken: 'token-seed', bridgeMode: 'http',
        instances: [{ name: 'seedA', port: 28031 }, { name: 'seedB', port: 28032 }],
      })
      check('PUT matching reported instances no warnings', r.status === 200 && r.data.warnings === undefined, JSON.stringify(r.data.warnings))

      // 重连上报不同清单 → 不覆盖已入库实例(种子仅首次连接)
      const wsSeed2 = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent`)
      await waitOpen(wsSeed2, { type: 'hello', token: 'token-seed', serverId: seedGroupId, instances: ['seedC'] })
      r = await req('GET', '/api/game-servers', null)
      const seedGroup2 = r.data.find((g) => g.id === seedGroupId)
      check(
        'reconnect hello does not re-seed (backend authoritative)',
        !!seedGroup2 &&
          seedGroup2.instances.length === 2 &&
          seedGroup2.instances.every((i) => ['seedA', 'seedB'].includes(i.name)),
        JSON.stringify(seedGroup2?.instances),
      )
      wsSeed.close()
      wsSeed2.close()
      await req('DELETE', `/api/game-servers/${seedGroupId}`, {})
      check('seed group cleanup', true)
    }

    // ============ bridgeUrl 可选(reverse 留空)+ 删除服务器组 ============
    r = await req('POST', '/api/game-servers', {
      name: '无URL组', hostIp: '192.0.2.214', region: 'cn-south',
      bridgeToken: 'token-nourl', instances: [{ name: 'srv3a', port: 28011 }],
    })
    check('game-servers create without bridgeUrl ok', r.status === 201 && r.data.bridgeUrl === '' && r.data.id === 'g3', JSON.stringify(r.data))
    r = await req('DELETE', '/api/game-servers/g3', {})
    check('game-servers delete ok', r.status === 200)
    r = await req('GET', '/api/game-servers', null)
    check('deleted group removed from list', r.data.some((g) => g.id === 'g2') && !r.data.some((g) => g.id === 'g3'))
    // 使用中实例拒删:把 g2 的 srv2c 置为 in_match → 409;复位后删除成功
    const { DatabaseSync: SdbGS } = await import('node:sqlite')
    const sdbGS = new SdbGS(path.join(STUB_DIR, 'arena.db'))
    sdbGS.prepare("UPDATE instances SET state = 'in_match' WHERE name = 'srv2c'").run()
    r = await req('DELETE', '/api/game-servers/g2', {})
    check('game-servers delete busy instance rejected (409)', r.status === 409, JSON.stringify(r.data))
    sdbGS.prepare("UPDATE instances SET state = 'idle' WHERE name = 'srv2c'").run()
    r = await req('DELETE', '/api/game-servers/g2', {})
    check('game-servers delete after idle ok', r.status === 200)
    r = await req('GET', '/api/game-servers', null)
    check('g2 removed from list', !r.data.some((g) => g.id === 'g2') && r.data.some((g) => g.id === 'g1'))
    // 幽灵实例回归(同上):删组后其下实例必须立刻从缓存/清单消失
    r = await req('GET', '/api/instances', null)
    check('group delete prunes its instances from cache', !r.data.map((i) => i.name).includes('srv2c'))

    // ============ instances 可选:空实例新建 reverse 组 ============
    r = await req('POST', '/api/game-servers', {
      name: '空实例组', hostIp: '192.0.2.215', region: 'cn-south',
      bridgeToken: 'token-empty', bridgeMode: 'http', instances: [],
    })
    check('game-servers create with empty instances ok', r.status === 201 && r.data.instances.length === 0, JSON.stringify(r.data))
    const emptyGroupId = r.data.id
    r = await req('POST', '/api/game-servers', {
      name: '非数组组', hostIp: '192.0.2.216', region: 'cn-south',
      bridgeToken: 'token-notarray', instances: 'bad',
    })
    check('game-servers instances non-array rejected (400)', r.status === 400, JSON.stringify(r.data))
    // 空实例组补实例(PUT 整体替换)后可正常参与
    r = await req('PUT', `/api/game-servers/${emptyGroupId}`, {
      name: '空实例组', hostIp: '192.0.2.215', region: 'cn-south',
      bridgeToken: 'token-empty', bridgeMode: 'http', instances: [{ name: 'srv4a', port: 28021 }],
    })
    check('game-servers add instances via PUT ok', r.status === 200 && r.data.instances.length === 1 && r.data.instances[0].name === 'srv4a', JSON.stringify(r.data))
    await req('DELETE', `/api/game-servers/${emptyGroupId}`, {})
    check('empty-instance group cleanup', true)

    // ============ 管理员面板:地图池(服役池恒 7 张 + 总池管理) ============
    cookie = adminCookie
    // 服役地图池:恒 7 张,须为总池子集
    r = await req('GET', '/api/settings/map-pool', null)
    check('active map-pool read ok (7 maps)', r.status === 200 && r.data.mapIds.length === 7, JSON.stringify(r.data.mapIds.length))
    r = await req('PUT', '/api/settings/map-pool', { mapIds: ['de_mirage', 'de_inferno', 'de_nuke', 'de_dust2', 'de_ancient', 'de_anubis', 'de_vertigo', 'de_train'] })
    check('active map-pool 8 maps rejected (恒7张)', r.status === 400 && /正好 7 张/.test(r.data.error), JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/map-pool', { mapIds: ['de_mirage', 'de_ancient', 'de_anubis'] })
    check('active map-pool 3 maps rejected (恒7张)', r.status === 400, JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/map-pool', { mapIds: ['de_mirage', 'de_inferno', 'de_nuke', 'de_dust2', 'de_ancient', 'de_anubis', 'cs_office'] })
    check('active map-pool map outside catalog rejected', r.status === 400 && /总竞技图池/.test(r.data.error), JSON.stringify(r.data))
    cookie = guestCookie
    r = await req('PUT', '/api/settings/map-pool', { mapIds: ['de_mirage'] })
    check('map-pool update rejected for non-admin', r.status === 403)
    cookie = adminCookie
    // 总竞技图池:官方名 + 中文显示名
    r = await req('GET', '/api/settings/maps', null)
    check(
      'total map pool has 10 built-in maps',
      r.status === 200 && r.data.maps.length === 10 && r.data.maps.some((m) => m.fullName === 'de_train' && m.displayName === '火车站'),
      JSON.stringify(r.data.maps.length),
    )
    // 录入官方地图
    r = await req('POST', '/api/settings/maps', { fullName: 'de_office', displayName: '办公室' })
    check('add official map ok', r.status === 201 && r.data.map.fullName === 'de_office' && r.data.map.displayName === '办公室', JSON.stringify(r.data))
    r = await req('POST', '/api/settings/maps', { fullName: 'de_office', displayName: '办公室' })
    check('duplicate map rejected (409)', r.status === 409)
    r = await req('POST', '/api/settings/maps', { fullName: 'office', displayName: '办公室' })
    check('bad fullName rejected (400)', r.status === 400)
    r = await req('POST', '/api/settings/maps', { fullName: 'de_x', displayName: ' ' })
    check('empty displayName rejected (400)', r.status === 400)
    // 新图自动入总池 → direct 房间可从总池勾选
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '总池房', matchType: 'custom' })
    const totalPoolRoomId = r.data.id
    r = await req('POST', `/api/rooms/${totalPoolRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    check(
      'direct room pool = total pool (11 maps)',
      r.status === 200 && r.data.mapPool.includes('de_office') && r.data.mapPool.length === 11,
      JSON.stringify(r.data.mapPool.length),
    )
    r = await req('POST', `/api/rooms/${totalPoolRoomId}/directpick`, { mapId: 'de_office' })
    check('direct pick from total pool ok', r.status === 200 && r.data.picked.includes('de_office'), JSON.stringify(r.data.picked))
    await req('DELETE', `/api/rooms/${totalPoolRoomId}`, {})
    cookie = adminCookie
    // 服役池在用的地图不可删;未使用者可删
    r = await req('DELETE', '/api/settings/maps/de_mirage', {})
    check('delete map in active pool rejected (409)', r.status === 409, JSON.stringify(r.data))
    r = await req('DELETE', '/api/settings/maps/de_office', {})
    check('delete unused map ok', r.status === 200 && r.data.maps.length === 10, JSON.stringify(r.data.maps.length))
    // 官方图改名(PUT /api/settings/maps/:fullName):临时图避免影响内置 10 张
    await req('POST', '/api/settings/maps', { fullName: 'de_test', displayName: '测试图' })
    r = await req('PUT', '/api/settings/maps/de_test', { displayName: '测试图改' })
    check('official map rename ok + GET verified', r.status === 200 && r.data.map.displayName === '测试图改')
    r = await req('PUT', '/api/settings/maps/de_nonexist', { displayName: 'x' })
    check('official map rename 404', r.status === 404)
    r = await req('PUT', '/api/settings/maps/de_test', { displayName: '  ' })
    check('official map rename empty displayName (400)', r.status === 400)
    await req('DELETE', '/api/settings/maps/de_test', {})
    // 服役池可换图(仍恒 7 张)→ 新房间(默认 veto)用新服役池
    r = await req('PUT', '/api/settings/map-pool', { mapIds: ['de_mirage', 'de_inferno', 'de_nuke', 'de_dust2', 'de_ancient', 'de_train', 'de_cache'] })
    check('active map-pool swap maps ok', r.status === 200 && r.data.mapIds.includes('de_train'), JSON.stringify(r.data.mapIds))
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '服役池房', matchType: 'custom' })
    check(
      'new veto room uses active pool',
      r.status === 201 && JSON.stringify(r.data.mapPool) === JSON.stringify(['de_mirage', 'de_inferno', 'de_nuke', 'de_dust2', 'de_ancient', 'de_train', 'de_cache']),
      JSON.stringify(r.data.mapPool),
    )
    await req('DELETE', `/api/rooms/${r.data.id}`, {})
    // 恢复默认服役池,避免影响后续房间(BP 用例依赖经典 7 图)
    cookie = adminCookie
    r = await req('PUT', '/api/settings/map-pool', { mapIds: ['de_mirage', 'de_inferno', 'de_nuke', 'de_dust2', 'de_ancient', 'de_anubis', 'de_vertigo'] })
    check('active map-pool restored', r.status === 200)
    cookie = guestCookie

    // ============ 社区地图池(workshop 图,de_breach/3149170605;仅 community 选图方式可见) ============
    cookie = adminCookie
    await req('POST', '/api/instances/main/start', {}) // 确保 main RUNNING 供开赛
    r = await req('GET', '/api/settings/community-maps', null)
    check('community maps empty initially', r.status === 200 && r.data.maps.length === 0, JSON.stringify(r.data.maps))
    r = await req('POST', '/api/settings/community-maps', {
      displayName: '裂痕', workshopId: '3149170605', internalName: 'de_breach', matchTypes: ['custom', 'duel'],
    })
    check('add community map ok', r.status === 201 && r.data.map.kind === 'workshop' && r.data.map.id === '3149170605' && r.data.map.internalName === 'de_breach', JSON.stringify(r.data))
    r = await req('POST', '/api/settings/community-maps', { displayName: 'x', workshopId: 'abc', internalName: 'de_x', matchTypes: ['custom'] })
    check('workshop id must be numeric (400)', r.status === 400)
    r = await req('POST', '/api/settings/community-maps', { displayName: 'x', workshopId: '123456', internalName: 'de_x', matchTypes: [] })
    check('empty matchTypes rejected (400)', r.status === 400)
    r = await req('POST', '/api/settings/community-maps', { displayName: 'x', workshopId: '123456', internalName: 'de_mirage', matchTypes: ['custom'] })
    check('internalName conflicts official map (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', '/api/settings/community-maps', { displayName: '裂痕', workshopId: '3149170605', internalName: 'de_breach', matchTypes: ['custom'] })
    check('duplicate workshop id rejected (409)', r.status === 409)
    r = await req('GET', '/api/settings/maps', null)
    check('official total pool unaffected by community map', r.status === 200 && r.data.maps.length === 10 && r.data.maps.every((m) => m.kind === 'official'), JSON.stringify(r.data.maps.length))
    // direct 模式 = 纯官方池,社区图不进总竞技图池
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '社区图房', matchType: 'custom' })
    const commRoomId = r.data.id
    r = await req('POST', `/api/rooms/${commRoomId}/config`, { pickMode: 'direct', teamA: 1, teamB: 1 })
    check(
      'direct pool is official only (community map excluded)',
      r.status === 200 && !r.data.mapPool.includes('3149170605') && r.data.mapPool.length === 10,
      JSON.stringify(r.data.mapPool.length),
    )
    r = await req('POST', `/api/rooms/${commRoomId}/directpick`, { mapId: '3149170605' })
    check('community map not pickable in direct mode (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${commRoomId}/veto/start`, {})
    check('veto/start rejected in direct mode (409)', r.status === 409, JSON.stringify(r.data))
    // community 选图方式:池=社区图(按 matchType),强制 BO1
    r = await req('POST', `/api/rooms/${commRoomId}/config`, { bestOf: 3, pickMode: 'community', teamA: 1, teamB: 1 })
    check(
      'community mode pool = community maps + forced BO1',
      r.status === 200 && r.data.mapPool.length === 1 && r.data.mapPool.includes('3149170605') && r.data.bestOf === 1,
      JSON.stringify({ pool: r.data.mapPool, bestOf: r.data.bestOf }),
    )
    r = await req('POST', `/api/rooms/${commRoomId}/config`, { bestOf: 3 })
    check('community mode BO3 rejected (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${commRoomId}/veto/start`, {})
    check('veto/start rejected in community mode (409)', r.status === 409)
    r = await req('POST', `/api/rooms/${commRoomId}/directpick`, { mapId: '3149170605' })
    check('community map picked', r.status === 200 && r.data.picked.includes('3149170605'), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${commRoomId}/directpick`, { mapId: 'de_mirage' })
    check('official map not pickable in community mode (400)', r.status === 400, JSON.stringify(r.data))
    cookie = guestCookie
    await req('POST', `/api/rooms/${commRoomId}/join`, {})
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${commRoomId}/start`, {})
    check('community map match starts', r.status === 200, JSON.stringify(r.data))
    // 比赛 JSON maplist 用内部名;实例日志含 host_workshop_map 预加载
    const { DatabaseSync: SdbComm } = await import('node:sqlite')
    const sdbComm = new SdbComm(path.join(STUB_DIR, 'arena.db'))
    const mrowComm = sdbComm.prepare('SELECT payload, instance_name FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(commRoomId)
    const pComm = JSON.parse(mrowComm.payload)
    check('community map maplist uses internal name', JSON.stringify(pComm.maplist) === JSON.stringify(['de_breach']), JSON.stringify(pComm.maplist))
    await sleep(300)
    const commLog = existsSync(path.join(STUB_DIR, `${mrowComm.instance_name}.log`)) ? readFileSync(path.join(STUB_DIR, `${mrowComm.instance_name}.log`), 'utf8') : ''
    check('host_workshop_map preload sent', /SEND: host_workshop_map 3149170605/.test(commLog), commLog.split('\n').slice(-4).join(' | '))
    await req('POST', `/api/rooms/${commRoomId}/end`, {})
    await req('DELETE', `/api/rooms/${commRoomId}`, {})
    // 适用模式过滤:仅 duel 的社区图在 custom 房间的 community 池不可见
    cookie = adminCookie
    r = await req('POST', '/api/settings/community-maps', { displayName: '单挑练习图', workshopId: '111222333', internalName: 'de_duel_arena', matchTypes: ['duel'] })
    check('duel-only community map added', r.status === 201)
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '过滤房', matchType: 'custom' })
    const filterRoomId = r.data.id
    r = await req('POST', `/api/rooms/${filterRoomId}/config`, { pickMode: 'community', teamA: 1, teamB: 1 })
    check(
      'duel-only map excluded from custom room community pool',
      r.status === 200 && !r.data.mapPool.includes('111222333') && r.data.mapPool.length === 1,
      JSON.stringify(r.data.mapPool),
    )
    await req('DELETE', `/api/rooms/${filterRoomId}`, {})
    // 单挑对决(1v1)固定直接选图:/config 拒绝非 direct,veto/start 兜底;社区图经 mapPoolKind=duel 进 direct 池
    r = await req('POST', '/api/rooms', { name: '单挑房', matchType: 'duel' })
    const duelRoomId = r.data.id
    r = await req('POST', `/api/rooms/${duelRoomId}/config`, { pickMode: 'community' })
    check(
      'duel 房间切 community 被拒(选图方式固定为直接选图)',
      r.status === 400 && /固定为直接选图/.test(r.data.error ?? ''),
      JSON.stringify(r.data),
    )
    r = await req('POST', `/api/rooms/${duelRoomId}/config`, { pickMode: 'veto' })
    check('duel 房间切 veto 被拒(选图方式固定为直接选图)', r.status === 400)
    r = await req('POST', `/api/rooms/${duelRoomId}/veto/start`, {})
    check('duel 房间 veto/start 兜底 409(仅支持直接选图)', r.status === 409 && /仅支持直接选图/.test(r.data.error ?? ''), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${duelRoomId}/config`, { mapPoolKind: 'duel' })
    check(
      'duel 房单挑图池 = 2 张 duel 社区图(创建默认即此池,重设同池)',
      r.status === 200 && r.data.mapPool.length === 2 && r.data.mapPool.includes('111222333') && r.data.mapPool.includes('3149170605'),
      JSON.stringify(r.data.mapPool),
    )
    r = await req('POST', `/api/rooms/${duelRoomId}/directpick`, { mapId: '3149170605' })
    check('duel 房单挑图池直接选图 ok', r.status === 200 && r.data.picked.length === 1)
    await req('DELETE', `/api/rooms/${duelRoomId}`, {})
    // community 模式单张上限(custom 房;临时加第二张 custom 社区图使池=2)
    cookie = adminCookie
    r = await req('POST', '/api/settings/community-maps', { displayName: '第二张社区图', workshopId: '555666777', internalName: 'de_second_map', matchTypes: ['custom'] })
    check('second custom community map added', r.status === 201)
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '单张上限房', matchType: 'custom' })
    const singlePickRoomId = r.data.id
    r = await req('POST', `/api/rooms/${singlePickRoomId}/config`, { pickMode: 'community', teamA: 1, teamB: 1 })
    check('custom 房 community 池 = 2 张 custom 适用图', r.status === 200 && r.data.mapPool.length === 2, JSON.stringify(r.data.mapPool))
    r = await req('POST', `/api/rooms/${singlePickRoomId}/directpick`, { mapId: '3149170605' })
    check('community pick 1 ok', r.status === 200)
    r = await req('POST', `/api/rooms/${singlePickRoomId}/directpick`, { mapId: '555666777' })
    check('community mode single map limit (409)', r.status === 409 && /仅可选择 1 张/.test(r.data.error), JSON.stringify(r.data))
    await req('DELETE', `/api/rooms/${singlePickRoomId}`, {})
    cookie = adminCookie
    await req('DELETE', '/api/settings/community-maps/555666777', {})
    cookie = hostCookie
    // 社区图改名(PUT /api/settings/community-maps/:workshopId)
    cookie = adminCookie
    r = await req('PUT', '/api/settings/community-maps/3149170605', {
      displayName: '裂痕改', internalName: 'de_breach2', matchTypes: ['duel'],
    })
    check(
      'community map rename ok (displayName/internalName/matchTypes)',
      r.status === 200 && r.data.map.displayName === '裂痕改' && r.data.map.internalName === 'de_breach2' && JSON.stringify(r.data.map.matchTypes) === JSON.stringify(['duel']),
      JSON.stringify(r.data),
    )
    r = await req('PUT', '/api/settings/community-maps/999999999', { displayName: 'x', internalName: 'de_x', matchTypes: ['custom'] })
    check('community map rename 404', r.status === 404)
    r = await req('PUT', '/api/settings/community-maps/3149170605', { displayName: 'x', internalName: 'de_mirage', matchTypes: ['custom'] })
    check('community map rename internalName conflicts official (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/community-maps/3149170605', { displayName: 'x', internalName: 'de_x', matchTypes: [] })
    check('community map rename empty matchTypes (400)', r.status === 400)
    r = await req('PUT', '/api/settings/community-maps/111222333', { internalName: 'aim_gryn' })
    check(
      '社区图内部名允许非 de/cs 前缀(aim_gryn 类竞技场图)',
      r.status === 200 && r.data.map.internalName === 'aim_gryn',
      JSON.stringify(r.data),
    )
    r = await req('POST', '/api/settings/community-maps', { displayName: 'x', workshopId: '444555666', internalName: 'Ab', matchTypes: ['duel'] })
    check('社区图内部名非法(大写/过短)400', r.status === 400)
    cookie = guestCookie
    r = await req('PUT', '/api/settings/community-maps/3149170605', { displayName: 'x', internalName: 'de_x', matchTypes: ['custom'] })
    check('community map rename rejected for non-admin (403)', r.status === 403)

    // ============ 单挑「地图池选择」(mapPoolKind)+ 社区图下载 + 缩略图(2026-09-18) ============
    // ============ 平台在线告警 ============
    {
      const h = await req('GET', '/api/health', null)
      check(
        'health exposes alerts/bridges/backend',
        Array.isArray(h.data?.alerts) && Array.isArray(h.data?.bridges) &&
          typeof h.data?.backend?.uptimeMs === 'number' && h.data.backend.uptimeMs > 0,
        JSON.stringify({ alerts: h.data?.alerts, backend: h.data?.backend }),
      )
      if (process.env.SMOKE_BRIDGE_MODE === 'reverse') {
        const { WebSocket } = await import('ws')
        // 连接保持 = hello 未被拒(与下面的种子块同款;作用域内自带,避免依赖块外声明)
        const waitOpen = (ws, hello, ms = 1500) =>
          new Promise((resolve, reject) => {
            ws.on('open', () => ws.send(JSON.stringify(hello)))
            ws.on('error', reject)
            ws.on('close', (code) => reject(new Error(`ws closed ${code}`)))
            setTimeout(resolve, ms)
          })
        // 活跃组 + 无桥连接 → 超过阈值(冒烟里 1.2s)后必须告警
        cookie = adminCookie
        const mk = await req('POST', '/api/game-servers', {
          name: '告警组', hostIp: '192.0.2.218', region: 'cn-south',
          bridgeToken: 'token-alert', bridgeMode: 'http', instances: [],
        })
        check('alert group created', mk.status === 201, JSON.stringify(mk.data))
        const gid = mk.data.id
        await sleep(1800)
        const h2 = await req('GET', '/api/health', null)
        const alert = (h2.data?.alerts || []).find((a) => a.code === 'bridge_offline' && a.groupId === gid)
        const br = (h2.data?.bridges || []).find((b) => b.groupId === gid)
        check(
          'bridge offline → critical alert (with offlineMs)',
          !!alert && alert.level === 'critical' && br?.connected === false && br.offlineMs >= 1200,
          JSON.stringify({ alert, br }),
        )
        // 管理员端点:匿名 401;管理员能看到同一条
        cookie = ''
        const anon = await req('GET', '/api/host/alerts', null)
        check('alerts endpoint requires auth (401)', anon.status === 401, JSON.stringify(anon.data))
        cookie = adminCookie
        const adm = await req('GET', '/api/host/alerts', null)
        check(
          'admin alerts endpoint lists same bridge alert',
          adm.status === 200 && (adm.data.alerts || []).some((a) => a.groupId === gid),
          JSON.stringify(adm.data?.alerts),
        )
        // 桥连上 → 告警消失(边沿恢复)
        const wsA = new WebSocket(`ws://127.0.0.1:${PORT}/api/agent`)
        // 收到任何帧就回一帧:冒烟的保活自检很激进(静默 1.5s 即判半开并断开),不回会被踢
        wsA.on('message', () => {
          try {
            wsA.send(JSON.stringify({ type: 'pong' }))
          } catch {}
        })
        await waitOpen(wsA, { type: 'hello', token: 'token-alert', serverId: gid, capabilities: ['config_sync'] })
        await sleep(400)
        const h3 = await req('GET', '/api/health', null)
        check(
          'bridge reconnect clears the alert',
          !(h3.data?.alerts || []).some((a) => a.groupId === gid) &&
            (h3.data?.bridges || []).some((b) => b.groupId === gid && b.connected === true),
          `gid=${gid} alerts=${JSON.stringify(h3.data?.alerts)} bridges=${JSON.stringify(h3.data?.bridges)}`,
        )
        wsA.close()
      } else {
        // stub 模式没有真桥(联调专用):不误报桥离线
        check('stub mode reports no bridge alerts', (h.data?.alerts || []).length === 0, JSON.stringify(h.data?.alerts))
      }
    }

    cookie = adminCookie
    await req('POST', '/api/instances/main/reset', {}) // 清掉此前用例遗留的冷却/占用
    await req('POST', '/api/instances/main/start', {}) // 下载宿主实例保持 RUNNING
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '单挑池房', matchType: 'duel' })
    const duelPoolRoomId = r.data.id
    check(
      'duel 房默认 direct + 地图池=单挑图池',
      r.data.pickMode === 'direct' && r.data.mapPoolKind === 'duel',
      JSON.stringify({ pickMode: r.data.pickMode, kind: r.data.mapPoolKind }),
    )
    check(
      'duel 房默认池=单挑图池(仅勾选「单挑对决」的社区图)',
      r.data.mapPool.length === 2 && r.data.mapPool.includes('3149170605') && r.data.mapPool.includes('111222333'),
      JSON.stringify(r.data.mapPool),
    )
    // 单房间守卫(2026-09-22)后:同一 host 不能再同时持有两个活跃房间 —— 对照房改用管理员建(管理员不受限)
    cookie = adminCookie
    r = await req('POST', '/api/rooms', { name: '普通房', matchType: 'custom' })
    const customKindRoomId = r.data.id
    r = await req('POST', `/api/rooms/${customKindRoomId}/config`, { mapPoolKind: 'duel' })
    check('custom 房间设置地图池选择 400(仅 duel)', r.status === 400)
    await req('DELETE', `/api/rooms/${customKindRoomId}`, {})
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${duelPoolRoomId}/config`, { mapPoolKind: 'weird' })
    check('非法 mapPoolKind 400', r.status === 400)
    r = await req('POST', `/api/rooms/${duelPoolRoomId}/config`, { mapPoolKind: 'duel' })
    check(
      '单挑图池 = 社区图勾选「单挑对决」的地图',
      r.status === 200 && r.data.mapPool.length === 2 && r.data.mapPool.includes('3149170605') && r.data.mapPool.includes('111222333'),
      JSON.stringify(r.data.mapPool),
    )
    r = await req('POST', `/api/rooms/${duelPoolRoomId}/directpick`, { mapId: '3149170605' })
    check('单挑图池直接选图 ok', r.status === 200 && r.data.picked.length === 1)
    r = await req('POST', `/api/rooms/${duelPoolRoomId}/config`, { mapPoolKind: 'total' })
    check(
      '切回总竞技图池同步池并清空选图',
      r.status === 200 && r.data.mapPool.length === 10 && r.data.picked.length === 0,
      JSON.stringify({ pool: r.data.mapPool.length, picked: r.data.picked }),
    )
    r = await req('POST', `/api/rooms/${duelPoolRoomId}/config`, { pickMode: 'veto' })
    check('duel 房切 veto 被拒(固定直接选图,不再有「存偏好」语义)', r.status === 400)
    r = await req('POST', `/api/rooms/${duelPoolRoomId}/config`, { pickMode: 'community' })
    check('duel 房切 community 被拒(固定直接选图)', r.status === 400)
    r = await req('POST', `/api/rooms/${duelPoolRoomId}/config`, { mapPoolKind: 'duel' })
    check('direct 模式下 mapPoolKind 随时可切(池同步+清选图)', r.status === 200 && r.data.mapPoolKind === 'duel' && r.data.mapPool.length === 2 && r.data.picked.length === 0, JSON.stringify(r.data.mapPool))
    await req('DELETE', `/api/rooms/${duelPoolRoomId}`, {})

    // 社区图下载:仅管理员;stub 目录模拟主机共享目录落盘
    cookie = guestCookie
    r = await req('POST', '/api/settings/community-maps/3149170605/download', {})
    check('下载非管理员 403', r.status === 403)
    cookie = adminCookie
    r = await req('POST', '/api/settings/community-maps/999999999/download', {})
    check('下载未知社区图 404', r.status === 404)
    r = await req('POST', '/api/settings/community-maps/3149170605/download', {})
    check(
      '启动下载任务(downloading @main)',
      r.status === 200 && r.data.started === true && r.data.job.status === 'downloading' && r.data.job.instance === 'main',
      JSON.stringify(r.data),
    )
    r = await req('POST', '/api/settings/community-maps/3149170605/download', {})
    check('重复下载 409', r.status === 409)
    const wsMainLog = existsSync(path.join(STUB_DIR, 'main.log')) ? readFileSync(path.join(STUB_DIR, 'main.log'), 'utf8') : ''
    check(
      '已下发 host_workshop_map(控制台通道)',
      (wsMainLog.match(/SEND: host_workshop_map 3149170605/g) || []).length >= 1,
    )
    const mainInstLock = (await req('GET', '/api/instances', null)).data.find((i) => i.name === 'main')
    check('下载期间实例占锁 booting', mainInstLock?.state === 'booting', JSON.stringify(mainInstLock))
    // 模拟 Steam 下载落盘(写入 ≥1MB 文件)+ 引擎加载签名(host_workshop_map 下载完成后自动换图,
    // 真机日志含 `SV:  addon='<id>'`;后端以该签名确认加载成功才判 done)
    const wsItemDir = path.join(STUB_DIR, 'workshop', 'content', '730', '3149170605')
    mkdirSync(wsItemDir, { recursive: true })
    writeFileSync(path.join(wsItemDir, 'de_duel_map.vpk'), Buffer.alloc(1536 * 1024, 7))
    appendFileSync(path.join(STUB_DIR, 'main.log'), `SV:  addon='3149170605'\n`)
    let dlStatus = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      const st = await req('GET', '/api/settings/community-maps/3149170605/download', null)
      if (st.data.job && st.data.job.status !== 'downloading') {
        dlStatus = st.data
        break
      }
    }
    check(
      '下载完成判定(done + 字节数)',
      dlStatus?.job?.status === 'done' && (dlStatus.sizeBytes ?? 0) >= 1024 * 1024,
      JSON.stringify(dlStatus),
    )
    const mainAfter = (await req('GET', '/api/instances', null)).data.find((i) => i.name === 'main')
    check('下载完成后实例锁复位 idle', mainAfter?.state === 'idle', JSON.stringify(mainAfter))
    r = await req('GET', '/api/settings/community-maps', null)
    check('列表标记 downloaded/sizeBytes', r.data.maps.find((m) => m.workshopId === '3149170605')?.downloaded === true)
    r = await req('POST', '/api/settings/community-maps/3149170605/download', {})
    check(
      '已下载幂等(不再启动下载)',
      r.status === 200 && r.data.started === false && r.data.job.status === 'done' && r.data.job.alreadyPresent === true,
      JSON.stringify(r.data),
    )

    // 下载失败快速判定(2026-09-19):引擎挂载 addon 却「里面没有任何地图」时立即判 failed,
    // 不再空等总超时(期间实例锁一直被占);失败后可重试,重试落盘 + 加载签名即 done
    r = await req('POST', '/api/settings/community-maps', {
      displayName: '失败测试图', workshopId: '777888999', internalName: 'de_failtest', matchTypes: ['custom'],
    })
    check('录入失败测试图 ok', r.status === 201, JSON.stringify(r.data))
    r = await req('POST', '/api/settings/community-maps/777888999/download', {})
    check(
      '失败测试图启动下载',
      r.status === 200 && r.data.started === true && r.data.job.status === 'downloading',
      JSON.stringify(r.data),
    )
    // 真机失败签名:`GetAvailableAddonMaps failed to find any maps in the '<id>' addon - trying fallback maps: …`
    appendFileSync(
      path.join(STUB_DIR, 'main.log'),
      "GetAvailableAddonMaps failed to find any maps in the '777888999' addon - trying fallback maps: error\n",
    )
    let failStatus = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      const st = await req('GET', '/api/settings/community-maps/777888999/download', null)
      if (st.data.job && st.data.job.status !== 'downloading') {
        failStatus = st.data
        break
      }
    }
    check(
      '引擎报 addon 无地图 → 快速判 failed(不空等总超时)',
      failStatus?.job?.status === 'failed' && /没有任何地图/.test(failStatus.job.error ?? ''),
      JSON.stringify(failStatus?.job),
    )
    const mainAfterFail = (await req('GET', '/api/instances', null)).data.find((i) => i.name === 'main')
    check('失败后实例锁复位 idle', mainAfterFail?.state === 'idle', JSON.stringify(mainAfterFail))
    r = await req('POST', '/api/settings/community-maps/777888999/download', {})
    check(
      '失败后可重试(重新启动下载)',
      r.status === 200 && r.data.started === true && r.data.job.status === 'downloading',
      JSON.stringify(r.data),
    )
    // 上一轮失败行仍在日志尾段 → 不得误判;落盘 + 加载签名后应 done
    mkdirSync(path.join(STUB_DIR, 'workshop', 'content', '730', '777888999'), { recursive: true })
    writeFileSync(path.join(STUB_DIR, 'workshop', 'content', '730', '777888999', 'de_failtest.vpk'), Buffer.alloc(1536 * 1024, 9))
    appendFileSync(path.join(STUB_DIR, 'main.log'), "SV:  addon='777888999'\n")
    let retryStatus = null
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      const st = await req('GET', '/api/settings/community-maps/777888999/download', null)
      if (st.data.job && st.data.job.status !== 'downloading') {
        retryStatus = st.data
        break
      }
    }
    check('重试不误判失败并判 done(尾段旧失败行不参与判定)', retryStatus?.job?.status === 'done', JSON.stringify(retryStatus?.job))
    // 清理失败测试图条目(后续用例对社区图清单数量有断言)
    r = await req('DELETE', '/api/settings/community-maps/777888999', {})
    check('清理失败测试图条目', r.status === 200)

    // 缩略图:仅管理员上传(魔数嗅探 PNG/JPEG/WebP),公开读取,与官方图前端静态资源同口径
    const TINY_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    cookie = guestCookie
    r = await rawReq('POST', '/api/settings/community-maps/3149170605/thumbnail', TINY_PNG)
    check('缩略图非管理员 403', r.status === 403)
    cookie = adminCookie
    r = await rawReq('POST', '/api/settings/community-maps/3149170605/thumbnail', Buffer.from('not-an-image'))
    check('非法图片字节 400', r.status === 400)
    r = await rawReq('POST', '/api/settings/community-maps/999999999/thumbnail', TINY_PNG)
    check('未知社区图缩略图 404', r.status === 404)
    r = await rawReq('POST', '/api/settings/community-maps/3149170605/thumbnail', TINY_PNG)
    check(
      '上传缩略图 ok(hasThumbnail/thumbnailUrl)',
      r.status === 200 && r.data.map.hasThumbnail === true && r.data.map.thumbnailUrl === '/api/settings/community-maps/3149170605/thumbnail',
      JSON.stringify(r.data),
    )
    // JPEG 上传覆盖 → 仍统一为 WebP
    const TINY_JPG = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
      'base64',
    )
    r = await rawReq('POST', '/api/settings/community-maps/3149170605/thumbnail', TINY_JPG)
    check('JPEG 覆盖上传 ok', r.status === 200 && r.data.map.hasThumbnail === true, JSON.stringify(r.data))
    cookie = ''
    let imgRes = await fetch(`${BASE}/api/settings/community-maps/3149170605/thumbnail`)
    const jpgBuf = Buffer.from(await imgRes.arrayBuffer())
    check(
      'JPEG 上传后读取仍为 WebP(魔数校验)',
      imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/webp' && jpgBuf.slice(8, 12).toString('ascii') === 'WEBP' && !jpgBuf.slice(0, 3).equals(TINY_JPG.slice(0, 3)),
      JSON.stringify({ ct: imgRes.headers.get('content-type'), len: jpgBuf.length }),
    )
    cookie = adminCookie
    r = await req('GET', '/api/settings/community-maps', null)
    check('社区图列表携带 hasThumbnail', r.data.maps.find((m) => m.workshopId === '3149170605')?.hasThumbnail === true)
    r = await req('DELETE', '/api/settings/community-maps/3149170605/thumbnail', {})
    check('删除缩略图 ok', r.status === 200 && r.data.removed === true && r.data.map.hasThumbnail === false)
    cookie = ''
    imgRes = await fetch(`${BASE}/api/settings/community-maps/3149170605/thumbnail`)
    check('删除后读取 404', imgRes.status === 404)
    cookie = adminCookie

    // 本地自维护社区图(方案②):开赛跳过 host_workshop_map,经桥预检 maps/<internal>.vpk
    cookie = adminCookie
    r = await req('POST', '/api/settings/community-maps', {
      displayName: '本地图', workshopId: '999888777', internalName: 'de_localtest', matchTypes: ['custom'], localMap: true,
    })
    check('录入本地图(localMap 默认持久化)', r.status === 201 && r.data.map.localMap === true, JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '本地图房', matchType: 'custom' })
    const localRoomId = r.data.id
    await req('POST', `/api/rooms/${localRoomId}/config`, { pickMode: 'community', teamA: 1, teamB: 1 })
    cookie = guestCookie
    await req('POST', `/api/rooms/${localRoomId}/join`, {})
    cookie = hostCookie
    await req('POST', `/api/rooms/${localRoomId}/directpick`, { mapId: '999888777' })
    r = await req('POST', `/api/rooms/${localRoomId}/start`, {})
    check('本地图未部署 → 开赛 500 明确报错', r.status === 500 && /未部署/.test(r.data.error ?? ''), JSON.stringify(r.data))
    // 模拟部署(实例本地 maps/de_localtest.vpk)→ 再开赛
    mkdirSync(path.join(STUB_DIR, 'maps'), { recursive: true })
    writeFileSync(path.join(STUB_DIR, 'maps', 'de_localtest.vpk'), Buffer.alloc(64, 1))
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${localRoomId}/start`, {})
    check('本地图开赛成功(跳过 host_workshop_map)', r.status === 200, JSON.stringify(r.data))
    const mrowLocal = sdbComm.prepare('SELECT payload, instance_name FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(localRoomId)
    check('本地图 maplist 用内部名', JSON.parse(mrowLocal.payload).maplist[0] === 'de_localtest', JSON.stringify(JSON.parse(mrowLocal.payload).maplist))
    const localLog = existsSync(path.join(STUB_DIR, `${mrowLocal.instance_name}.log`)) ? readFileSync(path.join(STUB_DIR, `${mrowLocal.instance_name}.log`), 'utf8') : ''
    check('本地图未下发 host_workshop_map(不再挂载 addon)', !localLog.includes('host_workshop_map 999888777'))
    await req('POST', `/api/rooms/${localRoomId}/end`, {})
    await req('DELETE', `/api/rooms/${localRoomId}`, {})
    cookie = adminCookie
    r = await req('PUT', '/api/settings/community-maps/999888777', { localMap: false })
    check('本地图开关可切换(改回工坊流程)', r.status === 200 && r.data.map.localMap === false, JSON.stringify(r.data))
    r = await req('DELETE', '/api/settings/community-maps/999888777', {})
    check('删除本地图条目', r.status === 200)
    cookie = adminCookie

    // 清理社区图
    cookie = adminCookie
    r = await req('DELETE', '/api/settings/community-maps/3149170605', {})
    check('delete community map ok', r.status === 200 && r.data.maps.length === 1, JSON.stringify(r.data.maps))
    r = await req('DELETE', '/api/settings/community-maps/3149170605', {})
    check('delete missing community map (404)', r.status === 404)
    r = await req('DELETE', '/api/settings/community-maps/111222333', {})
    check('delete duel-only community map ok', r.status === 200 && r.data.maps.length === 0)
    cookie = guestCookie

    // ============ 管理员面板:强制解散任意房间(管理员旁路) ============
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '他人房间', matchType: 'custom' })
    const otherRoomId = r.data.id
    cookie = guestCookie
    r = await req('DELETE', `/api/rooms/${otherRoomId}`, {})
    check('non-host delete rejected (403)', r.status === 403)
    cookie = adminCookie
    r = await req('DELETE', `/api/rooms/${otherRoomId}`, {})
    check('admin force-disband room ok', r.status === 200)

    // ============ 管理员面板:实例控制台(REST) ============
    cookie = guestCookie
    r = await req('GET', '/api/admin/instances/main/console?lines=10', null)
    check('console read rejected for non-admin', r.status === 403)
    r = await req('POST', '/api/admin/instances/main/console', { command: 'status' })
    check('console write rejected for non-admin', r.status === 403)
    cookie = adminCookie
    r = await req('GET', '/api/admin/instances/main/console?lines=10', null)
    check('console read ok (running instance)', r.status === 200 && Array.isArray(r.data.lines), JSON.stringify(r.data))
    r = await req('GET', '/api/admin/instances/match1/console?lines=10', null)
    check('console read rejected when instance stopped (409)', r.status === 409)
    r = await req('POST', '/api/admin/instances/match1/console', { command: 'status' })
    check('console write rejected when instance stopped (409)', r.status === 409)
    r = await req('POST', '/api/admin/instances/main/console', { command: 'mp_maxrounds 30' })
    check('console write ok', r.status === 200 && r.data.ok === true)
    r = await req('POST', '/api/admin/instances/main/console', { command: 'line1\nline2' })
    check('console multi-line command rejected', r.status === 400)
    r = await req('POST', '/api/admin/instances/main/console', { command: '' })
    check('console empty command rejected', r.status === 400)

    // ============ 管理员面板:实例控制台(Socket 实时) ============
    await withAdminSocket('main', async ({ events, ask }) => {
      await sleep(600)
      const st = events.find((e) => e.ev === 'console:state')
      check('console socket: state running pushed', !!st && st.data.running === true, JSON.stringify(events))
      // socket history(socket 通道拉历史,与 REST 等价)
      const hist = await ask('console:history', { instance: 'main', lines: 10 }, 'console:history_result').catch((e) => ({ error: e.message }))
      check('console socket: history_result with lines', hist.error === undefined && Array.isArray(hist.lines) && hist.lines.length > 0, JSON.stringify(hist))
      // socket command(执行任意命令,收到 command_result)
      const cres = await ask('console:command', { instance: 'main', command: 'say arena_socket_cmd' }, 'console:command_result').catch((e) => ({ error: e.message }))
      check('console socket: command_result ok', cres.error === undefined && cres.ok === true, JSON.stringify(cres))
      await sleep(800)
      const out = events.filter((e) => e.ev === 'console:output').map((e) => e.data.lines.join('\n')).join('\n')
      check('console socket: output contains executed command', out.includes('say arena_socket_cmd'), out.slice(-200))
    }, { cookie: adminCookie })
    await withAdminSocket('main', async ({ events, ask }) => {
      await sleep(500)
      check('console socket: non-admin rejected', events.some((e) => e.ev === 'console:error'), JSON.stringify(events))
      const hist = await ask('console:history', { instance: 'main', lines: 5 }, 'console:history_result').catch((e) => ({ error: e.message }))
      check('console socket: history non-admin rejected', !!hist.error, JSON.stringify(hist))
    }, { cookie: guestCookie })
    cookie = guestCookie

    // ============ host_ip 域名动态解析(开赛时) ============
    const net = await import('../lib/net.js')
    check('net: plain ip detected', net.isPlainIp('192.0.2.211') === true && net.isPlainIp('198.51.100.142') === true)
    check('net: hostname not plain ip', net.isPlainIp('h.wanyacn.cn') === false)
    check('net: localhost resolves to 127.0.0.1', (await net.resolveHostIp('localhost')) === '127.0.0.1', await net.resolveHostIp('localhost'))
    cookie = adminCookie
    r = await req('GET', '/api/game-servers', null)
    const g1row = r.data.find((g) => g.groupId === undefined && g.id === 'g1')
    r = await req('PUT', '/api/game-servers/g1', {
      name: g1row.name, hostIp: 'localhost', region: g1row.region,
      bridgeUrl: g1row.bridgeUrl, bridgeToken: g1row.bridgeToken,
      instances: g1row.instances.map((i) => ({ name: i.name, port: i.port })),
    })
    check('host_ip set to domain (localhost)', r.status === 200 && r.data.hostIp === 'localhost')
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '域名解析房', matchType: 'custom' })
    const dnsRoomId = r.data.id
    await req('POST', `/api/rooms/${dnsRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    await req('POST', `/api/rooms/${dnsRoomId}/directpick`, { mapId: 'de_mirage' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${dnsRoomId}/join`, {})
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${dnsRoomId}/start`, {})
    check('start ok with domain host_ip', r.status === 200, JSON.stringify(r.data))
    check('room.server.ip resolved to 127.0.0.1', r.data.room.server?.ip === '127.0.0.1', JSON.stringify(r.data.room.server))
    await req('DELETE', `/api/rooms/${dnsRoomId}`, {})
    cookie = adminCookie
    // 域名房开赛用过 main → 房间解散后实例进冷却(等 demo)。旧实现靠"组编辑整表重插"
    // 顺手把锁抹成 idle;前置修复 B 后锁被如实保留 → 这里显式复位(等价管理面板「重置」)
    r = await req('POST', '/api/instances/main/reset', {})
    check('reset main lock after domain room closed', r.status === 200)
    r = await req('PUT', '/api/game-servers/g1', {
      name: g1row.name, hostIp: '192.0.2.211', region: g1row.region,
      bridgeUrl: g1row.bridgeUrl, bridgeToken: g1row.bridgeToken,
      instances: g1row.instances.map((i) => ({ name: i.name, port: i.port })),
    })
    check('host_ip restored to ip', r.status === 200 && r.data.hostIp === '192.0.2.211')
    cookie = guestCookie

    // ============ 分配规则:自动分配跳过 STOPPED(系统不唤醒) ============
    cookie = adminCookie
    r = await req('POST', '/api/instances/main/stop', {})
    check('stop main for auto-skip test', r.status === 200)
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '无运行实例房', matchType: 'custom' })
    const noInstRoomId = r.data.id
    await req('POST', `/api/rooms/${noInstRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    await req('POST', `/api/rooms/${noInstRoomId}/directpick`, { mapId: 'de_mirage' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${noInstRoomId}/join`, {})
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${noInstRoomId}/start`, {})
    check('auto allocation skips stopped instances', r.status === 500 && /无可用运行中实例/.test(r.data.error), JSON.stringify(r.data))
    await req('DELETE', `/api/rooms/${noInstRoomId}`, {})
    cookie = adminCookie
    r = await req('POST', '/api/instances/main/start', {})
    check('admin wakes main again', r.status === 200)

    // ============ 实例分级(admin_only):可见性 ============
    r = await req('PUT', '/api/instances/main', { adminOnly: true })
    check('set main admin_only ok', r.status === 200 && r.data.instance.adminOnly === true, JSON.stringify(r.data))
    cookie = guestCookie
    r = await req('GET', '/api/instances', null)
    check('normal user cannot see admin_only instance', r.status === 200 && !r.data.some((i) => i.name === 'main'))
    r = await req('GET', '/api/servers/status', null)
    check('servers status hides admin_only for normal user', !r.data[0].servers.some((s) => s.name === 'main'))
    cookie = adminCookie
    r = await req('GET', '/api/instances', null)
    check('admin sees admin_only instance', r.data.some((i) => i.name === 'main' && i.adminOnly === true))
    r = await req('GET', '/api/servers/status', null)
    check('admin sees admin_only in servers status', r.data[0].servers.some((s) => s.name === 'main'))

    // ============ 房主选择(两级:组 → 实例) ============
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '选择房', matchType: 'custom' })
    const selRoomId = r.data.id
    await req('POST', `/api/rooms/${selRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    await req('POST', `/api/rooms/${selRoomId}/directpick`, { mapId: 'de_nuke' })
    r = await req('POST', `/api/rooms/${selRoomId}/server`, { mode: 'manual', group: 'g1', instance: 'main' })
    check('normal host cannot select admin_only instance (403)', r.status === 403, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${selRoomId}/server`, { mode: 'manual', group: 'g1' })
    check('manual group-only select ok', r.status === 200 && r.data.serverChoice.mode === 'manual' && r.data.serverChoice.group === 'g1' && r.data.serverChoice.instance === null)
    cookie = guestCookie
    await req('POST', `/api/rooms/${selRoomId}/join`, {})
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${selRoomId}/start`, {})
    check('start without instance chosen rejected', r.status === 500 && /请选择实例/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${selRoomId}/server`, { mode: 'manual', group: 'g1', instance: 'match1' })
    check('manual select stopped instance rejected', r.status === 400 && /实例未运行/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${selRoomId}/server`, { mode: 'manual', group: 'gx' })
    check('manual select unknown group rejected', r.status === 400, JSON.stringify(r.data))

    // 管理员把 main 改回普通 → 普通房主可选
    cookie = adminCookie
    await req('PUT', '/api/instances/main', { adminOnly: false })
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${selRoomId}/server`, { mode: 'manual', group: 'g1', instance: 'main' })
    check('manual select running instance ok', r.status === 200 && r.data.serverChoice.instance === 'main', JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${selRoomId}/start`, {})
    check('manual start ok', r.status === 200 && r.data.instance === 'main', JSON.stringify(r.data))
    await req('DELETE', `/api/rooms/${selRoomId}`, {})
    cookie = adminCookie
    r = await req('POST', '/api/instances/main/reset', {})
    check('reset main lock after delete (clear cooling)', r.status === 200)

    // 管理员房主可选 admin_only 实例
    cookie = adminCookie
    r = await req('PUT', '/api/instances/main', { adminOnly: true })
    check('main back to admin_only', r.status === 200)
    r = await req('POST', '/api/rooms', { name: '管理员选图房', matchType: 'custom' })
    const admSelRoomId = r.data.id
    await req('POST', `/api/rooms/${admSelRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    await req('POST', `/api/rooms/${admSelRoomId}/directpick`, { mapId: 'de_ancient' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${admSelRoomId}/join`, {})
    cookie = adminCookie
    r = await req('POST', `/api/rooms/${admSelRoomId}/server`, { mode: 'manual', group: 'g1', instance: 'main' })
    check('admin host can select admin_only instance', r.status === 200, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${admSelRoomId}/start`, {})
    check('admin manual start on admin_only instance ok', r.status === 200 && r.data.instance === 'main', JSON.stringify(r.data))
    await req('DELETE', `/api/rooms/${admSelRoomId}`, {})
    cookie = adminCookie
    await req('PUT', '/api/instances/main', { adminOnly: false })
    check('main restored to normal', true)
    await req('POST', '/api/instances/main/reset', {})
    check('main lock cleared (for knife test)', true)
    cookie = guestCookie

    // ============ 刀战开关与 BP 选边(map_sides 单元) ============
    const mj = await import('../lib/matchjson.js')
    const unitSides = (bestOf, knifeRound) =>
      mj.buildMatchJson({
        matchId: 1,
        room: { slots: [], teamAName: 'A', teamBName: 'B', bestOf, knifeRound, pickMode: 'direct' },
        maplist: ['de_mirage', 'de_inferno'],
        playersPerTeam: 1,
        minPlayersToReady: 2,
        publicBaseUrl: 'http://x',
        token: 't',
      }).map_sides
    const unitVetoSides = (bestOf, sideChoices) =>
      mj.buildMatchJson({
        matchId: 1,
        room: { slots: [], teamAName: 'A', teamBName: 'B', bestOf, knifeRound: true, pickMode: 'veto', sideChoices },
        maplist: ['de_mirage', 'de_inferno', 'de_nuke'],
        playersPerTeam: 1,
        minPlayersToReady: 2,
        publicBaseUrl: 'http://x',
        token: 't',
      }).map_sides
    check('unit: BO1 direct knife off -> team1_ct sides', JSON.stringify(unitSides(1, false)) === JSON.stringify(['team1_ct', 'team1_ct']))
    check('unit: BO1 direct knife on -> knife sides', JSON.stringify(unitSides(1, true)) === JSON.stringify(['knife', 'knife']))
    check('unit: BO3 veto -> [team2_ct, team1_ct, knife]', JSON.stringify(unitVetoSides(3, { 0: 'team2_ct', 1: 'team1_ct' })) === JSON.stringify(['team2_ct', 'team1_ct', 'knife']), JSON.stringify(unitVetoSides(3, { 0: 'team2_ct', 1: 'team1_ct' })))
    check('unit: BO3 veto default sides (no choices) -> [team2_ct, team1_ct, knife]', JSON.stringify(unitVetoSides(3, {})) === JSON.stringify(['team2_ct', 'team1_ct', 'knife']))

    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '刀战开关房', matchType: 'custom' })
    const knifeRoomId = r.data.id
    await req('POST', `/api/rooms/${knifeRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1, knifeRound: false })
    r = await req('GET', `/api/rooms/${knifeRoomId}`, null)
    check('knifeRound persisted in room', r.data.knifeRound === false)
    await req('POST', `/api/rooms/${knifeRoomId}/directpick`, { mapId: 'de_mirage' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${knifeRoomId}/join`, {})
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${knifeRoomId}/start`, {})
    check('knife off match starts', r.status === 200, JSON.stringify(r.data))
    const { DatabaseSync: Sdb3 } = await import('node:sqlite')
    const sdb3 = new Sdb3(path.join(STUB_DIR, 'arena.db'))
    const kp = JSON.parse(sdb3.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(knifeRoomId).payload)
    check('BO1 knife off payload map_sides team1_ct', JSON.stringify(kp.map_sides) === JSON.stringify(['team1_ct']), JSON.stringify(kp.map_sides))
    await req('DELETE', `/api/rooms/${knifeRoomId}`, {})
    cookie = adminCookie
    await req('POST', '/api/instances/main/reset', {})
    cookie = hostCookie

    // ============ 友军伤害开关(默认开启;关闭 → 开赛 JSON cvars 下发控制台指令) ============
    // 单元:开关 → 比赛 JSON cvars(关闭才覆盖,开启不写)
    const unitFf = (friendlyFire) => mj.buildMatchJson({
      matchId: 1,
      room: { slots: [], teamAName: 'A', teamBName: 'B', bestOf: 1, knifeRound: false, friendlyFire, pickMode: 'direct' },
      maplist: ['de_mirage'],
      playersPerTeam: 1,
      minPlayersToReady: 2,
      publicBaseUrl: 'http://x',
      token: 't',
    }).cvars
    check(
      'unit: friendlyFire off -> cvars mp_friendlyfire 1 / ff_damage_reduction_bullets 0',
      unitFf(false).mp_friendlyfire === '1' && unitFf(false).ff_damage_reduction_bullets === '0',
      JSON.stringify(unitFf(false)),
    )
    check('unit: friendlyFire on -> 不下发友军伤害 cvar', !('ff_damage_reduction_bullets' in unitFf(true)), JSON.stringify(unitFf(true)))

    // 开局公告(开赛瞬间全体可见的聊天消息):随房间开关生成,与 cvar 覆盖同一 JSON cvars 通道
    const unitAnn = (knifeRound, friendlyFire) => mj.buildMatchJson({
      matchId: 1,
      room: { slots: [], teamAName: 'A', teamBName: 'B', bestOf: 1, knifeRound, friendlyFire, pickMode: 'direct' },
      maplist: ['de_mirage'],
      playersPerTeam: 1,
      minPlayersToReady: 2,
      publicBaseUrl: 'http://x',
      token: 't',
    }).cvars
    const annOff = unitAnn(false, false)
    check(
      'unit: 公告两行(关闭态红字 + 投掷物提醒)',
      annOff.matchzy_match_start_message.startsWith('当前比赛 拼刀选边 {Red}已关闭{Default}，友军伤害 {Red}已关闭{Default}$$$注意！') &&
        annOff.matchzy_match_start_message.endsWith('{Red}手雷、燃烧弹{Default}等投掷物仍会造成伤害！') &&
        !('matchzy_chat_prefix' in annOff),
      annOff.matchzy_match_start_message,
    )
    const annOn = unitAnn(true, true)
    check(
      'unit: 公告单行(开启态绿字,无投掷物提醒)',
      annOn.matchzy_match_start_message === '当前比赛 拼刀选边 {Green}已开启{Default}，友军伤害 {Green}已开启{Default}',
      annOn.matchzy_match_start_message,
    )

    r = await req('POST', '/api/rooms', { name: '友军伤害房', matchType: 'custom' })
    const ffRoomId = r.data.id
    check('friendlyFire default on (create)', r.data.friendlyFire === true, JSON.stringify(r.data?.friendlyFire))
    await req('POST', `/api/rooms/${ffRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    r = await req('POST', `/api/rooms/${ffRoomId}/config`, { friendlyFire: false })
    check('friendlyFire off via config', r.status === 200 && r.data.friendlyFire === false, JSON.stringify(r.data?.friendlyFire))
    r = await req('GET', `/api/rooms/${ffRoomId}`, null)
    check('friendlyFire off persisted in room', r.data.friendlyFire === false, JSON.stringify(r.data?.friendlyFire))
    await req('POST', `/api/rooms/${ffRoomId}/directpick`, { mapId: 'de_mirage' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${ffRoomId}/join`, {})
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${ffRoomId}/start`, {})
    check('friendlyFire off match starts', r.status === 200, JSON.stringify(r.data))
    const { DatabaseSync: SdbFF } = await import('node:sqlite')
    const sdbFF = new SdbFF(path.join(STUB_DIR, 'arena.db'))
    const ffPayload = JSON.parse(sdbFF.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(ffRoomId).payload)
    check(
      'friendlyFire off payload cvars 下发关闭指令',
      ffPayload.cvars.mp_friendlyfire === '1' && ffPayload.cvars.ff_damage_reduction_bullets === '0',
      JSON.stringify(ffPayload.cvars),
    )
    check(
      'custom 房 payload 显式下发 24 局及默认加时',
      ffPayload.cvars.mp_maxrounds === '24' && ffPayload.cvars.mp_overtime_enable === '1' && ffPayload.cvars.mp_halftime === '1',
      JSON.stringify(ffPayload.cvars),
    )
    check(
      'friendlyFire off payload 附带开局公告(两行,含投掷物提醒)',
      ffPayload.cvars.matchzy_match_start_message?.includes('$$$注意！') &&
        ffPayload.cvars.matchzy_match_start_message.includes('友军伤害 {Red}已关闭{Default}') &&
        ffPayload.cvars.matchzy_match_start_message.includes('{Red}手雷、燃烧弹{Default}'),
      JSON.stringify(ffPayload.cvars.matchzy_match_start_message),
    )
    r = await req('POST', `/api/rooms/${ffRoomId}/config`, { friendlyFire: true })
    check('friendlyFire back on via config', r.status === 200 && r.data.friendlyFire === true, JSON.stringify(r.data?.friendlyFire))
    await req('DELETE', `/api/rooms/${ffRoomId}`, {})
    cookie = adminCookie
    await req('POST', '/api/instances/main/reset', {})
    cookie = hostCookie

    // ============ 单挑对决开局 cfg(回合局数/无加时/冻结/回合时间/半场交换,2026-09-19) ============
    // 单元:duel 房 → cvars(经比赛 JSON 覆盖 live.cfg);custom 房 → 不写
    const unitDuel = (extra) => mj.buildMatchJson({
      matchId: 1,
      room: { slots: [], teamAName: 'A', teamBName: 'B', bestOf: 1, knifeRound: false, pickMode: 'direct', ...extra },
      maplist: ['de_mirage'],
      playersPerTeam: 1,
      minPlayersToReady: 2,
      publicBaseUrl: 'http://x',
      token: 't',
    }).cvars
    const duelCvarsDefault = unitDuel({ matchType: 'duel' })
    check(
      'unit: duel 默认 cvars(31 局/无加时/冻结 1s/回合 1.5min/换边门控+无半场/禁购买)',
      duelCvarsDefault.mp_maxrounds === '31' &&
        duelCvarsDefault.mp_overtime_enable === '0' &&
        duelCvarsDefault.mp_freezetime === '1' &&
        duelCvarsDefault.mp_roundtime === '1.5' &&
        duelCvarsDefault.mp_roundtime_defuse === '1.5' &&
        duelCvarsDefault.mp_roundtime_hostage === '1.5' &&
        duelCvarsDefault.mp_halftime === '0' &&
        duelCvarsDefault.arena_duel_roundswap === '1',
      JSON.stringify(duelCvarsDefault),
    )
    check('unit: duel 房 maxRounds=21 → mp_maxrounds 21', unitDuel({ matchType: 'duel', maxRounds: 21 }).mp_maxrounds === '21', JSON.stringify(unitDuel({ matchType: 'duel', maxRounds: 21 })))
    check('unit: custom 房 MR12/MR3 默认加时参数', unitDuel({}).mp_maxrounds === '24' && unitDuel({}).mp_overtime_enable === '1' && unitDuel({}).mp_halftime === '1' && unitDuel({}).mp_overtime_maxrounds === '6' && unitDuel({}).mp_overtime_startmoney === '16000', JSON.stringify(unitDuel({})))
    const unitSolo = unitDuel({ matchType: 'duel', duelPreset: 'solo' })
    check(
      'unit: solo cvars(51 回合 + 阶段 10/28/13 + arena_duel_preset)',
      unitSolo.mp_maxrounds === '51' &&
        unitSolo.arena_duel_preset === 'solo' &&
        unitSolo.arena_duel_phase_pistol === '10' &&
        unitSolo.arena_duel_phase_rifle === '28' &&
        unitSolo.arena_duel_phase_sniper === '13' &&
        unitSolo.mp_buytime === '0',
      JSON.stringify(unitSolo),
    )
    check('unit: rifle cvars 带 mp_buytime 0 + arena_duel_preset rifle', unitDuel({ matchType: 'duel' }).mp_buytime === '0' && unitDuel({ matchType: 'duel' }).arena_duel_preset === 'rifle', JSON.stringify(unitDuel({ matchType: 'duel' })))

    // E2E:房间字段与 /config 校验(仅 duel 房;奇数;null 恢复默认)
    r = await req('POST', '/api/rooms', { name: '单挑cfg房', matchType: 'duel' })
    const duelCfgRoomId = r.data.id
    check('duel 房默认回合局数 31', r.data.maxRounds === 31, JSON.stringify(r.data?.maxRounds))
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { maxRounds: 15 })
    check('duel 房 maxRounds 非房主拒绝 (403)', r.status === 403, JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { maxRounds: 16 })
    check('duel 房 maxRounds 偶数拒绝 (400)', r.status === 400 && /单数/.test(r.data.error ?? ''), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { maxRounds: 0 })
    check('duel 房 maxRounds 低于下限拒绝 (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { maxRounds: 102 })
    check('duel 房 maxRounds 高于上限拒绝 (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { maxRounds: 'x' })
    check('duel 房 maxRounds 非整数拒绝 (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { maxRounds: 21 })
    check('duel 房 maxRounds 改为 21', r.status === 200 && r.data.maxRounds === 21, JSON.stringify(r.data?.maxRounds))
    // 单挑房人数(默认 1v1;仅管理员可改,用于测试非 1v1)
    check('duel 房默认 1v1', r.data.teamA === 1 && r.data.teamB === 1, JSON.stringify({ a: r.data?.teamA, b: r.data?.teamB }))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { teamA: 3 })
    check('duel 房人数改由非管理员拒绝 (403)', r.status === 403 && /仅管理员/.test(r.data.error), JSON.stringify(r.data))
    cookie = adminCookie
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { teamA: 3, teamB: 2 })
    check('duel 房人数管理员可改 (3v2)', r.status === 200 && r.data.teamA === 3 && r.data.teamB === 2, JSON.stringify({ a: r.data?.teamA, b: r.data?.teamB }))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { teamA: 1, teamB: 1 })
    check('duel 房人数改回 1v1', r.status === 200 && r.data.teamA === 1 && r.data.teamB === 1)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { maxRounds: null })
    check('duel 房 maxRounds 清除 → 回默认 31', r.status === 200 && r.data.maxRounds === 31, JSON.stringify(r.data?.maxRounds))
    // 玩法类型:默认 rifle(长枪决斗);solo 锁 51 并禁改局数;非法值/非 duel 房 400
    check('duel 房默认玩法类型 rifle(长枪决斗)', r.data.duelPreset === 'rifle', JSON.stringify(r.data?.duelPreset))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { duelPreset: 'solo' })
    check('duel 房切 Solo三项 → maxRounds 生效 51', r.status === 200 && r.data.duelPreset === 'solo' && r.data.maxRounds === 51, JSON.stringify({ p: r.data?.duelPreset, m: r.data?.maxRounds }))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { maxRounds: 31 })
    check('solo 房改回合局数 400(锁定 51)', r.status === 400 && /Solo三项/.test(r.data.error ?? ''), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { duelPreset: 'rifle' })
    check('duel 房切回长枪决斗 → maxRounds 回默认 31', r.status === 200 && r.data.duelPreset === 'rifle' && r.data.maxRounds === 31, JSON.stringify({ p: r.data?.duelPreset, m: r.data?.maxRounds }))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { duelPreset: 'pistol' })
    check('duel 房切手枪决斗(默认 31)', r.status === 200 && r.data.duelPreset === 'pistol' && r.data.maxRounds === 31, JSON.stringify({ p: r.data?.duelPreset, m: r.data?.maxRounds }))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { duelPreset: 'weird' })
    check('duel 房非法玩法类型 400', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { duelPreset: 'rifle', maxRounds: 9, mapPoolKind: 'duel' })
    check('duel 房 maxRounds 与 mapPoolKind 同请求生效(9 局/单挑图池)', r.status === 200 && r.data.maxRounds === 9 && r.data.mapPoolKind === 'duel', JSON.stringify({ m: r.data?.maxRounds, k: r.data?.mapPoolKind }))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { mapPoolKind: 'total' })
    check('duel 房切回总池:选图清空但局数保留', r.status === 200 && r.data.maxRounds === 9 && r.data.picked.length === 0, JSON.stringify({ m: r.data?.maxRounds, p: r.data?.picked }))
    // custom 房间不可设置;拼刀选边默认关闭(全模式,2026-09-19),custom 可自行开启
    cookie = adminCookie // 同上:同一 host 的「单挑cfg房」还没结束,对照房走管理员
    r = await req('POST', '/api/rooms', { name: '非单挑cfg房', matchType: 'custom' })
    const customCfgRoomId = r.data.id
    check('custom 房创建默认关闭拼刀选边(全模式默认关刀)', r.data.knifeRound === false, JSON.stringify(r.data?.knifeRound))
    r = await req('POST', `/api/rooms/${customCfgRoomId}/config`, { maxRounds: 9 })
    check('custom 房传 maxRounds 400(仅 duel)', r.status === 400 && /仅单挑对决/.test(r.data.error ?? ''), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${customCfgRoomId}/config`, { knifeRound: true })
    check('custom 房可开启拼刀选边', r.status === 200 && r.data.knifeRound === true, JSON.stringify(r.data?.knifeRound))
    r = await req('POST', `/api/rooms/${customCfgRoomId}/config`, { duelPreset: 'rifle' })
    check('custom 房传 duelPreset 400(仅 duel)', r.status === 400 && /仅单挑对决/.test(r.data.error ?? ''), JSON.stringify(r.data))
    await req('DELETE', `/api/rooms/${customCfgRoomId}`, {})
    cookie = hostCookie

    // 开赛:duel 房比赛 JSON cvars 携带单挑开局 cfg(custom 房不携带)
    // (上一步已把池切回总竞技图池 → 本用例可用官方图;duel 房默认池见创建用例)
    await req('POST', `/api/rooms/${duelCfgRoomId}/directpick`, { mapId: 'de_mirage' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${duelCfgRoomId}/join`, {})
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/start`, {})
    check('duel 房开赛成功', r.status === 200, JSON.stringify(r.data))
    const { DatabaseSync: SdbDuel } = await import('node:sqlite')
    const sdbDuel = new SdbDuel(path.join(STUB_DIR, 'arena.db'))
    const duelPayload = JSON.parse(sdbDuel.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(duelCfgRoomId).payload)
    check(
      'duel 开赛 payload cvars=单挑开局 cfg(9 局/无加时/冻结 1s/回合 1.5min/换边门控+无半场/禁购买)',
      duelPayload.cvars.mp_maxrounds === '9' &&
        duelPayload.cvars.mp_overtime_enable === '0' &&
        duelPayload.cvars.mp_freezetime === '1' &&
        duelPayload.cvars.mp_roundtime === '1.5' &&
        duelPayload.cvars.mp_halftime === '0' &&
        duelPayload.cvars.arena_duel_roundswap === '1',
      JSON.stringify(duelPayload.cvars),
    )
    check('duel 开赛 payload map_sides 无刀局(固定 team1_ct)', JSON.stringify(duelPayload.map_sides) === JSON.stringify(['team1_ct']), JSON.stringify(duelPayload.map_sides))
    check('duel 开赛 payload 禁购买/无C4 + 玩法类型(长枪决斗)', duelPayload.cvars.mp_buytime === '0' && duelPayload.cvars.mp_give_player_c4 === '0' && duelPayload.cvars.arena_duel_preset === 'rifle', JSON.stringify({ b: duelPayload.cvars.mp_buytime, c4: duelPayload.cvars.mp_give_player_c4, p: duelPayload.cvars.arena_duel_preset }))
    // 拼刀选边:duel 房禁止开启(400);false 为 no-op 放行(兼容旧端)
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { knifeRound: true })
    check('duel 房开启拼刀选边 400(接口禁设)', r.status === 400 && /拼刀选边/.test(r.data.error ?? ''), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${duelCfgRoomId}/config`, { knifeRound: false })
    check('duel 房 knifeRound:false 放行且局数保留', r.status === 200 && r.data.knifeRound === false && r.data.maxRounds === 9, JSON.stringify({ k: r.data?.knifeRound, m: r.data?.maxRounds }))
    await req('DELETE', `/api/rooms/${duelCfgRoomId}`, {})
    cookie = adminCookie
    await req('POST', '/api/instances/main/reset', {})
    cookie = hostCookie

    // Solo三项 E2E:51 回合 + 阶段 cvars(10/28/13)经开赛链路下发
    r = await req('POST', '/api/rooms', { name: '单挑solo房', matchType: 'duel' })
    const duelSoloRoomId = r.data.id
    await req('POST', `/api/rooms/${duelSoloRoomId}/config`, { duelPreset: 'solo' })
    await req('POST', `/api/rooms/${duelSoloRoomId}/config`, { mapPoolKind: 'total' })
    await req('POST', `/api/rooms/${duelSoloRoomId}/directpick`, { mapId: 'de_mirage' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${duelSoloRoomId}/join`, {})
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${duelSoloRoomId}/start`, {})
    check('solo 房开赛成功', r.status === 200, JSON.stringify(r.data))
    const soloPayload = JSON.parse(sdbDuel.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(duelSoloRoomId).payload)
    check(
      'solo 开赛 payload:51 回合 + 阶段 10/28/13 + arena_duel_preset solo + 禁购买',
      soloPayload.cvars.mp_maxrounds === '51' &&
        soloPayload.cvars.arena_duel_preset === 'solo' &&
        soloPayload.cvars.arena_duel_phase_pistol === '10' &&
        soloPayload.cvars.arena_duel_phase_rifle === '28' &&
        soloPayload.cvars.arena_duel_phase_sniper === '13' &&
        soloPayload.cvars.mp_buytime === '0',
      JSON.stringify(soloPayload.cvars),
    )
    await req('DELETE', `/api/rooms/${duelSoloRoomId}`, {})
    cookie = adminCookie
    await req('POST', '/api/instances/main/reset', {})
    cookie = hostCookie

    // ============ 实例最大玩家数(-maxplayers):全局默认(管理面板) + 房间级覆盖(管理员专用) ============
    r = await req('GET', '/api/settings/max-players', null)
    check(
      'max-players 默认 12 / 范围 2~64 / SourceTV 占 1 席',
      r.status === 200 && r.data.maxPlayers === 12 && r.data.min === 2 && r.data.max === 64 && r.data.tvSlots === 1,
      JSON.stringify(r.data),
    )
    cookie = guestCookie
    r = await req('PUT', '/api/settings/max-players', { maxPlayers: 16 })
    check('max-players 非管理员拒绝 (403)', r.status === 403, JSON.stringify(r.data))
    cookie = adminCookie
    r = await req('PUT', '/api/settings/max-players', { maxPlayers: 1 })
    check('max-players 越界拒绝 (400)', r.status === 400 && /2~64/.test(r.data.error), JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/max-players', { maxPlayers: 16 })
    check('max-players 更新为 16(全局默认)', r.status === 200 && r.data.maxPlayers === 16, JSON.stringify(r.data))

    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '容量房', matchType: 'custom' })
    const mpRoomId = r.data.id
    check(
      '房间默认跟随全局最大玩家数(16/无覆盖)',
      r.data.maxPlayers === 16 && r.data.maxPlayersOverride === null,
      JSON.stringify({ m: r.data?.maxPlayers, o: r.data?.maxPlayersOverride }),
    )
    r = await req('POST', `/api/rooms/${mpRoomId}/config`, { maxPlayers: 20 })
    check('房间级 maxPlayers 非管理员拒绝 (403)', r.status === 403 && /仅管理员/.test(r.data.error), JSON.stringify(r.data))
    cookie = adminCookie
    r = await req('POST', `/api/rooms/${mpRoomId}/config`, { maxPlayers: 24 })
    check(
      '房间级 maxPlayers 管理员可改(生效 24)',
      r.status === 200 && r.data.maxPlayers === 24 && r.data.maxPlayersOverride === 24,
      JSON.stringify({ m: r.data?.maxPlayers, o: r.data?.maxPlayersOverride }),
    )
    r = await req('POST', `/api/rooms/${mpRoomId}/config`, { specSeats: 16 }) // 5+5+16=26 > 可用 23
    check('容量守卫按房间最大玩家数拒绝 (400)', r.status === 400 && /容量超限/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${mpRoomId}/config`, { maxPlayers: 8 }) // 5+5+1=11 > 可用 7
    check('下调最大玩家数后容量守卫拒绝 (400)', r.status === 400 && /容量超限/.test(r.data.error), JSON.stringify(r.data))

    // 开赛:房间生效值经桥以 MAXPLAYERS 环境变量进入实例启动项(stub 日志断言)
    await req('POST', `/api/rooms/${mpRoomId}/config`, { maxPlayers: 24, teamA: 1, teamB: 1, pickMode: 'direct' })
    await req('POST', `/api/rooms/${mpRoomId}/directpick`, { mapId: 'de_mirage' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${mpRoomId}/join`, {})
    cookie = adminCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${mpRoomId}/start`, {})
    check('容量房开赛成功', r.status === 200, JSON.stringify(r.data))
    const mpLog = readFileSync(path.join(STUB_DIR, `${r.data?.instance}.log`), 'utf8')
    check('实例启动项带房间级 -maxplayers(MAXPLAYERS=24)', /MAXPLAYERS=24/.test(mpLog), mpLog.split('\n').filter((l) => l.includes('MAXPLAYERS')).slice(-2).join(' | '))
    await req('DELETE', `/api/rooms/${mpRoomId}`, {})
    await req('POST', '/api/instances/main/reset', {})

    // 清除房间覆盖 → 跟随全局默认;并恢复全局默认 12(后续用例仍按 11 可用席做守卫)
    r = await req('POST', '/api/rooms', { name: '容量房2', matchType: 'custom' })
    const mpRoom2Id = r.data.id
    await req('POST', `/api/rooms/${mpRoom2Id}/config`, { maxPlayers: 20 })
    r = await req('POST', `/api/rooms/${mpRoom2Id}/config`, { maxPlayers: null })
    check(
      '清空房间覆盖后跟随全局默认',
      r.status === 200 && r.data.maxPlayers === 16 && r.data.maxPlayersOverride === null,
      JSON.stringify({ m: r.data?.maxPlayers, o: r.data?.maxPlayersOverride }),
    )
    await req('POST', `/api/rooms/${mpRoom2Id}/config`, { teamA: 1, teamB: 1, pickMode: 'direct' })
    await req('POST', `/api/rooms/${mpRoom2Id}/directpick`, { mapId: 'de_inferno' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${mpRoom2Id}/join`, {})
    cookie = adminCookie
    r = await req('POST', `/api/rooms/${mpRoom2Id}/start`, {})
    const mpLog2 = readFileSync(path.join(STUB_DIR, `${r.data?.instance}.log`), 'utf8')
    check('无房间覆盖时启动项用全局默认(MAXPLAYERS=16)', /MAXPLAYERS=16/.test(mpLog2), mpLog2.split('\n').filter((l) => l.includes('MAXPLAYERS')).slice(-2).join(' | '))
    await req('DELETE', `/api/rooms/${mpRoom2Id}`, {})
    await req('POST', '/api/instances/main/reset', {})
    r = await req('PUT', '/api/settings/max-players', { maxPlayers: 12 })
    check('max-players 恢复默认 12', r.status === 200 && r.data.maxPlayers === 12, JSON.stringify(r.data))
    cookie = hostCookie

    // ============ 换位(双向同意,含观战) ============
    r = await req('POST', '/api/rooms', { name: '换位房', matchType: 'custom' })
    const swapRoomId = r.data.id
    await req('POST', `/api/rooms/${swapRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1, specSeats: 2 })
    await req('POST', `/api/rooms/${swapRoomId}/directpick`, { mapId: 'de_inferno' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${swapRoomId}/join`, {}) // B → t
    r = await req('POST', '/api/auth/login', { steamId: '76561190000000003', name: '玩家C', avatarUrl: '' })
    const cCookie = cookie
    r = await req('POST', `/api/rooms/${swapRoomId}/join`, {}) // C → spec
    check('C joins as spectator', r.data.slots.find((s) => s.player.steamId === '76561190000000003')?.team === 'spec')

    // A(ct) 申请与 B(t) 换位
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${swapRoomId}/swap/request`, { targetPlayerId: '76561190000000002' })
    check('swap request ok + pendingSwap visible', r.status === 200 && r.data.pendingSwap?.targetPlayerId === '76561190000000002')
    r = await req('POST', `/api/rooms/${swapRoomId}/swap/respond`, { targetPlayerId: '76561190000000002', accept: true })
    check('non-target respond rejected (403)', r.status === 403)
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${swapRoomId}/swap/respond`, { targetPlayerId: '76561190000000001', accept: true })
    check('swap respond accept ok', r.status === 200)
    const teamOfA = r.data.slots.find((s) => s.player.steamId === '76561190000000001')?.team
    const teamOfB = r.data.slots.find((s) => s.player.steamId === '76561190000000002')?.team
    check('swap executed (teams exchanged)', teamOfA === 't' && teamOfB === 'ct', `${teamOfA}/${teamOfB}`)
    check('captain recalc after captain swap', r.data.captainA === '76561190000000002' && r.data.captainB === '76561190000000001', JSON.stringify({ a: r.data.captainA, b: r.data.captainB }))

    // 观战换位:B(ct) 申请与 C(spec) 换位
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${swapRoomId}/swap/request`, { targetPlayerId: '76561190000000003' })
    check('spec swap request ok', r.status === 200)
    cookie = cCookie
    r = await req('POST', `/api/rooms/${swapRoomId}/swap/respond`, { targetPlayerId: '76561190000000002', accept: true })
    check('spec swap accept ok', r.status === 200)
    const teamOfB2 = r.data.slots.find((s) => s.player.steamId === '76561190000000002')?.team
    const teamOfC = r.data.slots.find((s) => s.player.steamId === '76561190000000003')?.team
    check('spec swap executed', teamOfB2 === 'spec' && teamOfC === 'ct', `${teamOfB2}/${teamOfC}`)

    // 再次换位:A(t) 申请与 C(ct) 换位(覆盖旧申请)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${swapRoomId}/swap/request`, { targetPlayerId: '76561190000000003' })
    check('second swap request ok', r.status === 200 && r.data.pendingSwap?.fromPlayerId === '76561190000000001')
    cookie = cCookie
    r = await req('POST', `/api/rooms/${swapRoomId}/swap/respond`, { targetPlayerId: '76561190000000001', accept: true })
    check('second swap executed', r.status === 200)
    const teamOfA2 = r.data.slots.find((s) => s.player.steamId === '76561190000000001')?.team
    const teamOfC2 = r.data.slots.find((s) => s.player.steamId === '76561190000000003')?.team
    check('second swap teams exchanged', teamOfA2 === 'ct' && teamOfC2 === 't', `${teamOfA2}/${teamOfC2}`)
    cookie = hostCookie // 删除需房主(此前遗留 cCookie → 403,残留房间会撞单房间守卫)
    await req('DELETE', `/api/rooms/${swapRoomId}`, {})

    // ============ 移交队长 + 随机分队(2v2) ============
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '队长与随机房', matchType: 'custom' })
    const capRoomId = r.data.id
    await req('POST', `/api/rooms/${capRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 2, teamB: 2 })
    cookie = guestCookie
    await req('POST', `/api/rooms/${capRoomId}/join`, {}) // B → t
    cookie = cCookie
    await req('POST', `/api/rooms/${capRoomId}/join`, {}) // C → ct
    r = await req('POST', '/api/auth/login', { steamId: '76561190000000004', name: '玩家D', avatarUrl: '' })
    const dCookie = cookie
    await req('POST', `/api/rooms/${capRoomId}/join`, {}) // D → t
    r = await req('GET', `/api/rooms/${capRoomId}`, null)
    check('default captains (first members)', r.data.captainA === '76561190000000001' && r.data.captainB === '76561190000000002')
    const beforeTeams = {}
    for (const s of r.data.slots) beforeTeams[s.player.steamId] = s.team
    check('teams set (A/C ct, B/D t)', beforeTeams['76561190000000001'] === 'ct' && beforeTeams['76561190000000003'] === 'ct' && beforeTeams['76561190000000002'] === 't' && beforeTeams['76561190000000004'] === 't', JSON.stringify(beforeTeams))

    // 移交队长
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${capRoomId}/captain/transfer`, { targetPlayerId: '76561190000000003' })
    check('captain transfer ok', r.status === 200 && r.data.captainA === '76561190000000003', JSON.stringify({ status: r.status, captainA: r.data?.captainA }))
    // C(新队长)跨队移交给 D → 400
    cookie = cCookie
    r = await req('POST', `/api/rooms/${capRoomId}/captain/transfer`, { targetPlayerId: '76561190000000004' })
    check('transfer cross-team rejected (400)', r.status === 400, JSON.stringify(r.data))
    // A(已非队长)尝试移交 → 403
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${capRoomId}/captain/transfer`, { targetPlayerId: '76561190000000003' })
    check('non-captain transfer rejected (403)', r.status === 403, JSON.stringify(r.data))
    // B(队长B)移交 D → 200
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${capRoomId}/captain/transfer`, { targetPlayerId: '76561190000000004' })
    check('captainB transfer ok', r.status === 200 && r.data.captainB === '76561190000000004', JSON.stringify(r.data))

    // 同队换位拒绝(A ct 申请与 C ct)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${capRoomId}/swap/request`, { targetPlayerId: '76561190000000003' })
    check('same-team swap rejected (400)', r.status === 400, JSON.stringify(r.data))

    // 随机分队 includeCaptains=false:队长(C=ct, D=t)保持
    r = await req('POST', `/api/rooms/${capRoomId}/shuffle`, { includeCaptains: false })
    check('shuffle ok (includeCaptains=false)', r.status === 200)
    const after1 = {}
    for (const s of r.data.slots) after1[s.player.steamId] = s.team
    const changes1 = Object.keys(beforeTeams).filter((id) => beforeTeams[id] !== after1[id]).length
    check('shuffle keeps counts (2/2)', Object.values(after1).filter((t) => t === 'ct').length === 2 && Object.values(after1).filter((t) => t === 't').length === 2)
    check('shuffle changes >= 2 players', changes1 >= 2, `changes=${changes1}`)
    check('shuffle keeps captains in own teams', after1['76561190000000003'] === 'ct' && after1['76561190000000004'] === 't', JSON.stringify(after1))

    // includeCaptains=true(与上一轮结果比较,防"复原"误判)
    r = await req('POST', `/api/rooms/${capRoomId}/shuffle`, { includeCaptains: true })
    check('shuffle ok (includeCaptains=true)', r.status === 200)
    const after2 = {}
    for (const s of r.data.slots) after2[s.player.steamId] = s.team
    const changes2 = Object.keys(after1).filter((id) => after1[id] !== after2[id]).length
    check('shuffle full changes >= 2', changes2 >= 2, `changes=${changes2}`)
    check('shuffle recalc captains in own teams', after2[r.data.captainA] === 'ct' && after2[r.data.captainB] === 't', JSON.stringify({ a: r.data.captainA, b: r.data.captainB, after2 }))

    // 防无效随机确定性回归:连续 5 次洗牌,每次换队 ≥2 人
    const baseline = {}
    for (const s of r.data.slots) baseline[s.player.steamId] = s.team
    let allOk = true
    let roundInfo = []
    for (let i = 0; i < 5; i++) {
      r = await req('POST', `/api/rooms/${capRoomId}/shuffle`, { includeCaptains: true })
      const cur = {}
      for (const s of r.data.slots) cur[s.player.steamId] = s.team
      const ch = Object.keys(baseline).filter((id) => baseline[id] !== cur[id]).length
      roundInfo.push(ch)
      if (ch < 2) allOk = false
      for (const id of Object.keys(cur)) baseline[id] = cur[id]
    }
    check('shuffle deterministic: 5 rounds all >= 2 changes', allOk, `rounds=${roundInfo.join(',')}`)

    // 非房主随机分队拒绝
    cookie = cCookie
    r = await req('POST', `/api/rooms/${capRoomId}/shuffle`, { includeCaptains: true })
    check('shuffle non-host rejected (403)', r.status === 403)
    cookie = hostCookie // 同上:删除需房主
    await req('DELETE', `/api/rooms/${capRoomId}`, {})
    cookie = guestCookie

    // ============ 槽位级换位(slot 精确落位) ============
    const slotOf = (room, steamId) => {
      const s = room.slots.find((x) => x.player.steamId === steamId)
      return s ? `${s.team}:${s.slot}` : 'none'
    }
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '槽位房', matchType: 'custom' })
    const slotRoomId = r.data.id
    await req('POST', `/api/rooms/${slotRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 4, teamB: 2, specSeats: 2 })
    r = await req('GET', `/api/rooms/${slotRoomId}`, null)
    check('host seeded at ct slot 0', slotOf(r.data, '76561190000000001') === 'ct:0', JSON.stringify(r.data.slots))
    cookie = guestCookie
    await req('POST', `/api/rooms/${slotRoomId}/join`, {}) // B → t0
    cookie = cCookie
    await req('POST', `/api/rooms/${slotRoomId}/join`, {}) // C → ct1
    cookie = dCookie
    await req('POST', `/api/rooms/${slotRoomId}/join`, {}) // D → t1
    r = await req('POST', '/api/auth/login', { steamId: '76561190000000005', name: '玩家E', avatarUrl: '' })
    const eCookie = cookie
    await req('POST', `/api/rooms/${slotRoomId}/join`, {}) // E → ct2
    r = await req('GET', `/api/rooms/${slotRoomId}`, null)
    check(
      'join assigns min free slots (B t0/C ct1/D t1/E ct2)',
      slotOf(r.data, '76561190000000002') === 't:0' && slotOf(r.data, '76561190000000003') === 'ct:1' && slotOf(r.data, '76561190000000004') === 't:1' && slotOf(r.data, '76561190000000005') === 'ct:2',
      JSON.stringify(r.data.slots.map((s) => `${s.team}:${s.slot}:${s.player.steamId.slice(-1)}`)),
    )

    // 同队槽位移位:C ct1 → ct3(原槽留空,不压缩)
    cookie = cCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/setteam`, { team: 'ct', slot: 3 })
    check('same-team slot shift ok (C ct3)', r.status === 200 && slotOf(r.data, '76561190000000003') === 'ct:3', JSON.stringify(r.data.slots))
    // 占用槽拒绝:ct0 = A
    r = await req('POST', `/api/rooms/${slotRoomId}/setteam`, { team: 'ct', slot: 0 })
    check('occupied slot rejected (409)', r.status === 409 && /占用/.test(r.data.error), JSON.stringify(r.data))
    // 越界槽拒绝:teamA=4 → 合法 0..3
    r = await req('POST', `/api/rooms/${slotRoomId}/setteam`, { team: 'ct', slot: 4 })
    check('slot out of range rejected (400)', r.status === 400 && /槽位/.test(r.data.error), JSON.stringify(r.data))
    // 无 slot 换队:D → spec(自动观战席最小空槽 0)
    cookie = dCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/setteam`, { team: 'spec' })
    check('setteam without slot fills min free slot (D spec0)', r.status === 200 && slotOf(r.data, '76561190000000004') === 'spec:0', JSON.stringify(r.data.slots))
    // 房主 move 指定槽跨队:A → t1(D 离开后的空洞)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/move`, { playerId: '76561190000000001', team: 't', slot: 1 })
    check('host move to targeted cross-team slot ok (A t1)', r.status === 200 && slotOf(r.data, '76561190000000001') === 't:1', JSON.stringify(r.data.slots))
    // 目标槽占用拒绝:t0 = B
    r = await req('POST', `/api/rooms/${slotRoomId}/setteam`, { team: 't', slot: 0 })
    check('target occupied slot rejected (409)', r.status === 409 && /占用/.test(r.data.error), JSON.stringify(r.data))
    // 加入补最小空槽:F → ct0(A 离开 ct 留下的空洞)
    r = await req('POST', '/api/auth/login', { steamId: '76561190000000006', name: '玩家F', avatarUrl: '' })
    await req('POST', `/api/rooms/${slotRoomId}/join`, {})
    r = await req('GET', `/api/rooms/${slotRoomId}`, null)
    check('join fills min free slot hole (F ct0)', slotOf(r.data, '76561190000000006') === 'ct:0', JSON.stringify(r.data.slots))

    // 换位成交互换 slot:A(t1) ↔ C(ct3)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/swap/request`, { targetPlayerId: '76561190000000003' })
    check('slot swap request ok', r.status === 200)
    cookie = cCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/swap/respond`, { targetPlayerId: '76561190000000001', accept: true })
    check('swap exchanges slots (A ct3 / C t1)', r.status === 200 && slotOf(r.data, '76561190000000001') === 'ct:3' && slotOf(r.data, '76561190000000003') === 't:1', JSON.stringify(r.data.slots))

    // 随机分队后每队槽位连续无空洞(0..n-1)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/shuffle`, { includeCaptains: true })
    const ctSlotsAfter = r.data.slots.filter((s) => s.team === 'ct').map((s) => s.slot).sort((a, b) => a - b)
    const tSlotsAfter = r.data.slots.filter((s) => s.team === 't').map((s) => s.slot).sort((a, b) => a - b)
    check('shuffle slots contiguous 0..n-1 (ct)', JSON.stringify(ctSlotsAfter) === JSON.stringify([0, 1, 2]), JSON.stringify(ctSlotsAfter))
    check('shuffle slots contiguous 0..n-1 (t)', JSON.stringify(tSlotsAfter) === JSON.stringify([0, 1]), JSON.stringify(tSlotsAfter))

    // 缩容压缩:teamA 4→1,超员 ct 移观战(观战席最小空槽),剩余 ct 压缩 0..n-1
    r = await req('POST', `/api/rooms/${slotRoomId}/config`, { teamA: 1 })
    const specSlotsShrunk = r.data.slots.filter((s) => s.team === 'spec').map((s) => s.slot).sort((a, b) => a - b)
    const ctSlotsShrunk = r.data.slots.filter((s) => s.team === 'ct').map((s) => s.slot).sort((a, b) => a - b)
    check('config shrink: overflow ct to spec min free slot', JSON.stringify(specSlotsShrunk) === JSON.stringify([0, 1, 2]), JSON.stringify(r.data.slots.map((s) => `${s.team}:${s.slot}`)))
    check('config shrink: remaining ct compacted 0..n-1', JSON.stringify(ctSlotsShrunk) === JSON.stringify([0]), JSON.stringify(ctSlotsShrunk))

    // 观战席上限:无 slot 的换位同样受 specSeats 限制(此前 spec 豁免 → 可无限堆入观战席,
    // 观战人数既超配置、又让开赛容量校验(按 spec_seats 计)与实际不符)。
    // 此刻 spec 已有 3 人(specSeats=2),任何再申请都应被拒(不论申请人当前在哪一队)
    cookie = eCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/setteam`, { team: 'spec' })
    check('setteam to full spec rejected (409)', r.status === 409 && /观战席已满/.test(r.data.error), JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/move`, { playerId: '76561190000000005', team: 'spec' })
    check('host move to full spec rejected (409)', r.status === 409 && /观战席已满/.test(r.data.error), JSON.stringify(r.data))
    // 带 slot 的路径同样受 specSeats 约束(slot 索引越界 = 400)
    r = await req('POST', `/api/rooms/${slotRoomId}/move`, { playerId: '76561190000000005', team: 'spec', slot: 2 })
    check('move to out-of-range spec slot rejected (400)', r.status === 400 && /槽位/.test(r.data.error), JSON.stringify(r.data))

    // 自动补位开关(房间级,房主可控):默认关;非房主 403;房主切换持久化
    r = await req('GET', `/api/rooms/${slotRoomId}`, null)
    check('autoFill default off', r.data.autoFill === false)
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/config`, { autoFill: true })
    check('autoFill non-host rejected (403)', r.status === 403 && r.data.autoFill === undefined, JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${slotRoomId}/config`, { autoFill: true })
    check('autoFill host on persists', r.status === 200 && r.data.autoFill === true)
    r = await req('POST', `/api/rooms/${slotRoomId}/config`, { autoFill: false })
    check('autoFill host off persists', r.status === 200 && r.data.autoFill === false)

    // 开赛守卫同样按"实际观战人数"计容量(与 config 守卫同一口径;这里直改库模拟存量数据):
    // 队伍缩容会把超员移入观战席 → 实际观战数可 > specSeats,只按配置计会少算座位
    // (单房间守卫后:先把槽位房删掉,同一 host 才能再建"开赛容量房")
    await req('DELETE', `/api/rooms/${slotRoomId}`, {})
    r = await req('POST', '/api/rooms', { name: '开赛容量房', matchType: 'custom' })
    const capStartRoomId = r.data.id
    await req('POST', `/api/rooms/${capStartRoomId}/config`, { teamA: 3, teamB: 1, specSeats: 1, pickMode: 'direct' })
    await req('POST', `/api/rooms/${capStartRoomId}/directpick`, { mapId: 'de_inferno' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${capStartRoomId}/join`, {}) // B → ct1
    cookie = cCookie
    await req('POST', `/api/rooms/${capStartRoomId}/join`, {}) // C → ct2
    cookie = dCookie
    await req('POST', `/api/rooms/${capStartRoomId}/join`, {}) // D → t0
    cookie = eCookie
    await req('POST', `/api/rooms/${capStartRoomId}/join`, {}) // E → spec0
    cookie = hostCookie
    await req('POST', `/api/rooms/${capStartRoomId}/config`, { teamA: 1 }) // ct 超员 2 人移入观战席 → 实际观战 3 > specSeats 1
    const { DatabaseSync: SdbCap } = await import('node:sqlite')
    const sdbCap = new SdbCap(path.join(STUB_DIR, 'arena.db'))
    sdbCap.prepare('UPDATE rooms SET max_players = 4 WHERE id = ?').run(capStartRoomId) // 可用 3 席:按配置(1+1+1)贴线,按实际(1+1+3)已超
    r = await req('POST', `/api/rooms/${capStartRoomId}/start`, {})
    check('start guard counts actual spec seats (500/容量超限)', r.status === 500 && /容量超限/.test(r.data.error), JSON.stringify(r.data))
    await req('DELETE', `/api/rooms/${capStartRoomId}`, {})

    cookie = guestCookie

    // ============ 断线自动退房(宽限期未重连则移除;房主离开即解散) ============
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '断线退房', matchType: 'custom' })
    const dcRoomId = r.data.id
    cookie = guestCookie
    await req('POST', `/api/rooms/${dcRoomId}/join`, {}) // B(成员)加入

    // 成员 B:socket 加入频道后突然断开 → 宽限期后自动移出房间
    const sockB = io(`http://127.0.0.1:${PORT}`, { extraHeaders: { cookie: guestCookie }, transports: ['websocket'] })
    await new Promise((res) => sockB.on('connect', res))
    sockB.emit('join', { roomId: dcRoomId })
    await new Promise((res) => setTimeout(res, 200))
    sockB.close()
    await new Promise((res) => setTimeout(res, 1800))
    r = await req('GET', `/api/rooms/${dcRoomId}`, null)
    check(
      'disconnect auto-leave: member removed after grace',
      r.status === 200 && !r.data.slots.some((s) => s.player.steamId === '76561190000000002'),
      JSON.stringify(r.data?.slots),
    )

    // 房主 A:断开后宽限期内重连回房 → 取消退房;再次断开且不回来 → 房间解散
    const sockA = io(`http://127.0.0.1:${PORT}`, { extraHeaders: { cookie: hostCookie }, transports: ['websocket'] })
    await new Promise((res) => sockA.on('connect', res))
    sockA.emit('join', { roomId: dcRoomId })
    await new Promise((res) => setTimeout(res, 200))
    sockA.close()
    await new Promise((res) => setTimeout(res, 300)) // 宽限 800ms 内重连
    const sockA2 = io(`http://127.0.0.1:${PORT}`, { extraHeaders: { cookie: hostCookie }, transports: ['websocket'] })
    await new Promise((res) => sockA2.on('connect', res))
    sockA2.emit('join', { roomId: dcRoomId })
    await new Promise((res) => setTimeout(res, 1400)) // 越过原宽限点
    r = await req('GET', `/api/rooms/${dcRoomId}`, null)
    check('reconnect within grace keeps host in room', r.status === 200 && r.data.hostId === '76561190000000001', JSON.stringify(r.data?.slots))
    sockA2.close()
    await new Promise((res) => setTimeout(res, 1800)) // 不再回来 → 房主断线解散
    r = await req('GET', `/api/rooms/${dcRoomId}`, null)
    check('host disconnect after grace dissolves room (404)', r.status === 404)

    // ============ 杂项设置:断线宽限开关/时长(全局,仅管理员可改) ============
    cookie = guestCookie
    r = await req('GET', '/api/settings/disconnect', null)
    check('disconnect grace default (enabled 1~999s)', r.status === 200 && r.data.enabled === true && r.data.seconds >= 1 && r.data.seconds <= 999, JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/disconnect', { enabled: false })
    check('disconnect grace non-admin rejected (403)', r.status === 403)
    cookie = adminCookie
    r = await req('PUT', '/api/settings/disconnect', { seconds: 1000 })
    check('disconnect grace seconds>999 rejected (400)', r.status === 400 && /0~999/.test(r.data.error), JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/disconnect', { enabled: false, seconds: 0 })
    check('disconnect grace disabled persists', r.status === 200 && r.data.enabled === false && r.data.seconds === 0)

    // 关闭宽限:成员断开立即退房(远小于正常宽限的等待也足够)
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '立即退房', matchType: 'custom' })
    const noGraceRoomId = r.data.id
    cookie = guestCookie
    await req('POST', `/api/rooms/${noGraceRoomId}/join`, {})
    const sockC = io(`http://127.0.0.1:${PORT}`, { extraHeaders: { cookie: guestCookie }, transports: ['websocket'] })
    await new Promise((res) => sockC.on('connect', res))
    sockC.emit('join', { roomId: noGraceRoomId })
    await new Promise((res) => setTimeout(res, 200))
    sockC.close()
    await new Promise((res) => setTimeout(res, 600))
    r = await req('GET', `/api/rooms/${noGraceRoomId}`, null)
    check('grace off: member removed immediately on disconnect', r.status === 200 && !r.data.slots.some((s) => s.player.steamId === '76561190000000002'), JSON.stringify(r.data?.slots))

    // 开启宽限且 0 秒:永不超时(断开后仍在房间)
    cookie = adminCookie
    r = await req('PUT', '/api/settings/disconnect', { enabled: true, seconds: 0 })
    check('disconnect grace never-timeout persists', r.status === 200 && r.data.enabled === true && r.data.seconds === 0)
    cookie = hostCookie
    const sockD = io(`http://127.0.0.1:${PORT}`, { extraHeaders: { cookie: hostCookie }, transports: ['websocket'] })
    await new Promise((res) => sockD.on('connect', res))
    sockD.emit('join', { roomId: noGraceRoomId })
    await new Promise((res) => setTimeout(res, 200))
    sockD.close()
    await new Promise((res) => setTimeout(res, 1500))
    r = await req('GET', `/api/rooms/${noGraceRoomId}`, null)
    check('never-timeout: host stays after disconnect', r.status === 200 && r.data.slots.some((s) => s.player.steamId === '76561190000000001'), JSON.stringify(r.data?.slots))

    // 恢复默认(开启 1 秒)供后续用例
    cookie = adminCookie
    r = await req('PUT', '/api/settings/disconnect', { enabled: true, seconds: 1 })
    check('disconnect grace re-enabled (1s)', r.status === 200 && r.data.enabled === true && r.data.seconds === 1)
    await req('DELETE', `/api/rooms/${noGraceRoomId}`, {})
    cookie = guestCookie

    // ============ 首页内容:左卡 + 更新日志(settings KV;读任意登录,写仅管理员) ============
    r = await req('GET', '/api/settings/home-content', null)
    check('home content seeded from CHANGELOG file (guest readable)', r.status === 200 && r.data.leftCard === '' && r.data.source === 'file' && r.data.changelog.length > 100 && !/^#\s/.test(r.data.changelog.trimStart()), JSON.stringify({ source: r.data?.source, len: r.data?.changelog?.length }))
    r = await req('PUT', '/api/settings/home-content', { leftCard: 'x' })
    check('home content non-admin rejected (403)', r.status === 403)
    cookie = adminCookie
    r = await req('PUT', '/api/settings/home-content', { leftCard: 123 })
    check('home content non-string rejected (400)', r.status === 400 && /字符串/.test(r.data.error), JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/home-content', { changelog: 'x'.repeat(102401) })
    check('home content overlong rejected (400)', r.status === 400 && /过长/.test(r.data.error), JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/home-content', { leftCard: '## 置顶公告\n\n- 欢迎来到 CS Arena', changelog: '# 新日志\n\n- 条目一' })
    check('home content saved by admin (source -> db)', r.status === 200 && r.data.source === 'db' && r.data.leftCard.includes('置顶公告') && r.data.changelog === '# 新日志\n\n- 条目一', JSON.stringify(r.data))
    cookie = guestCookie
    r = await req('GET', '/api/settings/home-content', null)
    check('home content persists for guest (db overrides file)', r.status === 200 && r.data.source === 'db' && r.data.leftCard.includes('置顶公告') && r.data.changelog === '# 新日志\n\n- 条目一')
    cookie = adminCookie
    r = await req('PUT', '/api/settings/home-content', { leftCard: '仅改左卡' })
    check('home content partial patch keeps other field', r.status === 200 && r.data.leftCard === '仅改左卡' && r.data.changelog === '# 新日志\n\n- 条目一', JSON.stringify(r.data))
    // 清理:删除设置行 → 回到文件播种态(不影响后续断言与复用 DB 的重复运行)
    const { DatabaseSync: SdbHC } = await import('node:sqlite')
    const sdbHC = new SdbHC(path.join(STUB_DIR, 'arena.db'))
    sdbHC.prepare("DELETE FROM settings WHERE key = 'home_content'").run()
    sdbHC.close()
    cookie = guestCookie
    r = await req('GET', '/api/settings/home-content', null)
    check('home content back to file seed after reset', r.status === 200 && r.data.source === 'file' && r.data.changelog.length > 100)

    // ============ 增强人机(botMode) ============
    // 目录接口
    cookie = hostCookie
    r = await req('GET', '/api/bots/catalog', null)
    check('bots catalog ok', r.status === 200 && Array.isArray(r.data.names) && r.data.proTeams.some((t) => t.id === 'falcons' && t.roster.length === 5), JSON.stringify(r.data?.proTeams?.map((t) => t.id)))
    // stub 实例默认 STOPPED:管理员唤醒 match3(增强人机专用实例)供开赛
    cookie = adminCookie
    r = await req('POST', '/api/instances/match3/start', {})
    check('match3 started for bots match', r.status === 200, JSON.stringify(r.data))
    cookie = hostCookie

    // 建房:botMode 固定 BO1 + 关刀局
    r = await req('POST', '/api/rooms', { name: '人机房', matchType: 'custom', botMode: true })
    const botRoomId = r.data.id
    check('bots room created (botMode/knife off/BO1)', r.data.botMode === true && r.data.knifeRound === false && r.data.bestOf === 1, JSON.stringify({ m: r.data?.botMode, k: r.data?.knifeRound }))
    await req('POST', `/api/rooms/${botRoomId}/config`, { teamA: 3, teamB: 5, pickMode: 'direct' })
    r = await req('POST', `/api/rooms/${botRoomId}/config`, { bestOf: 3 })
    check('bots room bestOf 3 rejected (400)', r.status === 400 && /BO1/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${botRoomId}/config`, { knifeRound: true })
    check('bots room knifeRound rejected (400)', r.status === 400 && /刀战/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${botRoomId}/config`, { specSeats: 6 }) // 3+5+6=14 > 11
    check('bots room capacity guard rejected (400)', r.status === 400 && /容量/.test(r.data.error), JSON.stringify(r.data))

    // 常规房间不可管理人机(单房间守卫后:同一 host 的人机房还开着 → 对照房走管理员)
    cookie = adminCookie
    r = await req('POST', '/api/rooms', { name: '常规对照房', matchType: 'custom' })
    const botNormalRoomId = r.data.id
    // 管理员是超管:能过 guardHost,于是这条断言真正测到「非人机房管理人机 → 400」
    r = await req('POST', `/api/rooms/${botNormalRoomId}/bots`, { mode: 'single', name: 'NiKo', team: 't' })
    check('bots mgmt rejected in normal room (400)', r.status === 400 && /增强人机/.test(r.data.error), JSON.stringify(r.data))
    await req('DELETE', `/api/rooms/${botNormalRoomId}`, {})
    cookie = hostCookie // 还原:下面继续操作人机房

    // botconfig:瞄准/道具模式
    r = await req('POST', `/api/rooms/${botRoomId}/botconfig`, { botAim: 'head', botNades: 'max' })
    check('botconfig aim/nades ok', r.status === 200 && r.data.botAim === 'head' && r.data.botNades === 'max', JSON.stringify({ a: r.data?.botAim, n: r.data?.botNades }))
    r = await req('POST', `/api/rooms/${botRoomId}/botconfig`, { botAim: 'feet' })
    check('botconfig invalid aim rejected (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${botRoomId}/botconfig`, { botNades: 'all' })
    check('botconfig invalid nades rejected (400)', r.status === 400)
    await req('POST', `/api/rooms/${botRoomId}/botconfig`, { botAim: 'mixed', botNades: 'normal' })

    // 职业队整队添加(仅 TeamB,需 ≥5 空位)
    r = await req('POST', `/api/rooms/${botRoomId}/bots`, { mode: 'proteam', teamId: 'falcons' })
    check(
      'proteam added (Falcons 5 bots + name/logo)',
      r.status === 200 && r.data.teamBName === 'Falcons' && r.data.botProteam === 'falcons' && r.data.slots.filter((s) => s.team === 't' && s.isBot).length === 5,
      JSON.stringify(r.data?.slots?.map((s) => `${s.team}:${s.slot}:${s.player?.name}${s.isBot ? '*' : ''}`)),
    )
    check('proteam bots occupy t slots 0..4', JSON.stringify(r.data.slots.filter((s) => s.isBot).map((s) => s.slot).sort((a, b) => a - b)) === JSON.stringify([0, 1, 2, 3, 4]))
    r = await req('POST', `/api/rooms/${botRoomId}/bots`, { mode: 'proteam', teamId: 'spirit' })
    check('proteam re-add rejected (409, <5 free)', r.status === 409, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${botRoomId}/bots`, { mode: 'proteam', teamId: 'nonexist' })
    check('unknown proteam rejected (400)', r.status === 400)

    // 单个人机:名字消毒 + TeamA 侧可加
    r = await req('POST', `/api/rooms/${botRoomId}/bots`, { mode: 'single', name: 'NiKo";bot_kick', team: 'ct' })
    check('bot name injection rejected (400)', r.status === 400 && /人机名/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${botRoomId}/bots`, { mode: 'single', name: 'donk', team: 'ct' })
    check('single bot to TeamA ok (ct)', r.status === 200 && r.data.slots.find((s) => s.player.name === 'donk')?.team === 'ct', JSON.stringify(r.data?.slots?.map((s) => `${s.team}:${s.slot}:${s.player?.name}`)))
    r = await req('POST', `/api/rooms/${botRoomId}/bots`, { mode: 'random', team: 'ct', count: 2 })
    check('random bots over free slots rejected (409)', r.status === 409, JSON.stringify(r.data))

    // 真人加入:进 ct / spec,绝不进 t
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${botRoomId}/join`, {}) // B → ct(满员前)
    check('human join bots room goes ct', r.status === 200 && r.data.slots.find((s) => s.player.steamId === '76561190000000002')?.team === 'ct', JSON.stringify(r.data?.slots?.map((s) => `${s.team}:${s.slot}:${s.player?.name}`)))
    cookie = cCookie
    r = await req('POST', `/api/rooms/${botRoomId}/join`, {}) // C → ct 已满 → spec
    check('human join full TeamA goes spec (never t)', r.status === 200 && r.data.slots.find((s) => s.player.steamId === '76561190000000003')?.team === 'spec', JSON.stringify(r.data?.slots?.map((s) => `${s.team}:${s.slot}:${s.player?.name}`)))

    // 阵营守卫:真人不可进 TeamB;setteam/move/swap/shuffle 全拒绝
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${botRoomId}/setteam`, { team: 't' })
    check('human setteam t rejected (400)', r.status === 400 && /仅限人机/.test(r.data.error), JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${botRoomId}/move`, { playerId: '76561190000000002', team: 't' })
    check('host move human to t rejected (400)', r.status === 400 && /仅限人机/.test(r.data.error), JSON.stringify(r.data))
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${botRoomId}/swap/request`, { targetPlayerId: 'bot-1' })
    check('swap with bot rejected (400)', r.status === 400 && /人机/.test(r.data.error), JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${botRoomId}/shuffle`, { includeCaptains: true })
    check('shuffle rejected in bots room (400)', r.status === 400, JSON.stringify(r.data))

    // 服务器选择:仅 match3
    r = await req('POST', `/api/rooms/${botRoomId}/server`, { mode: 'manual', group: 'g1', instance: 'match2' })
    check('bots manual match2 rejected (400)', r.status === 400 && /match3/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${botRoomId}/server`, { mode: 'manual', group: 'g1', instance: 'match3' })
    check('bots manual match3 ok', r.status === 200, JSON.stringify(r.data))

    // 踢掉一个人机(TeamB 缺员)→ 开赛自动补满随机人机
    r = await req('POST', `/api/rooms/${botRoomId}/kick`, { playerId: 'bot-1' })
    check('kick bot ok', r.status === 200 && r.data.slots.filter((s) => s.team === 't' && s.isBot).length === 4, JSON.stringify(r.data?.slots?.filter((s) => s.team === 't').map((s) => s.player?.name)))
    await req('POST', `/api/rooms/${botRoomId}/directpick`, { mapId: 'de_mirage' })
    r = await req('POST', `/api/rooms/${botRoomId}/start`, {})
    check(
      'bots match starts on match3 + TeamB auto-filled',
      r.status === 200 && r.data.instance === 'match3' && r.data.room.slots.filter((s) => s.team === 't' && s.isBot).length === 5,
      JSON.stringify({ status: r.status, err: r.data?.error, inst: r.data?.instance, t: r.data?.room?.slots?.filter((s) => s.team === 't').map((s) => s.player?.name) }),
    )

    // 比赛 JSON:名单仅真人、阈值按真人数、无刀局
    const { DatabaseSync: SdbBots } = await import('node:sqlite')
    const sdbBots = new SdbBots(path.join(STUB_DIR, 'arena.db'))
    const bpBots = JSON.parse(sdbBots.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(botRoomId).payload)
    check('bots JSON team1 humans only', JSON.stringify(Object.keys(bpBots.team1.players).sort()) === JSON.stringify(['76561190000000001', '76561190000000002']), JSON.stringify(bpBots.team1))
    check('bots JSON team2 empty (bots via console)', Object.keys(bpBots.team2.players).length === 0, JSON.stringify(bpBots.team2))
    check('bots JSON ready thresholds = humans (2)', bpBots.min_players_to_ready === 2 && bpBots.players_per_team === 2, JSON.stringify({ m: bpBots.min_players_to_ready, p: bpBots.players_per_team }))
    check('bots JSON no knife side', JSON.stringify(bpBots.map_sides) === JSON.stringify(['team1_ct']), JSON.stringify(bpBots.map_sides))

    // 就位 cfg 固化:开赛时经桥写入实例 cfg/arena_bots.cfg(挂 match3 的 MatchZy
    // warmup.cfg / live_override.cfg 末尾 exec),全程不经控制台通道
    const botCfg = readFileSync(path.join(STUB_DIR, 'cfg', 'arena_bots.cfg'), 'utf8')
    check(
      'bots cfg: quota0/balance off + nav smoke mode + named adds (t/ct)',
      /bot_quota 0/.test(botCfg) && /mp_autoteambalance false/.test(botCfg) && /mp_limitteams 0/.test(botCfg) && /bv_smoke_mode 1/.test(botCfg) && /bot_add_t "TeSeS"/.test(botCfg) && /bot_add_ct "donk"/.test(botCfg),
      botCfg,
    )
    check(
      'bots cfg: aim/nades/logo',
      /bot_aim mixed/.test(botCfg) && /bot_nades normal/.test(botCfg) && /mp_teamlogo_2 fal/.test(botCfg),
      botCfg,
    )

    await req('DELETE', `/api/rooms/${botRoomId}`, {})
    cookie = adminCookie
    await req('POST', '/api/instances/match3/reset', {})
    cookie = guestCookie

    // ============ 非名单用户中途加入观战(全局开关,默认不允许;仅观战不可入队) ============
    // 机制:MatchZy 会踢掉不在比赛 JSON 名单里的连接者;允许观战 = 把 steamid 追加进实例 spectators 名单
    // (matchzy_addplayer <steamid> spec "<name>"),之后该玩家按名单被固定在观战席(jointeam 被拦截)
    const specMod = await import('../lib/spectators.js')
    check(
      'unit: 观战名 ASCII 化(去引号/非 ASCII),空则占位 Spec-<后4位>',
      specMod.sanitizeSpectatorName('Ni "ko"; rm -rf /', '76561198000000009') === 'Ni ko rm -rf' &&
        specMod.sanitizeSpectatorName('黑白剑舞', '76561198000000009') === 'Spec-0009' &&
        specMod.sanitizeSpectatorName('', '76561198000000009') === 'Spec-0009',
      JSON.stringify([specMod.sanitizeSpectatorName('Ni "ko"; rm -rf /', '1'), specMod.sanitizeSpectatorName('黑白剑舞', '76561198000000009')]),
    )
    check(
      'unit: 名单判定覆盖 team1/team2/spectators',
      specMod.matchRosterHasSteamId({ team1: { players: { 1: 'a' } }, team2: { players: {} }, spectators: { players: { 2: 'b' } } }, '2') === true &&
        specMod.matchRosterHasSteamId({ team1: { players: { 1: 'a' } } }, '3') === false,
    )

    cookie = ''
    r = await req('GET', '/api/settings/spectator-join', null)
    check('spectator-join 未登录 401', r.status === 401, JSON.stringify(r.data))
    cookie = guestCookie
    r = await req('GET', '/api/settings/spectator-join', null)
    check('spectator-join 默认开启(true;日常入口是房间级开关)', r.status === 200 && r.data.allow === true, JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/spectator-join', { allow: true })
    check('spectator-join 非管理员写 403', r.status === 403, JSON.stringify(r.data))
    cookie = adminCookie
    r = await req('PUT', '/api/settings/spectator-join', { allow: 'yes' })
    check('spectator-join 非布尔值 400', r.status === 400, JSON.stringify(r.data))
    r = await req('PUT', '/api/settings/spectator-join', { allow: true })
    check('spectator-join 管理员开启', r.status === 200 && r.data.allow === true, JSON.stringify(r.data))

    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '观战房', matchType: 'custom' })
    const specRoomId = r.data.id
    check('房间默认开启「允许中途加入观战」', r.status === 201 && r.data.spectatorJoin === true, JSON.stringify(r.data?.spectatorJoin))
    await req('POST', `/api/rooms/${specRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    await req('POST', `/api/rooms/${specRoomId}/directpick`, { mapId: 'de_anubis' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${specRoomId}/join`, {}) // B → t
    cookie = ''
    await req('POST', '/api/auth/login', { steamId: '76561190000000004', name: 'Viewer D', avatarUrl: '' })
    const viewerDCookie = cookie
    cookie = ''
    await req('POST', '/api/auth/login', { steamId: '76561190000000005', name: '观众E', avatarUrl: '' })
    const viewerECookie = cookie
    r = await req('POST', `/api/rooms/${specRoomId}/spectate`, {})
    check('未开赛申请观战 409', r.status === 409, JSON.stringify(r.data))

    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${specRoomId}/start`, {})
    check('观战房开赛成功', r.status === 200, JSON.stringify(r.data))
    const specInstance = r.data.instance

    // 换位守卫(2026-09-22):move/setteam 此前无阶段守卫,比赛开始后仍可调用(与 swap/移交队长/随机分队不一致)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${specRoomId}/setteam`, { team: 'ct' })
    check('比赛开始后禁止换位 setteam (409)', r.status === 409 && /禁止换位/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${specRoomId}/move`, { playerId: '76561190000000001', team: 'ct' })
    check('比赛开始后禁止换位 move (409)', r.status === 409 && /禁止换位/.test(r.data.error), JSON.stringify(r.data))

    // 房间级「允许中途加入观战」开关(默认开启;房主可改):关闭后申请 403,重开后恢复
    r = await req('POST', `/api/rooms/${specRoomId}/config`, { spectatorJoin: false })
    check('房间开关可关闭(spectatorJoin=false)', r.status === 200 && r.data.spectatorJoin === false, JSON.stringify(r.data?.spectatorJoin))
    cookie = viewerDCookie
    r = await req('POST', `/api/rooms/${specRoomId}/spectate`, {})
    check('房间开关关闭时申请 403', r.status === 403 && /本房间未开启/.test(r.data.error), JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${specRoomId}/config`, { spectatorJoin: true })
    check('房间开关重新开启', r.status === 200 && r.data.spectatorJoin === true)

    // 单房间守卫(2026-09-22):进行中的房间不静默抛弃 —— 未结束时不能再建房/加入其它房间
    cookie = adminCookie
    r = await req('POST', '/api/rooms', { name: '守卫房D', matchType: 'custom' })
    const guardRoomD = r.data.id
    check('管理员建房不受单房间守卫限制', r.status === 201, JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '守卫房E', matchType: 'custom' })
    check('进行中的房间未结束 → 建房 409', r.status === 409 && /正在进行中的房间/.test(r.data.error), JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${guardRoomD}/join`, {})
    check('进行中的房间未结束 → 加入其它房间 409', r.status === 409 && /正在进行中的房间/.test(r.data.error), JSON.stringify(r.data))
    cookie = adminCookie
    await req('DELETE', `/api/rooms/${guardRoomD}`, {})
    cookie = hostCookie // 还原:下面「名单内玩家申请」按房主身份断言 alreadyInMatch

    r = await req('POST', `/api/rooms/${specRoomId}/spectate`, {})
    check('名单内玩家申请 → alreadyInMatch(不追加)', r.status === 200 && r.data.alreadyInMatch === true, JSON.stringify(r.data))

    cookie = viewerDCookie
    r = await req('POST', `/api/rooms/${specRoomId}/spectate`, {})
    check(
      '非名单用户追加观战成功(返回连接信息与剩余席位)',
      r.status === 200 && r.data.added === true && r.data.name === 'Viewer D' && typeof r.data.server?.port === 'number' && r.data.seatsLeft === 7,
      JSON.stringify(r.data),
    )
    const specLog = readFileSync(path.join(STUB_DIR, `${specInstance}.log`), 'utf8')
    check(
      '追加命令下发到实例(纯 ASCII:matchzy_addplayer <sid> spec "<name>")',
      specLog.includes('SEND: matchzy_addplayer 76561190000000004 spec "Viewer D"'),
      specLog.split('\n').filter((l) => l.includes('addplayer')).join(' | '),
    )
    r = await req('POST', `/api/rooms/${specRoomId}/spectate`, {})
    const specLog2 = readFileSync(path.join(STUB_DIR, `${specInstance}.log`), 'utf8')
    check(
      '重复申请幂等(不重复下发)',
      r.status === 200 && r.data.added === false && (specLog2.match(/matchzy_addplayer/g) || []).length === 1,
      JSON.stringify({ status: r.status, added: r.data?.added, n: (specLog2.match(/matchzy_addplayer/g) || []).length }),
    )

    // status:比赛页据此判断"我已获准观战"(刷新/换设备后仍成立)+ 开关快照
    r = await req('GET', `/api/rooms/${specRoomId}/status`, null)
    check(
      'status 带 extraSpectators 与观战开关快照',
      r.status === 200 &&
        (r.data.match?.extraSpectators ?? []).includes('76561190000000004') &&
        r.data.spectate?.roomAllowed === true &&
        r.data.spectate?.platformAllowed === true,
      JSON.stringify({ extra: r.data.match?.extraSpectators, sp: r.data.spectate }),
    )

    // 席位上限:房间 maxPlayers 调到刚好(1+1+1 席 + SourceTV)→ 无空余席位可追加
    const { DatabaseSync: SdbSpec } = await import('node:sqlite')
    const sdbSpec = new SdbSpec(path.join(STUB_DIR, 'arena.db'))
    sdbSpec.prepare('UPDATE rooms SET max_players = 4 WHERE id = ?').run(specRoomId)
    cookie = viewerECookie
    r = await req('POST', `/api/rooms/${specRoomId}/spectate`, {})
    check('无空余席位时拒绝 409', r.status === 409 && /席位/.test(r.data.error), JSON.stringify(r.data))

    cookie = adminCookie
    r = await req('PUT', '/api/settings/spectator-join', { allow: false })
    check('spectator-join 管理员关闭', r.status === 200 && r.data.allow === false, JSON.stringify(r.data))
    cookie = viewerECookie
    r = await req('POST', `/api/rooms/${specRoomId}/spectate`, {})
    check('平台总开关关闭后申请 403(房间开关仍开)', r.status === 403 && /平台已关闭/.test(r.data.error), JSON.stringify(r.data))

    cookie = hostCookie
    await req('DELETE', `/api/rooms/${specRoomId}`, {})
    cookie = adminCookie
    await req('POST', '/api/instances/main/reset', {})

    // ============ 单房间守卫:同一用户同一时间只能持有一个/进入一个房间(2026-09-22) ============
    cookie = guestCookie
    r = await req('POST', '/api/rooms', { name: '守卫房A', matchType: 'custom' })
    const gA = r.data.id
    check('建房 A 成功(无既有房间)', r.status === 201, JSON.stringify(r.data))
    r = await req('POST', '/api/rooms', { name: '守卫房B', matchType: 'custom' })
    check('同一用户已有活跃房间 → 建房 409', r.status === 409 && /已有房间/.test(r.data.error), JSON.stringify(r.data))
    // C 先作为成员加入 A,再自己建房 → 自动离开 A
    cookie = cCookie
    r = await req('POST', `/api/rooms/${gA}/join`, {})
    check('C 加入 A 成功', r.status === 200, JSON.stringify(r.data))
    r = await req('POST', '/api/rooms', { name: '守卫房C', matchType: 'custom' })
    const gC = r.data.id
    check('C 建房成功(= 进入新房间,自动离开 A)', r.status === 201, JSON.stringify(r.data))
    r = await req('GET', `/api/rooms/${gA}`, null)
    check('C 已从 A 自动离开', r.status === 200 && !r.data.slots.some((s) => s.player.steamId === '76561190000000003'), JSON.stringify(r.data.slots))
    // C 再加入 A → C 自己建的房(房主离开=解散)被自动解散
    cookie = cCookie
    r = await req('POST', `/api/rooms/${gA}/join`, {})
    check('C 再次加入 A 成功', r.status === 200, JSON.stringify(r.data))
    r = await req('GET', `/api/rooms/${gC}`, null)
    check('C 的原房间因房主自动离开而解散(404)', r.status === 404, JSON.stringify(r.data))
    cookie = guestCookie
    await req('DELETE', `/api/rooms/${gA}`, {})
    cookie = guestCookie

    // ============ 对局内显示名(比赛用 id;与房间绑定,自己/管理员可改) ============
    // 机制:房间级 display_names → 开赛时写进比赛 JSON 玩家名 → MatchZy 强制名文件 → 引擎按此显示
    cookie = adminCookie
    await req('POST', '/api/instances/reset', {})
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '显示名房', matchType: 'custom' })
    const dnRoomId = r.data.id
    check('显示名默认空({})', r.status === 201 && Object.keys(r.data.displayNames || {}).length === 0, JSON.stringify(r.data?.displayNames))
    check('显示名开关默认关闭(allowDisplayName=false)', r.data.allowDisplayName === false, JSON.stringify(r.data?.allowDisplayName))
    await req('POST', `/api/rooms/${dnRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    await req('POST', `/api/rooms/${dnRoomId}/directpick`, { mapId: 'de_mirage' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${dnRoomId}/join`, {}) // B → t

    // 开关默认关闭:玩家自助改名 403;管理员不受限(下方管理员改他人用例)
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: '黑剑' })
    check('开关关闭时玩家改名 403', r.status === 403 && /未开放/.test(r.data.error), JSON.stringify(r.data))
    // 开关仅房主/管理员可操作:非房主开启 → 403
    r = await req('POST', `/api/rooms/${dnRoomId}/config`, { allowDisplayName: true })
    check('非房主开启显示名开关 403', r.status === 403, JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${dnRoomId}/config`, { allowDisplayName: true })
    check('房主开启显示名开关', r.status === 200 && r.data.allowDisplayName === true, JSON.stringify(r.data?.allowDisplayName))
    cookie = guestCookie

    // 自己改自己(中文名允许:强制名文件为 UTF-8)
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: '黑剑' })
    check('自己改显示名 ok', r.status === 200 && r.data.displayNames['76561190000000002'] === '黑剑', JSON.stringify(r.data?.displayNames))
    // 非管理员改他人 → 403
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'X', playerId: '76561190000000001' })
    check('非管理员改他人 403', r.status === 403, JSON.stringify(r.data))
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'Ace' })
    check('房主改自己 ok', r.status === 200 && r.data.displayNames['76561190000000001'] === 'Ace', JSON.stringify(r.data?.displayNames))
    // 管理员可改房内任意玩家
    cookie = adminCookie
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'B-Player', playerId: '76561190000000002' })
    check('管理员改他人 ok', r.status === 200 && r.data.displayNames['76561190000000002'] === 'B-Player', JSON.stringify(r.data?.displayNames))
    // 目标不在房间 → 404
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'X', playerId: '76561190000000003' })
    check('目标不在房间 404', r.status === 404, JSON.stringify(r.data))
    // 非法名:引号/反斜杠/换行/超长
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'bad"name', playerId: '76561190000000002' })
    check('显示名含引号 400', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'a\\b', playerId: '76561190000000002' })
    check('显示名含反斜杠 400', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'a\nb', playerId: '76561190000000002' })
    check('显示名含换行 400', r.status === 400, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'x'.repeat(33), playerId: '76561190000000002' })
    check('显示名超长 400', r.status === 400 && /过长/.test(r.data.error), JSON.stringify(r.data))

    // 离房成员的显示名不再暴露(prune)
    cookie = ''
    await req('POST', '/api/auth/login', { steamId: '76561190000000003', name: '玩家C', avatarUrl: '' })
    const cCookieDN = cookie
    await req('POST', `/api/rooms/${dnRoomId}/join`, {}) // C → spec(默认 1 观战席)
    cookie = adminCookie
    await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'Spec-C', playerId: '76561190000000003' })
    cookie = cCookieDN
    await req('POST', `/api/rooms/${dnRoomId}/leave`, {})
    cookie = hostCookie
    r = await req('GET', `/api/rooms/${dnRoomId}`, null)
    check('离房后显示名不再暴露', r.status === 200 && !r.data.displayNames['76561190000000003'], JSON.stringify(r.data?.displayNames))

    // 开赛:显示名写进比赛 JSON(与房间绑定,只在本房间生效)
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${dnRoomId}/start`, {})
    check('显示名房开赛 ok', r.status === 200, JSON.stringify(r.data))
    const { DatabaseSync: SdbDN } = await import('node:sqlite')
    const sdbDN = new SdbDN(path.join(STUB_DIR, 'arena.db'))
    const dnPayload = JSON.parse(sdbDN.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(dnRoomId).payload)
    check(
      '比赛 JSON 用房间内显示名(Ace / B-Player)',
      dnPayload.team1.players['76561190000000001'] === 'Ace' && dnPayload.team2.players['76561190000000002'] === 'B-Player',
      JSON.stringify(dnPayload.team1.players) + JSON.stringify(dnPayload.team2.players),
    )
    // 清空 → 回到账号昵称;进行中的比赛不受影响(JSON 已下发)
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: '' })
    check('清空显示名(回到账号昵称)', r.status === 200 && !r.data.displayNames['76561190000000002'], JSON.stringify(r.data?.displayNames))
    const dnPayload2 = JSON.parse(sdbDN.prepare('SELECT payload FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(dnRoomId).payload)
    check('清空不影响已下发的本场 JSON', dnPayload2.team2.players['76561190000000002'] === 'B-Player', JSON.stringify(dnPayload2.team2.players))

    // 关闭开关:玩家不能再改(403),管理员仍可改;已设置的名字继续生效(不清除)
    cookie = hostCookie
    r = await req('POST', `/api/rooms/${dnRoomId}/config`, { allowDisplayName: false })
    check('房主关闭显示名开关', r.status === 200 && r.data.allowDisplayName === false, JSON.stringify(r.data?.allowDisplayName))
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'Again' })
    check('关闭后玩家改名 403', r.status === 403 && /未开放/.test(r.data.error), JSON.stringify(r.data))
    cookie = adminCookie
    r = await req('POST', `/api/rooms/${dnRoomId}/display-name`, { name: 'Ace2', playerId: '76561190000000001' })
    check('关闭后管理员仍可改房内玩家', r.status === 200 && r.data.displayNames['76561190000000001'] === 'Ace2', JSON.stringify(r.data?.displayNames))

    cookie = hostCookie
    await req('DELETE', `/api/rooms/${dnRoomId}`, {})
    cookie = adminCookie
    await req('POST', '/api/instances/main/reset', {})
    cookie = guestCookie

    // ============ 房主离开(live)→ 强制结束比赛并释放实例(修复 match 停 live / 实例锁泄漏) ============
    cookie = adminCookie
    await req('POST', '/api/instances/reset', {})
    cookie = hostCookie
    r = await req('POST', '/api/rooms', { name: '离房释放房', matchType: 'custom' })
    const lvRoomId = r.data.id
    await req('POST', `/api/rooms/${lvRoomId}/config`, { bestOf: 1, pickMode: 'direct', teamA: 1, teamB: 1 })
    await req('POST', `/api/rooms/${lvRoomId}/directpick`, { mapId: 'de_dust2' })
    cookie = guestCookie
    await req('POST', `/api/rooms/${lvRoomId}/join`, {})
    cookie = hostCookie
    await waitInstanceFree('main')
    r = await req('POST', `/api/rooms/${lvRoomId}/start`, {})
    check('离房房开赛 ok', r.status === 200, JSON.stringify(r.data))
    const lvInstance = r.data.instance
    const { DatabaseSync: SdbLv } = await import('node:sqlite')
    const sdbLv = new SdbLv(path.join(STUB_DIR, 'arena.db'))
    const lvMatch = sdbLv.prepare('SELECT id, status FROM matches WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(lvRoomId)
    check('开赛后实例被本局占用(in_match)', (await req('GET', '/api/instances', null)).data.find((i) => i.name === lvInstance)?.state === 'in_match')

    // 房主离开 → 先强制结束比赛(比赛 aborted + 实例转 cooling/idle)再解散房间
    r = await req('POST', `/api/rooms/${lvRoomId}/leave`, {})
    check('房主离开返回 deleted', r.status === 200 && r.data.deleted === true, JSON.stringify(r.data))
    const lvAfter = sdbLv.prepare('SELECT status, ended_at FROM matches WHERE id = ?').get(lvMatch.id)
    check('离房后比赛置 aborted(不再停在 live)', lvAfter.status === 'aborted' && lvAfter.ended_at != null, JSON.stringify(lvAfter))
    const lvInst = (await req('GET', '/api/instances', null)).data.find((i) => i.name === lvInstance)
    check('离房后实例不再被本局占用(非 in_match)', lvInst && lvInst.state !== 'in_match', JSON.stringify(lvInst))
    const lvLog = readFileSync(path.join(STUB_DIR, `${lvInstance}.log`), 'utf8')
    check('离房释放:向实例下发 css_endmatch', lvLog.includes('SEND: css_endmatch'), lvLog.split('\n').filter((l) => l.includes('ENDMATCH') || l.includes('css_endmatch')).slice(-2).join(' | '))
    r = await req('GET', `/api/rooms/${lvRoomId}`, null)
    check('离房后房间已删除 404', r.status === 404, JSON.stringify(r.data))
    // 成员离开不影响比赛进行(仅房主语义变化)
    cookie = guestCookie
    r = await req('POST', `/api/rooms/${lvRoomId}/leave`, {})
    check('房间已删除时离开 404', r.status === 404, JSON.stringify(r.data))

    cookie = adminCookie
    await req('POST', '/api/instances/main/reset', {})
    cookie = guestCookie

    // ============ 实例「编辑」弹窗契约:改端口 / 分级(2026-09-23) ============
    cookie = guestCookie
    r = await req('PUT', '/api/instances/match2', { port: 27999 })
    check('实例编辑非管理员拒绝 (403)', r.status === 403, JSON.stringify(r.data))
    cookie = adminCookie
    r = await req('PUT', '/api/instances/match2', { port: 0 })
    check('实例端口非法拒绝 (400)', r.status === 400 && /1~65535/.test(r.data.error), JSON.stringify(r.data))
    r = await req('PUT', '/api/instances/match2', { port: 65536 })
    check('实例端口越界拒绝 (400)', r.status === 400, JSON.stringify(r.data))
    r = await req('PUT', '/api/instances/match2', { port: 27016 }) // = match1 的游戏端口
    check('实例端口与其它实例冲突 (409)', r.status === 409 && /冲突/.test(r.data.error), JSON.stringify(r.data))
    r = await req('PUT', '/api/instances/match2', { port: 27116 }) // = match1 的 GOTV
    check('实例端口与其它实例 GOTV 冲突 (409)', r.status === 409 && /冲突/.test(r.data.error), JSON.stringify(r.data))
    r = await req('PUT', '/api/instances/match2', { port: 27999, adminOnly: true })
    check('实例端口+分级可同时改 (200)', r.status === 200 && r.data.instance?.port === 27999 && r.data.instance?.adminOnly === true, JSON.stringify(r.data))
    r = await req('GET', '/api/instances', null)
    check('实例端口已落库(列表可见)', (r.data.find((i) => i.name === 'match2') ?? {}).port === 27999)
    r = await req('PUT', '/api/instances/match2', { port: 27017, adminOnly: false })
    check('实例改回原端口与分级', r.status === 200 && r.data.instance?.port === 27017 && r.data.instance?.adminOnly === false)
    r = await req('PUT', '/api/instances/match2', {})
    check('实例编辑空 body 拒绝 (400)', r.status === 400, JSON.stringify(r.data))

    // ============ 一键启停全部(跳过已在目标状态者) ============
    // 先归零:把全部停掉并等 STOPPED,再用 start-all 断言"4 台全部下发"
    const stopAll = () => req('POST', '/api/instances/stop-all', {})
    const waitHealth = async (want) => {
      for (let i = 0; i < 60; i++) {
        const list = await req('GET', '/api/instances', null)
        if ((list.data ?? []).every((x) => x.health === want)) return true
        await sleep(250)
      }
      return false
    }
    await stopAll()
    await waitHealth('STOPPED')
    r = await req('POST', '/api/instances/start-all', {})
    check(
      'start-all 全部启动(无 skipped)',
      r.status === 200 && r.data.action === 'start' && (r.data.acted ?? []).length === 4 && (r.data.skipped ?? []).length === 0 && (r.data.failed ?? []).length === 0,
      JSON.stringify(r.data),
    )
    // stub 是异步状态机:等它们都 RUNNING 后再点一次,应全部跳过
    await waitHealth('RUNNING')
    r = await req('POST', '/api/instances/start-all', {})
    check(
      'start-all 第二次全部跳过(已在运行)',
      r.status === 200 && (r.data.acted ?? []).length === 0 && (r.data.skipped ?? []).length === 4 && r.data.skipped.every((x) => x.reason === '已在运行'),
      JSON.stringify(r.data),
    )
    r = await req('POST', '/api/instances/stop-all', {})
    check('stop-all 全部停止', r.status === 200 && (r.data.acted ?? []).length === 4 && (r.data.skipped ?? []).length === 0, JSON.stringify(r.data))
    await waitHealth('STOPPED')
    r = await req('POST', '/api/instances/stop-all', {})
    check(
      'stop-all 第二次全部跳过(已停止)',
      r.status === 200 && (r.data.acted ?? []).length === 0 && (r.data.skipped ?? []).length === 4 && r.data.skipped.every((x) => x.reason === '已停止'),
      JSON.stringify(r.data),
    )
    cookie = guestCookie
    r = await req('POST', '/api/instances/start-all', {})
    check('批量启停非管理员拒绝 (403)', r.status === 403, JSON.stringify(r.data))
    cookie = adminCookie
    r = await req('POST', '/api/instances/main/start', {}) // 收尾:把 main 拉起来(后续用例按需)
    check('收尾:main 已启动', r.status === 200, JSON.stringify(r.data))

    // ============ ArenaMatch & 录像控制 (2026-09-24) ============
    // 1. 房间 recordDemo 开关读取、更新与默认值
    r = await req('POST', '/api/rooms', { name: 'demo-flag-default' })
    const demoRoomId = r.data.id
    check('创建房间默认 recordDemo=true', r.status === 201 && r.data.recordDemo === true, JSON.stringify(r.data))
    r = await req('POST', `/api/rooms/${demoRoomId}/config`, { overtimeEnabled: false })
    r = await req('POST', `/api/rooms/${demoRoomId}/config`, { overtimeEnabled: true })
    check('房主可重新开启加时', r.status === 200 && r.data.overtimeEnabled === true)

    r = await req('POST', `/api/rooms/${demoRoomId}/config`, { recordDemo: false })
    check('房主更新 recordDemo=false', r.status === 200 && r.data.recordDemo === false, JSON.stringify(r.data))

    r = await req('POST', `/api/rooms/${demoRoomId}/config`, { recordDemo: true })
    check('房主恢复 recordDemo=true', r.status === 200 && r.data.recordDemo === true, JSON.stringify(r.data))

    r = await req('POST', '/api/rooms', { name: 'demo-flag-off', recordDemo: false, overtimeEnabled: false })
    const demoRoomId2 = r.data.id
    check('建房显式传 recordDemo=false 生效', r.status === 201 && r.data.recordDemo === false, JSON.stringify(r.data))
    check('建房可显式关闭加时', r.status === 201 && r.data.overtimeEnabled === false)

    // 2. buildMatchJson 序列化 record_demo
    const jsonOn = buildMatchJson({
      matchId: 101,
      room: { recordDemo: true, slots: [] },
      maplist: ['de_mirage'],
      playersPerTeam: 1,
      minPlayersToReady: 1,
      publicBaseUrl: BASE,
      token: 'tok101',
    })
    check('buildMatchJson 包含 record_demo=true', jsonOn.record_demo === true)

    const jsonOff = buildMatchJson({
      matchId: 102,
      room: { recordDemo: false, overtimeEnabled: false, slots: [] },
      maplist: ['de_mirage'],
      playersPerTeam: 1,
      minPlayersToReady: 1,
      publicBaseUrl: BASE,
      token: 'tok102',
    })
    check('buildMatchJson 包含 record_demo=false', jsonOff.record_demo === false)
    check('默认加时 JSON 启用 MR3', jsonOn.cvars.mp_overtime_enable === '1' && jsonOn.cvars.mp_overtime_maxrounds === '6')
    check('关闭加时 JSON 禁用引擎加时', jsonOff.cvars.mp_overtime_enable === '0')
    const bo3ForcedOt = buildMatchJson({ matchId: 103, room: { bestOf: 3, overtimeEnabled: false, slots: [] },
      maplist: ['de_mirage', 'de_nuke', 'de_ancient'], playersPerTeam: 1, publicBaseUrl: BASE, token: 'tok103' })
    check('BO3 JSON 防止存量关闭加时值漏入引擎', bo3ForcedOt.cvars.mp_overtime_enable === '1')

    // 3. 桥端 arena_match_bind 与 arena_match_close (stub 模式)
    const bindRes = await bridgeArenaMatchBind('main', 90001, { matchid: 90001, maplist: ['de_mirage'] })
    check('bridgeArenaMatchBind 返回 sha256 且落盘', bindRes.data?.ok === true && typeof bindRes.data?.sha256 === 'string' && bindRes.data?.sha256.length === 64)
    const stubFile = path.join(process.env.ARENA_STUB_DIR || STUB_DIR, '.arena-match/match_90001.json')
    check('stub 目录下 .arena-match/match_90001.json 存在', existsSync(stubFile))

    const closeRes = await bridgeArenaMatchClose('main', 90001)
    check('bridgeArenaMatchClose 返回 closed 状态', closeRes.data?.ok === true && closeRes.data?.status === 'closed')

    // 4. 等待器 waitForArenaMatchResult 与 simulateArenaMatchResult
    const waiterPromise = waitForArenaMatchResult('main', 90002, 'test-sha-123456', 2000)
    const simOk = simulateArenaMatchResult({ instance: 'main', matchId: 90002, sha256: 'test-sha-123456', resultSeq: 1, ok: true })
    const waiterRes = await waiterPromise
    check('simulateArenaMatchResult 成功唤醒装载等待器', simOk && waiterRes.ok === true && waiterRes.sha256 === 'test-sha-123456')

    const waiterMismatch = waitForArenaMatchResult('main', 90003, 'expect-sha', 2000)
    let mismatchCaught = false
    try {
      simulateArenaMatchResult({ instance: 'main', matchId: 90003, sha256: 'wrong-sha', resultSeq: 1, ok: true })
      await waiterMismatch
    } catch (e) {
      mismatchCaught = e.message.includes('SHA-256 不匹配')
    }
    check('waitForArenaMatchResult 拒绝 sha256 不匹配的装载结果', mismatchCaught)

    const waiterFail = waitForArenaMatchResult('main', 90004, 'expect-sha-fail', 2000)
    let failCaught = false
    try {
      simulateArenaMatchResult({ instance: 'main', matchId: 90004, sha256: 'expect-sha-fail', resultSeq: 1, ok: false, code: 'cvar_failed', reason: 'bad cvar' })
      await waiterFail
    } catch (e) {
      failCaught = e.message.includes('cvar_failed')
    }
    check('waitForArenaMatchResult 拒绝 ok=false 的装载结果', failCaught)

    const cancelled = waitForArenaMatchResult('main', 90006, 'cancel-sha', 2000)
    cancelArenaMatchResultWait('main', 90006)
    let cancelCaught = false
    try {
      await cancelled
    } catch (e) {
      cancelCaught = e.message.includes('已取消')
    }
    check('装载失败时可取消结果等待器', cancelCaught)

    // 5. WebSocket arena_match_result:真实绑定才 ACK，持久化结果并幂等确认
    initDb(path.join(STUB_DIR, 'arena-ack-validation.db'))
    const resultDb = getDb()
    const ackToken = 'arena-ack-validation-token'
    resultDb.prepare('UPDATE game_servers SET bridge_token = ? WHERE id = ?').run(ackToken, 'g1')
    resultDb.prepare('UPDATE instances SET game_server_id = ? WHERE name = ?').run('g1', 'match1')
    const createResultMatch = ({ instance = 'match1', status = 'pending', sha256, seq = 0, resultJson = null }) => {
      const inserted = resultDb
        .prepare(
          `INSERT INTO matches (room_id, token, instance_name, payload, status, arena_match_sha256,
             arena_match_result_seq, arena_match_result_json, created_at)
           VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
        )
        .run('arena-result-smoke', `token-${Math.random()}`, instance, status, sha256, seq, resultJson, Date.now())
      return Number(inserted.lastInsertRowid)
    }
    resultDb.prepare(
      `INSERT INTO rooms (id, code, name, host_id, status, server, created_at)
       VALUES ('arena-recovery-smoke', 'ARS1', 'recovery smoke', '76561190000000001', 'live', '{}', ?)`,
    ).run(Date.now())
    resultDb.prepare(
      `INSERT INTO rooms (id, code, name, host_id, status, server, created_at)
       VALUES ('arena-recovery-gap-smoke', 'ARS2', 'recovery gap smoke', '76561190000000001', 'starting', '{}', ?)`,
    ).run(Date.now())
    const recoveryId = createResultMatch({ sha256: 'e'.repeat(64) })
    resultDb.prepare('UPDATE matches SET room_id = ? WHERE id = ?').run('arena-recovery-smoke', recoveryId)
    resultDb.prepare('UPDATE instances SET state = ?, match_id = ? WHERE name = ?').run('in_match', recoveryId, 'match1')
    const recoveryGapId = createResultMatch({ instance: 'match2', sha256: null })
    resultDb.prepare('UPDATE matches SET room_id = ?, arena_match_bind_started = 1 WHERE id = ?').run('arena-recovery-gap-smoke', recoveryGapId)
    resultDb.prepare('UPDATE instances SET game_server_id = ?, state = ?, match_id = ? WHERE name = ?').run('g1', 'in_match', recoveryGapId, 'match2')
    const legacyPendingId = createResultMatch({ sha256: null })
    const otherMatchId = createResultMatch({ instance: 'match3', status: 'live', sha256: 'f'.repeat(64) })
    const conflictingPendingId = createResultMatch({ instance: 'match3', sha256: null })
    resultDb.prepare('UPDATE matches SET arena_match_bind_started = 1 WHERE id = ?').run(conflictingPendingId)
    resultDb.prepare('UPDATE instances SET game_server_id = ?, state = ?, match_id = ? WHERE name = ?').run('g1', 'in_match', otherMatchId, 'match3')
    check('启动恢复只中止已开始绑定的 ArenaMatch pending', recoverPendingArenaMatchesOnStartup() === 2)
    const recoveredMatch = resultDb.prepare('SELECT status, ended_at FROM matches WHERE id = ?').get(recoveryId)
    const recoveredRoom = resultDb.prepare('SELECT status, server, picked FROM rooms WHERE id = ?').get('arena-recovery-smoke')
    const heldInstance = resultDb.prepare('SELECT state, match_id FROM instances WHERE name = ?').get('match1')
    check(
      '启动恢复复位房间并锁实例等待桥清理',
      recoveredMatch.status === 'aborted' && recoveredMatch.ended_at != null && recoveredRoom.status === 'waiting' && recoveredRoom.server == null && recoveredRoom.picked === '[]' && heldInstance.state === 'booting' && heldInstance.match_id === recoveryId,
      JSON.stringify({ recoveredMatch, recoveredRoom, heldInstance, recoveryId }),
    )
    check('启动恢复不触碰经典 MatchZy pending 比赛', resultDb.prepare('SELECT status FROM matches WHERE id = ?').get(legacyPendingId).status === 'pending')
    const missingMetaClosed = await confirmArenaMatchClose('match2', recoveryGapId, async () => ({
      status: 502, data: { ok: false, error: 'open metadata: no such file or directory' },
    }))
    check('绑定摘要未落库且桥确认元数据缺失时释放恢复锁', missingMetaClosed &&
      resultDb.prepare('SELECT state FROM instances WHERE name = ?').get('match2').state === 'idle')
    const alreadyClosedId = createResultMatch({ instance: 'match2', status: 'aborted', sha256: 'b'.repeat(64) })
    resultDb.prepare('UPDATE matches SET arena_match_close_confirmed = 1 WHERE id = ?').run(alreadyClosedId)
    resultDb.prepare('UPDATE instances SET state = ?, match_id = ? WHERE name = ?').run('booting', alreadyClosedId, 'match2')
    const conflictInstance = resultDb.prepare('SELECT state, match_id FROM instances WHERE name = ?').get('match3')
    check(
      '启动恢复不覆盖被其他比赛占用的实例锁',
      resultDb.prepare('SELECT status FROM matches WHERE id = ?').get(conflictingPendingId).status === 'pending' &&
        conflictInstance.state === 'in_match' && conflictInstance.match_id === otherMatchId,
    )
    const coolingId = createResultMatch({ instance: 'match3', status: 'ended', sha256: 'f'.repeat(64) })
    resultDb.prepare("UPDATE matches SET payload = '{\"record_demo\":false,\"num_maps\":1}' WHERE id = ?").run(coolingId)
    resultDb.prepare('UPDATE instances SET state = ?, match_id = ? WHERE name = ?').run('cooling', coolingId, 'match3')
    cacheInstances()
    tryReleaseCooling('match3')
    check('ArenaMatch 禁录比赛仍须等待桥关闭确认才解除冷却', resultDb.prepare('SELECT state FROM instances WHERE name = ?').get('match3').state === 'cooling')
    const rejectedClose = await confirmArenaMatchClose('match3', coolingId, async () => ({ status: 502, data: { ok: true, status: 'closed' } }))
    const rejectedState = resultDb.prepare('SELECT state, match_id FROM instances WHERE name = ?').get('match3')
    check('桥命令失败即使业务帧声称关闭仍占锁', !rejectedClose && rejectedState.state === 'cooling' && rejectedState.match_id === coolingId &&
      resultDb.prepare('SELECT arena_match_close_confirmed FROM matches WHERE id = ?').get(coolingId).arena_match_close_confirmed === 0)
    const terminalBeforeCoolingId = createResultMatch({ instance: 'main', status: 'ended', sha256: '1'.repeat(64) })
    resultDb.prepare("UPDATE matches SET payload = '{\"record_demo\":false,\"num_maps\":1}' WHERE id = ?").run(terminalBeforeCoolingId)
    resultDb.prepare('UPDATE instances SET state = ?, match_id = ? WHERE name = ?').run('in_match', terminalBeforeCoolingId, 'main')
    const validSha = 'a'.repeat(64)
    const validResultId = createResultMatch({ sha256: validSha })
    const abortedId = createResultMatch({ status: 'aborted', sha256: 'b'.repeat(64) })
    const staleId = createResultMatch({
      sha256: 'c'.repeat(64),
      seq: 2,
      resultJson: JSON.stringify({
        instance: 'match1', matchId: 9000001, sha256: 'c'.repeat(64), resultSeq: 2, ok: true, code: '', reason: '',
      }),
    })
    // 更新 stale 结果快照中的真实 id，保证这是完整的旧序号帧
    resultDb.prepare('UPDATE matches SET arena_match_result_json = ? WHERE id = ?').run(
      JSON.stringify({ instance: 'match1', matchId: staleId, sha256: 'c'.repeat(64), resultSeq: 2, ok: true, code: '', reason: '' }),
      staleId,
    )
    const matchOwner = resultDb.prepare('SELECT game_server_id FROM instances WHERE name = ?').get('match1')?.game_server_id
    const validWaiterOutcome = waitForArenaMatchResult('match1', validResultId, validSha, 15000).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const cases = [
      { name: '未知比赛不 ACK', frame: { instance: 'match1', matchId: 9000000, sha256: validSha, resultSeq: 1, ok: true } },
      {
        name: '桥不拥有的实例不 ACK',
        frame: { instance: 'match1', matchId: validResultId, sha256: validSha, resultSeq: 1, ok: true },
        before: () => resultDb.prepare('UPDATE instances SET game_server_id = ? WHERE name = ?').run('not-g1', 'match1'),
        after: () => resultDb.prepare('UPDATE instances SET game_server_id = ? WHERE name = ?').run(matchOwner, 'match1'),
      },
      { name: '错误绑定摘要不 ACK', frame: { instance: 'match1', matchId: validResultId, sha256: 'd'.repeat(64), resultSeq: 1, ok: true } },
      { name: '错误实例绑定不 ACK', frame: { instance: 'main', matchId: validResultId, sha256: validSha, resultSeq: 1, ok: true } },
      { name: '已中止比赛不 ACK', frame: { instance: 'match1', matchId: abortedId, sha256: 'b'.repeat(64), resultSeq: 1, ok: true } },
      { name: '过期结果序号不 ACK', frame: { instance: 'match1', matchId: staleId, sha256: 'c'.repeat(64), resultSeq: 1, ok: true } },
      { name: '非法序号不 ACK', frame: { instance: 'match1', matchId: validResultId, sha256: validSha, resultSeq: 0, ok: true } },
      { name: '有效结果按绑定与 SHA ACK', frame: { instance: 'match1', matchId: validResultId, sha256: validSha, resultSeq: 1, ok: true }, ack: true, setLive: true },
      { name: '相同结果重放幂等 ACK', frame: { instance: 'match1', matchId: validResultId, sha256: validSha, resultSeq: 1, ok: true }, ack: true },
      { name: '同序号不同内容不 ACK', frame: { instance: 'match1', matchId: validResultId, sha256: validSha, resultSeq: 1, ok: true, reason: 'tampered' } },
    ]
    const ackServer = createServer()
    initAgentChannel(ackServer)
    await new Promise((resolve, reject) => {
      ackServer.once('error', reject)
      ackServer.listen(0, '127.0.0.1', resolve)
    })
    try {
      await new Promise((resolve, reject) => {
      const ackPort = ackServer.address().port
      const ws = new WebSocket(`ws://127.0.0.1:${ackPort}/api/agent`)
      let index = 0
      let current = null
      let frameTimer = null
      let settled = false
      let started = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(frameTimer)
        if (err) {
          ws.terminate()
          reject(err)
          return
        }
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        ws.once('close', resolve)
        ws.close()
      }
      const timeout = setTimeout(() => finish(new Error('WS arena_match_result validation timeout')), 8000)
      const advance = () => {
        if (index >= cases.length) {
          clearTimeout(timeout)
          finish()
          return
        }
        const test = cases[index++]
        current = test
        test.before?.()
        ws.send(JSON.stringify({ type: 'arena_match_result', ...test.frame }))
        frameTimer = setTimeout(() => {
          if (current !== test) return
          check(`WS ${test.name}`, !test.ack)
          test.after?.()
          current = null
          advance()
        }, test.ack ? 1000 : 200)
      }
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          token: ackToken,
          serverId: 'g1',
          capabilities: ['arena_match_ipc', 'config_sync'],
          instances: ['main', 'match1', 'match2', 'match3'],
        }))
      })
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'cmd') {
          const missingBinding = msg.op === 'arena_match_close' && msg.payload?.matchId === recoveryGapId
          ws.send(JSON.stringify({
            type: 'result',
            cmdId: msg.cmdId,
            ok: !missingBinding,
            data: missingBinding
              ? { ok: false, error: 'open metadata: no such file or directory' }
              : { ok: true, status: 'closed' },
          }))
          return
        }
        if (msg.type === 'hello_ack' && !started) {
          started = true
          advance()
        }
        if (msg.type !== 'arena_match_ack') return
        if (!current?.ack) {
          check('WS 非法帧未产生意外 ACK', false, JSON.stringify(msg))
          clearTimeout(timeout)
          finish(new Error('unexpected arena_match_ack'))
          return
        }
        const test = current
        clearTimeout(frameTimer)
        check(`WS ${test.name}`, msg.instance === test.frame.instance && msg.matchId === test.frame.matchId && msg.resultSeq === test.frame.resultSeq && msg.sha256 === test.frame.sha256)
        if (test.setLive) resultDb.prepare("UPDATE matches SET status = 'live' WHERE id = ?").run(validResultId)
        test.after?.()
        current = null
        advance()
      })
      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
      })
    } finally {
      await new Promise((resolve) => ackServer.close(resolve))
    }
    // ACK 回执后等待器才会完成；再核对 SQLite 持久化结果。
    const waiterOutcome = await validWaiterOutcome
    if (waiterOutcome.error) throw waiterOutcome.error
    const acceptedResult = waiterOutcome.value
    const savedResult = resultDb.prepare('SELECT arena_match_result_seq, arena_match_result_json FROM matches WHERE id = ?').get(validResultId)
    check('WS 有效结果先持久化再完成等待器', acceptedResult.sha256 === validSha && savedResult.arena_match_result_seq === 1 && JSON.parse(savedResult.arena_match_result_json).ok === true)
    const recoveryDeadline = Date.now() + 3000
    let recoveredInstances = resultDb.prepare('SELECT name, state, match_id FROM instances WHERE name IN (?, ?, ?, ?) ORDER BY name').all('main', 'match1', 'match2', 'match3')
    while (recoveredInstances.some((instance) => instance.state !== 'idle') && Date.now() < recoveryDeadline) {
      await sleep(25)
      recoveredInstances = resultDb.prepare('SELECT name, state, match_id FROM instances WHERE name IN (?, ?, ?, ?) ORDER BY name').all('main', 'match1', 'match2', 'match3')
    }
    check('Go 桥重连后释放终态 in_match、未关闭及已确认关闭的恢复锁与禁录冷却', recoveredInstances.length === 4 && recoveredInstances.every((instance) => instance.state === 'idle' && instance.match_id == null))
    check('关闭确认在重试后持久化', resultDb.prepare('SELECT arena_match_close_confirmed FROM matches WHERE id = ?').get(coolingId).arena_match_close_confirmed === 1)
    resultDb.close()

    // 清理测试房间
    await req('POST', `/api/rooms/${demoRoomId}/leave`, {})
    await req('POST', `/api/rooms/${demoRoomId2}/leave`, {})

    console.log(`\n[smoke] RESULT: ${pass} passed, ${fail} failed`)
    if (fail > 0) process.exitCode = 1
  } finally {
    server.kill('SIGTERM')
    if (bridgeProc) bridgeProc.kill('SIGTERM')
    rmSync(STUB_DIR, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[smoke] error:', err)
  process.exitCode = 1
})
