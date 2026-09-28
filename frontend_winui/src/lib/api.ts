// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { io, type Socket } from 'socket.io-client'
import type { JobStatus, Room } from '@/lib/types'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) || ''

export class ApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(cb: () => void) {
  onUnauthorized = cb
}

export async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  // 上传（body 为 Blob/File）按原始字节发送：Content-Type 交给调用方指定，不能套 JSON
  const isUpload = typeof FormData !== 'undefined' && opts.body instanceof Blob
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    credentials: 'include',
    headers: isUpload ? opts.headers : { 'Content-Type': 'application/json', ...opts.headers },
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized()
    throw new ApiError(res.status, body?.error || `请求失败 (${res.status})`, body?.code)
  }
  return body as T
}

/** 图片字节上传的 Content-Type：用文件自身类型（仅 image/*），否则 octet-stream（后端按魔数嗅探） */
function uploadContentType(file: Blob): string {
  return file.type && file.type.startsWith('image/') ? file.type : 'application/octet-stream'
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  /** DELETE：部分端点要求 body（如删实例的 `{confirm:"<实例名>"}` 二次确认） */
  del: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) }),
  /** 原始字节上传（如社区地图缩略图 POST …/thumbnail，后端魔数嗅探 PNG/JPEG/WebP） */
  upload: <T>(path: string, file: Blob) =>
    apiFetch<T>(path, { method: 'POST', body: file, headers: { 'Content-Type': uploadContentType(file) } }),
}

let socket: Socket | null = null
const joinedRooms = new Set<string>()

export function getSocket(): Socket {
  if (!socket) {
    socket = io(BASE, { transports: ['websocket'] })
    socket.on('connect', () => {
      for (const roomId of joinedRooms) socket?.emit('join', { roomId })
    })
  }
  return socket
}

// 登录/登出后重连：服务端在 connection 时解析会话，登录前建立的连接没有 user
export function reconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket.connect()
  }
}

export function joinRoomChannel(roomId: string) {
  joinedRooms.add(roomId)
  getSocket().emit('join', { roomId })
}

export function leaveRoomChannel(roomId: string) {
  joinedRooms.delete(roomId)
  getSocket().emit('leave', { roomId })
}

type RoomUpdateHandler = (room: Room) => void
type RoomRemovedHandler = (roomId: string) => void
type MatchEventHandler = (payload: { matchId: number; event: Record<string, unknown> }) => void

/** 任务推送（admins 频道）：字段并集 —— 平台侧推 id，桥侧中继推 jobId */
export interface JobPushPayload {
  serverId?: string
  jobId?: number
  id?: number
  kind?: string
  groupId?: string | null
  status?: JobStatus
  step?: string | null
  stepIndex?: number
  stepTotal?: number
  progress?: number
  error?: string | null
  origin?: string
  /** 终态帧带的关键数据（建删实例的 port/idx/freedBytes 等，桥侧 push / 平台 task.result） */
  result?: unknown
  line?: string
}
type JobUpdateHandler = (payload: JobPushPayload) => void
type JobOutputHandler = (payload: { serverId?: string; jobId?: number; line: string }) => void
type JobDoneHandler = (payload: { serverId?: string; jobId?: number; status: JobStatus }) => void

const roomUpdateHandlers = new Set<RoomUpdateHandler>()
const roomRemovedHandlers = new Set<RoomRemovedHandler>()
const matchEventHandlers = new Set<MatchEventHandler>()
const jobUpdateHandlers = new Set<JobUpdateHandler>()
const jobOutputHandlers = new Set<JobOutputHandler>()
const jobDoneHandlers = new Set<JobDoneHandler>()

export function onRoomUpdate(cb: RoomUpdateHandler): () => void {
  roomUpdateHandlers.add(cb)
  return () => roomUpdateHandlers.delete(cb)
}
export function onRoomRemoved(cb: RoomRemovedHandler): () => void {
  roomRemovedHandlers.add(cb)
  return () => roomRemovedHandlers.delete(cb)
}
export function onMatchEvent(cb: MatchEventHandler): () => void {
  matchEventHandlers.add(cb)
  return () => matchEventHandlers.delete(cb)
}
export function onJobUpdate(cb: JobUpdateHandler): () => void {
  jobUpdateHandlers.add(cb)
  return () => jobUpdateHandlers.delete(cb)
}
export function onJobOutput(cb: JobOutputHandler): () => void {
  jobOutputHandlers.add(cb)
  return () => jobOutputHandlers.delete(cb)
}
export function onJobDone(cb: JobDoneHandler): () => void {
  jobDoneHandlers.add(cb)
  return () => jobDoneHandlers.delete(cb)
}

/** 推送里的任务号：平台侧推 `id`，桥侧中继推 `jobId` */
export const jobIdOf = (p: JobPushPayload): number | null => {
  const id = p.jobId ?? p.id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

// 管理员频道（任务进度/日志）：加入 admins 房间，断线重连后自动重订阅
let adminsSubscribed = false
export function subscribeAdmins(): () => void {
  adminsSubscribed = true
  const socket = getSocket()
  const emit = () => socket.emit('admins:subscribe')
  if (socket.connected) emit()
  else socket.once('connect', emit)
  return () => {
    adminsSubscribed = false
  }
}

getSocket().on('room:update', (room: Room) => roomUpdateHandlers.forEach((cb) => cb(room)))
getSocket().on('room:removed', (roomId: string) => roomRemovedHandlers.forEach((cb) => cb(roomId)))
getSocket().on('match:event', (payload: { matchId: number; event: Record<string, unknown> }) =>
  matchEventHandlers.forEach((cb) => cb(payload)),
)
getSocket().on('job:update', (p: JobPushPayload) => jobUpdateHandlers.forEach((cb) => cb(p)))
getSocket().on('job:output', (p: { serverId?: string; jobId?: number; line: string }) =>
  jobOutputHandlers.forEach((cb) => cb(p)),
)
getSocket().on('job:done', (p: { serverId?: string; jobId?: number; status: JobStatus }) =>
  jobDoneHandlers.forEach((cb) => cb(p)),
)
getSocket().on('connect', () => {
  if (adminsSubscribed) getSocket().emit('admins:subscribe')
})
