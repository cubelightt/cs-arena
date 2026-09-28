// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 入口:Express + Socket.io + 路由挂载
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import { Server as SocketIOServer } from 'socket.io'
import config from './config.js'
import { initDb, getDb } from './db.js'
import { createRoomsRouter } from './routes/rooms.js'
import { getRoomJson } from './lib/rooms.js'
import { createMatchRouter } from './routes/match.js'
import { createEventsRouter } from './routes/events.js'
import { createAuthRouter } from './routes/auth.js'
import { createInstancesRouter } from './routes/instances.js'
import { createHostRouter } from './routes/host.js'
import { createJobsRouter } from './routes/jobs.js'
import { createRecordsRouter } from './routes/records.js'
import { createBotsRouter } from './routes/bots.js'
import { createDebugRouter } from './routes/debug.js'
import { createDemosRouter } from './routes/demos.js'
import { createServersRouter } from './routes/servers.js'
import { createGameServersRouter } from './routes/gameServers.js'
import { createSettingsRouter } from './routes/settings.js'
import { createAdminRouter } from './routes/admin.js'
import { userFromSocket, isAdmin } from './lib/auth.js'
import { startDemoArchiveScheduler } from './lib/demoArchive.js'
import { presenceJoin, presenceLeave, scheduleAutoLeave } from './lib/presence.js'
import { initConsoleStream, addConsoleListener, removeConsoleListener, cleanupSocket } from './lib/consoleStream.js'
import { initAgentChannel, setJobPushHandler } from './lib/agentChannel.js'
import { setInstancesNotifyHandler } from './lib/provisioning.js'
import { listMaintenance } from './lib/jobs.js'
import * as bridge from './lib/bridge.js'
import { listInstances, recoverPendingArenaMatchesOnStartup, startCoolingSweep } from './lib/instances.js'
import { listAlerts, bridgeStatuses, backendInfo, sweepAlerts } from './lib/alerts.js'
import { startVetoTimer } from './lib/vetotimer.js'
import { startDemoCleanup } from './lib/democleanup.js'
import { initWorkshopJobs } from './lib/workshop.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'arena.db')

// 桥模式启动校验:http 模式已移除,误配(如遗留 BRIDGE_MODE=http)必须当场失败,
// 否则会因模式不匹配静默退化为 stub —— 生产上等于"下发进了黑洞"
if (!['stub', 'reverse'].includes(config.bridge.mode)) {
  console.error(
    `[config] BRIDGE_MODE=${config.bridge.mode} 不受支持(仅 stub / reverse;http 模式已移除)。请修正后启动。`,
  )
  process.exit(1)
}

initDb(DB_PATH)
const recoveredArenaMatches = recoverPendingArenaMatchesOnStartup()
if (recoveredArenaMatches > 0) {
  console.warn(`[arena-match] 启动恢复:已安全中止 ${recoveredArenaMatches} 场未完成装载,等待 Go 桥确认关闭绑定`)
}

const app = express()
app.use(express.json({ limit: '5mb' }))
// CORS(dev:反射任意 origin;生产可收紧为 config.corsOrigins)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Arena-Token,Authorization')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
// 全局 HTTP 请求日志(带时间戳)
app.use((req, res, next) => {
  const t = Date.now()
  res.on('finish', () => {
    console.log(
      `[http] ${new Date(t).toLocaleTimeString()} ${req.method} ${req.originalUrl} → ${res.statusCode} ${Date.now() - t}ms`,
    )
  })
  next()
})

const server = http.createServer(app)
const io = new SocketIOServer(server, {
  cors: { origin: config.corsOrigins, credentials: true },
})

app.set('io', io)

const ctx = { io, config }

// Socket.io:客户端加入房间频道 + 管理员实例控制台实时流
io.on('connection', (socket) => {
  const user = userFromSocket(socket)
  socket.data.user = user ?? null

  socket.on('join', ({ roomId }) => {
    if (typeof roomId !== 'string') return
    socket.join(`room:${roomId}`)
    // 在线登记(用于断线宽限自动退房):已登录 socket 才计数,重连时自动取消待执行的退房
    if (!socket.data.rooms) socket.data.rooms = new Set()
    socket.data.rooms.add(roomId)
    if (socket.data.user) presenceJoin(roomId, socket.data.user.steam_id, socket.id)
    const room = getRoomJson(roomId)
    if (room) socket.emit('room:update', room)
  })
  socket.on('leave', ({ roomId }) => {
    if (typeof roomId === 'string') socket.leave(`room:${roomId}`)
  })

  // 实例控制台(仅管理员;offset 来自 REST 历史响应,缺省从头增量)
  socket.on('console:subscribe', ({ instance, offset }) => {
    if (!socket.data.user || !isAdmin(socket.data.user.steam_id)) {
      socket.emit('console:error', { instance, error: '需要管理员权限' })
      return
    }
    if (typeof instance !== 'string' || !instance) {
      socket.emit('console:error', { instance, error: '缺少 instance' })
      return
    }
    addConsoleListener(instance, socket, Number.isFinite(Number(offset)) ? Number(offset) : null)
  })
  socket.on('console:unsubscribe', ({ instance }) => {
    if (typeof instance === 'string') removeConsoleListener(instance, socket.id)
  })
  // 前端控制台全量走 socket:历史拉取 / 执行命令(管理员)
  socket.on('console:history', async ({ instance, lines }) => {
    if (!socket.data.user || !isAdmin(socket.data.user.steam_id)) {
      socket.emit('console:error', { instance, error: '需要管理员权限' })
      return
    }
    if (typeof instance !== 'string' || !instance) return
    try {
      const n = Math.max(1, Math.min(Number(lines || 200), 2000))
      const r = await bridge.bridgeLog(instance, n)
      socket.emit('console:history_result', { instance, ...r.data })
    } catch (err) {
      socket.emit('console:error', { instance, error: err.message })
    }
  })
  socket.on('console:command', async ({ instance, command }) => {
    if (!socket.data.user || !isAdmin(socket.data.user.steam_id)) {
      socket.emit('console:error', { instance, error: '需要管理员权限' })
      return
    }
    if (typeof instance !== 'string' || typeof command !== 'string') return
    try {
      const r = await bridge.bridgeConsole(instance, command.trim())
      socket.emit('console:command_result', { instance, ok: r.data?.ok !== false, data: r.data })
    } catch (err) {
      socket.emit('console:error', { instance, error: err.message })
    }
  })
  // 管理员频道:任务进度/日志(M4;仅管理员可加入)
  socket.on('admins:subscribe', () => {
    const u = socket.data.user
    if (!u || !isAdmin(u.steam_id)) {
      socket.emit('job:error', { error: '需要管理员权限' })
      return
    }
    socket.join('admins')
    socket.emit('admins:subscribed', { ok: true })
  })
  socket.on('disconnect', () => {
    cleanupSocket(socket.id)
    // 断线宽限自动退房:该账号在任一已加入房间频道上无其他在线连接时,宽限期后按显式退房语义移除
    const user = socket.data.user
    if (!user) return
    for (const roomId of socket.data.rooms ?? []) {
      presenceLeave(roomId, user.steam_id, socket.id)
      scheduleAutoLeave(io, roomId, user.steam_id)
    }
  })
})

// 健康检查(前端已 5s 轮询:维护态零成本提示,房间页据此置灰开赛按钮)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: Date.now(),
    bridgeMode: config.bridge.mode,
    instances: listInstances(),
    maintenance: listMaintenance().map((m) => ({ groupId: m.groupId, enabled: true, reason: m.reason })),
    // 平台在线告警:桥离线 + 后端自身 uptime(重启后归零即"后端刚被重启过")
    alerts: listAlerts(),
    bridges: bridgeStatuses(),
    backend: backendInfo(),
  })
})

app.use('/api/rooms', createRoomsRouter(ctx))
app.use('/api/match', createMatchRouter(ctx))
app.use('/api/events', createEventsRouter(ctx))
app.use('/api/auth', createAuthRouter(ctx))
app.use('/api/instances', createInstancesRouter(ctx))
app.use('/api/host', createHostRouter(ctx))
app.use('/api/jobs', createJobsRouter(ctx))
app.use('/api/records', createRecordsRouter(ctx))
app.use('/api/bots', createBotsRouter())
app.use('/api/debug', createDebugRouter(ctx))
app.use('/api/demos', createDemosRouter(ctx))
app.use('/api/servers', createServersRouter(ctx))
app.use('/api/game-servers', createGameServersRouter(ctx))
app.use('/api/settings', createSettingsRouter(ctx))
app.use('/api/admin', createAdminRouter(ctx))

// 兜底 404
app.use((req, res) => {
  res.status(404).json({ error: 'not found' })
})

// 错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err)
  res.status(500).json({ error: err.message || 'internal error' })
})

server.listen(config.port, () => {
  console.log(`[arena-backend] listening on :${config.port} (bridge=${config.bridge.mode})`)
  console.log(`[arena-backend] publicBaseUrl=${config.publicBaseUrl}`)
  console.log(`[arena-backend] db=${DB_PATH}`)
})

// BP 超时自动操作扫描
startVetoTimer(io)
// 实例冷却状态扫描(demo 到齐/超时 → 解除)
startCoolingSweep(config.demo.coolingSweepMs)
// demo 定期清理(启动 1s 后 + 周期)
startDemoCleanup(config.demo.cleanupIntervalMs)
// 录像定期归档:每天到点把实例 MatchZy/*.dem 归集到主机 demo_dir(组忙则跳过,见 lib/demoArchive.js)
startDemoArchiveScheduler(io)
// workshop 地图下载任务恢复(后端重启后继续轮询未完成任务)
initWorkshopJobs()
// 平台在线告警巡检:每 30s 一次,只在"告警出现/恢复"边沿打日志
setTimeout(() => sweepAlerts(), 10000)
setInterval(() => sweepAlerts(), 30000)
// 实例控制台实时流
initConsoleStream(io)
// 任务进度中继:桥的 push kind:'job' / job_report → admins 频道
// (仅管理员 socket 可订阅;REST 兜底见 GET /api/jobs/current|:id)
setJobPushHandler((serverId, msg) => {
  io.to('admins').emit('job:update', { serverId, ...msg })
  if (msg.status === 'done' || msg.status === 'failed' || msg.status === 'cancelled') {
    io.to('admins').emit('job:done', { serverId, jobId: msg.jobId, status: msg.status })
  }
  if (msg.line) io.to('admins').emit('job:output', { serverId, jobId: msg.jobId, line: msg.line })
})
// 实例清单变化(建/删/确认/主机侧对账收敛)→ admins 频道 instances:update
// (面板据此即时刷新实例列表,不再只靠 5s 轮询 /api/instances)
setInstancesNotifyHandler((payload) => {
  io.to('admins').emit('instances:update', payload)
})
// 反向 agent 通道(桥主动连接;http/stub 模式下无连接,无副作用)
initAgentChannel(server)
