// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 实例控制台实时流
// stub 模式:后端每实例一个轮询器,定时从 stub 目录增量拉日志并广播
// reverse 模式(生产):桥本地 tail 推送(console/output/reset/state),后端仅中继到管理员 socket
import config from '../config.js'
import * as bridge from './bridge.js'
import { setConsolePushHandler, subscribeAgentConsole, unsubscribeAgentConsole } from './agentChannel.js'
import { instanceServer } from './gameServers.js'

let ioRef = null
const watchers = new Map() // instance → { timer, offset, path, listeners: Map<socketId, socket> }

export function initConsoleStream(io) {
  ioRef = io
  if (config.bridge.mode === 'reverse') {
    // reverse:桥推送 → 中继
    setConsolePushHandler((instance, kind, msg) => relayPush(instance, kind, msg))
  }
}

function relayPush(instance, kind, msg) {
  const w = watchers.get(instance)
  if (!w || w.listeners.size === 0) return
  if (kind === 'output') {
    for (const socket of w.listeners.values()) {
      socket.emit('console:output', { instance, path: msg.path, offset: msg.offset, lines: msg.lines || [] })
    }
  } else if (kind === 'reset') {
    for (const socket of w.listeners.values()) socket.emit('console:reset', { instance })
  } else if (kind === 'state') {
    for (const socket of w.listeners.values()) socket.emit('console:state', { instance, running: msg.running === true })
  }
}

function emitToListeners(instance, event, payload) {
  const w = watchers.get(instance)
  if (!w) return
  for (const socket of w.listeners.values()) {
    socket.emit(event, { instance, ...payload })
  }
}

async function poll(instance) {
  const w = watchers.get(instance)
  if (!w) return

  // 实例运行状态门禁
  let health
  try {
    health = await bridge.instanceStatus(instance)
  } catch {
    health = 'UNKNOWN'
  }
  if (health !== 'RUNNING') {
    emitToListeners(instance, 'console:state', { running: false })
    stopWatcher(instance)
    return
  }

  const r = await bridge.bridgeLogWithOffset(instance, w.offset)
  if (r.status !== 200 || !r.data?.path) {
    return // 日志暂不可用:下轮重试
  }
  const { path, offset, lines } = r.data
  if (w.path && path !== w.path) {
    emitToListeners(instance, 'console:reset', {}) // 文件轮换 = 实例重启 → 前端清空
    w.offset = 0
  } else {
    w.offset = offset
  }
  w.path = path
  if (lines.length > 0) {
    emitToListeners(instance, 'console:output', { path, offset, lines })
  }
}

function startWatcher(instance, initialOffset) {
  if (watchers.has(instance)) {
    if (initialOffset != null && initialOffset >= 0) watchers.get(instance).offset = initialOffset
    return
  }
  const w = { timer: null, offset: initialOffset ?? 0, path: null, listeners: new Map() }
  watchers.set(instance, w)
  w.timer = setInterval(() => {
    poll(instance).catch((e) => console.error(`[console-stream] ${instance}:`, e.message))
  }, config.consolePollMs)
  poll(instance).catch(() => {})
}

export function addConsoleListener(instance, socket, initialOffset) {
  if (!watchers.has(instance)) {
    if (config.bridge.mode === 'reverse') {
      const srv = instanceServer(instance)
      if (!srv) throw new Error(`实例 ${instance} 无归属服务器`)
      subscribeAgentConsole(srv.id, instance, initialOffset).catch((e) => {
        socket.emit('console:error', { instance, error: e.message })
      })
    } else {
      startWatcher(instance, initialOffset ?? null)
    }
  }
  const w = watchers.has(instance) ? watchers.get(instance) : { listeners: new Map() }
  if (!watchers.has(instance)) watchers.set(instance, w)
  w.listeners.set(socket.id, socket)
  bridge
    .instanceStatus(instance)
    .then((health) => socket.emit('console:state', { instance, running: health === 'RUNNING' }))
    .catch(() => {})
  return w
}

export function removeConsoleListener(instance, socketId) {
  const w = watchers.get(instance)
  if (!w) return
  w.listeners.delete(socketId)
  if (w.listeners.size === 0) {
    if (config.bridge.mode === 'reverse') {
      const srv = instanceServer(instance)
      if (srv) {
        unsubscribeAgentConsole(srv.id, instance).catch(() => {})
      }
    }
    stopWatcher(instance)
  }
}

export function stopWatcher(instance) {
  const w = watchers.get(instance)
  if (!w) return
  clearInterval(w.timer)
  watchers.delete(instance)
}

// socket 断开时清理其全部订阅
export function cleanupSocket(socketId) {
  for (const [instance, w] of watchers) {
    if (w.listeners.has(socketId)) {
      w.listeners.delete(socketId)
      if (w.listeners.size === 0) {
        if (config.bridge.mode === 'reverse') {
          const srv = instanceServer(instance)
          if (srv) {
            unsubscribeAgentConsole(srv.id, instance).catch(() => {})
          }
        }
        stopWatcher(instance)
      }
    }
  }
}
