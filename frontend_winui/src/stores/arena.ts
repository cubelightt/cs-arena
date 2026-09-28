// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { create } from 'zustand'
import {
  type AddBotsInput,
  type BotAimMode,
  type BotCatalog,
  type BotNadeMode,
  type CreateRoomInput,
  type MapMeta,
  type MatchRecord,
  type Room,
  type SpectateResult,
  type StartMatchResult,
  type SteamUser,
  type TeamSide,
} from '@/lib/types'
import { api, onRoomUpdate, onRoomRemoved, onMatchEvent, reconnectSocket, setUnauthorizedHandler } from '@/lib/api'

interface Toast {
  id: number
  title: string
  description?: string
  variant: 'default' | 'success' | 'error'
}

interface ArenaState {
  currentUser: SteamUser | null
  rooms: Room[]
  records: MatchRecord[]
  maps: MapMeta[]
  communityMaps: MapMeta[]
  botCatalog: BotCatalog | null
  latestScores: Record<string, { score1: number; score2: number }>
  matchRooms: Record<number, string>
  finalMaps: Record<string, string>
  matchServers: Record<string, string>
  toasts: Toast[]
  bootstrapped: boolean
  login: (user: SteamUser) => Promise<void>
  loginWithPassword: (steamId: string, password: string) => Promise<void>
  setupPassword: (steamId: string, password: string) => Promise<void>
  logout: () => Promise<void>
  bootstrap: () => Promise<void>
  toast: (title: string, description?: string, variant?: Toast['variant']) => void
  dismissToast: (id: number) => void
  getRoomByCode: (code: string) => Room | undefined
  createRoom: (input: CreateRoomInput) => Promise<Room>
  joinRoom: (code: string, password?: string) => Promise<string | null>
  joinRoomById: (id: string, password?: string) => Promise<string | null>
  leaveRoom: (roomId: string) => Promise<{ deleted: boolean }>
  kickPlayer: (roomId: string, playerId: string) => Promise<void>
  movePlayer: (roomId: string, playerId: string, team: TeamSide) => Promise<void>
  setTeam: (roomId: string, team: TeamSide | 'spec', slot?: number) => Promise<void>
  /** 非名单玩家「申请中途加入观战」（房间级/平台级开关都开才放行；重复申请幂等）。
   *  失败已 toast 并抛出，调用方按需处理 */
  spectate: (roomId: string) => Promise<SpectateResult>
  updateConfig: (
    roomId: string,
    patch: Partial<
      Pick<
        Room,
        | 'bestOf'
        | 'pickMode'
        | 'mapPoolKind'
        | 'maxRounds'
        | 'duelPreset'
        | 'teamA'
        | 'teamB'
        | 'specSeats'
        | 'password'
        | 'teamAName'
        | 'teamBName'
        | 'knifeRound'
        | 'autoFill'
        | 'friendlyFire'
        | 'allowDisplayName'
        | 'spectatorJoin'
        | 'recordDemo'
      > & {
        /** 实例最大玩家数（仅管理员可改；null = 清除房间覆盖、跟随全局默认） */
        maxPlayers?: number | null
      }
    >,
  ) => Promise<void>
  setServerChoice: (roomId: string, payload: { mode: 'auto' | 'manual'; group?: string; instance?: string }) => Promise<void>
  /** 对局显示名：改自己（需房间开关 allowDisplayName，管理员不受限）或改他人（仅管理员）。
   *  name 为空串 = 清空 → 回到账号昵称。返回是否保存成功（失败已统一 toast） */
  setDisplayName: (roomId: string, name: string, playerId?: string) => Promise<boolean>
  swapRequest: (roomId: string, targetPlayerId: string) => Promise<void>
  swapRespond: (roomId: string, targetPlayerId: string, accept: boolean) => Promise<void>
  transferCaptain: (roomId: string, targetPlayerId: string) => Promise<void>
  shuffleTeams: (roomId: string, includeCaptains: boolean) => Promise<void>
  addBots: (roomId: string, input: AddBotsInput) => Promise<void>
  removeBots: (roomId: string, botId?: string) => Promise<void>
  updateBotConfig: (roomId: string, patch: { botAim?: BotAimMode; botNades?: BotNadeMode }) => Promise<void>
  fetchBotCatalog: () => Promise<void>
  sideAction: (roomId: string, side: 'ct' | 't') => Promise<void>
  toggleDirectPick: (roomId: string, mapId: string) => Promise<void>
  startVeto: (roomId: string) => Promise<void>
  vetoAction: (roomId: string, mapId: string, type: 'ban' | 'pick') => Promise<void>
  resetVeto: (roomId: string) => Promise<void>
  startMatch: (roomId: string) => Promise<StartMatchResult>
  resetRoom: (roomId: string) => Promise<void>
  deleteRoom: (roomId: string) => Promise<void>
  refreshRooms: () => Promise<void>
  fetchRoom: (id: string) => Promise<Room | null>
  fetchRecords: () => Promise<void>
  fetchMaps: () => Promise<void>
  fetchCommunityMaps: () => Promise<void>
  applyRoom: (room: Room) => void
  applyRoomRemoved: (roomId: string) => void
}

let toastSeq = 1

export const useArena = create<ArenaState>()((set, get) => {
  function upsertRoom(room: Room) {
    set((s) => ({
      rooms: s.rooms.some((r) => r.id === room.id)
        ? s.rooms.map((r) => (r.id === room.id ? room : r))
        : [room, ...s.rooms],
    }))
  }

  function upsertScores(roomId: string, scores: { score1: number; score2: number }) {
    set((s) => ({ latestScores: { ...s.latestScores, [roomId]: scores } }))
  }

  setUnauthorizedHandler(() => {
    set({ currentUser: null, rooms: [], records: [] })
  })

  onRoomUpdate((room) => {
    const roomId = room.id
    const prev = get().rooms.find((r) => r.id === roomId)
    if (room.status === 'live' && prev?.status === 'waiting') {
      get().toast('比赛已开始', '服务器已就绪，请进入比赛连接游戏', 'success')
    }
    // 成员加入/离开横幅（仅自己在内的房间；自己的进出不提醒；人机增减不算玩家进出）
    const me = get().currentUser
    if (prev && me) {
      const memberIds = new Set<string>([
        ...prev.slots.filter((s) => !s.isBot).map((s) => s.player.steamId),
        ...room.slots.filter((s) => !s.isBot).map((s) => s.player.steamId),
      ])
      if (memberIds.has(me.steamId)) {
        const prevNames = new Map(
          prev.slots.filter((s) => !s.isBot).map((s) => [s.player.steamId, s.player.name] as const),
        )
        const nowIds = new Set(room.slots.filter((s) => !s.isBot).map((s) => s.player.steamId))
        for (const [id, name] of prevNames) {
          if (id !== me.steamId && !nowIds.has(id)) get().toast('玩家离开', `${name} 离开了房间`, 'default')
        }
        for (const s of room.slots) {
          if (!s.isBot && s.player.steamId !== me.steamId && !prevNames.has(s.player.steamId)) {
            get().toast('玩家加入', `${s.player.name} 加入了房间`, 'success')
          }
        }
      }
    }
    upsertRoom(room)
  })

  onRoomRemoved((roomId) => {
    set((s) => ({ rooms: s.rooms.filter((r) => r.id !== roomId) }))
    get().applyRoomRemoved(roomId)
  })

  onMatchEvent(({ matchId, event }) => {
    if (event.event !== 'round_end' && event.event !== 'map_result') return
    const winner = event.winner as { side?: string } | undefined
    if (!winner?.side) return
    const roomId = get().matchRooms[matchId]
    if (!roomId) return
    const scores = get().latestScores[roomId] ?? { score1: 0, score2: 0 }
    const isCt = winner.side === 'ct'
    upsertScores(roomId, {
      score1: scores.score1 + (isCt ? 1 : 0),
      score2: scores.score2 + (isCt ? 0 : 1),
    })
  })

  return {
    currentUser: null,
    rooms: [],
    records: [],
    maps: [],
    communityMaps: [],
    botCatalog: null,
    latestScores: {},
    matchRooms: {},
    finalMaps: {},
    matchServers: {},
    toasts: [],
    bootstrapped: false,

    toast: (title, description, variant = 'default') => {
      const id = toastSeq++
      set((s) => ({ toasts: [...s.toasts, { id, title, description, variant }] }))
      setTimeout(() => get().dismissToast(id), 3500)
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    bootstrap: async () => {
      try {
        const res = await api.get<{ user: SteamUser }>('/api/auth/me')
        set({ currentUser: res.user })
        reconnectSocket()
        get().fetchMaps()
        get().fetchCommunityMaps()
      } catch {
        set({ currentUser: null })
      }
      set({ bootstrapped: true })
    },

    login: async (user) => {
      const res = await api.post<{ user: SteamUser }>('/api/auth/login', user)
      set({ currentUser: res.user })
      reconnectSocket()
      get().fetchMaps()
      get().toast('登录成功', `欢迎，${res.user.name}`, 'success')
    },

    loginWithPassword: async (steamId, password) => {
      const res = await api.post<{ user: SteamUser }>('/api/auth/login', { steamId, password })
      set({ currentUser: res.user })
      reconnectSocket()
      get().fetchMaps()
      get().toast('登录成功', `欢迎，${res.user.name}`, 'success')
    },

    setupPassword: async (steamId, password) => {
      const res = await api.post<{ ok: boolean; user: SteamUser }>('/api/auth/set-password', { steamId, password })
      set({ currentUser: res.user })
      reconnectSocket()
      get().fetchMaps()
      get().toast('密码设置成功', `欢迎，${res.user.name}`, 'success')
    },

    logout: async () => {
      await api.post('/api/auth/logout').catch(() => undefined)
      set({ currentUser: null, rooms: [], records: [], maps: [], communityMaps: [], botCatalog: null, latestScores: {}, matchRooms: {}, finalMaps: {}, matchServers: {} })
      reconnectSocket()
    },

    getRoomByCode: (code) => get().rooms.find((r) => r.code.toUpperCase() === code.toUpperCase()),

    createRoom: async (input) => {
      const room = await api.post<Room>('/api/rooms', input)
      upsertRoom(room)
      return room
    },

    joinRoom: async (code, password) => {
      await get().refreshRooms()
      const room = get().rooms.find((r) => r.code.toUpperCase() === code.toUpperCase())
      if (!room) {
        get().toast('房间不存在', `未找到房间码 ${code}`, 'error')
        return null
      }
      return get().joinRoomById(room.id, password)
    },

    joinRoomById: async (id, password) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${id}/join`, { password: password || undefined })
        upsertRoom(room)
        get().toast('加入成功', `已加入 ${room.name}`, 'success')
        return room.id
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        get().toast('无法加入', msg, 'error')
        return null
      }
    },

    leaveRoom: async (roomId) => {
      try {
        const res = await api.post<{ ok?: boolean; deleted?: boolean }>(`/api/rooms/${roomId}/leave`)
        if (res?.deleted) {
          get().applyRoomRemoved(roomId)
          get().toast('房间已解散')
          return { deleted: true }
        }
        const room = await api.get<Room>(`/api/rooms/${roomId}`)
        upsertRoom(room)
        get().toast('已离开房间')
        return { deleted: false }
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
        return { deleted: false }
      }
    },

    kickPlayer: async (roomId, playerId) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/kick`, { playerId })
        upsertRoom(room)
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    movePlayer: async (roomId, playerId, team) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/move`, { playerId, team })
        upsertRoom(room)
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    setTeam: async (roomId, team, slot) => {
      try {
        // slot：v2 槽位语义（目标槽位序号）。后端未实现时忽略该字段，行为同旧版自动补位
        const room = await api.post<Room>(`/api/rooms/${roomId}/setteam`, { team, ...(slot !== undefined ? { slot } : {}) })
        upsertRoom(room)
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    spectate: async (roomId) => {
      try {
        const res = await api.post<SpectateResult>(`/api/rooms/${roomId}/spectate`)
        if (res.added) get().toast('已加入观战', '现在可以连接服务器进入观察位了', 'success')
        return res
      } catch (e) {
        get().toast('申请中途加入观战失败', e instanceof Error ? e.message : String(e), 'error')
        throw e
      }
    },

    updateConfig: async (roomId, patch) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/config`, patch)
        upsertRoom(room)
      } catch (e) {
        get().toast('设置保存失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    setServerChoice: async (roomId, payload) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/server`, payload)
        upsertRoom(room)
      } catch (e) {
        get().toast('服务器选择失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    setDisplayName: async (roomId, name, playerId) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/display-name`, {
          name,
          ...(playerId ? { playerId } : {}),
        })
        upsertRoom(room)
        // 界面上没有别处能看到该名字（房间页仍显示账号昵称），保存成功必须给一次可见反馈
        get().toast('局内ID已保存', name ? `开赛后游戏内显示：${name}` : '已恢复为账号昵称', 'success')
        return true
      } catch (e) {
        get().toast('保存失败', e instanceof Error ? e.message : String(e), 'error')
        return false
      }
    },

    swapRequest: async (roomId, targetPlayerId) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/swap/request`, { targetPlayerId })
        upsertRoom(room)
      } catch (e) {
        get().toast('换位申请失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    swapRespond: async (roomId, targetPlayerId, accept) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/swap/respond`, { targetPlayerId, accept })
        upsertRoom(room)
      } catch (e) {
        get().toast('响应失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    transferCaptain: async (roomId, targetPlayerId) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/captain/transfer`, { targetPlayerId })
        upsertRoom(room)
        get().toast('队长已移交', '新的队长已生效', 'success')
      } catch (e) {
        get().toast('移交失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    shuffleTeams: async (roomId, includeCaptains) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/shuffle`, { includeCaptains })
        upsertRoom(room)
        get().toast('随机分队完成', '阵容已重新分配', 'success')
      } catch (e) {
        get().toast('随机分队失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    // 增强人机：添加人机（single 指定名 / random 名字池随机 / proteam 职业队整队，仅 TeamB）
    addBots: async (roomId, input) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/bots`, input)
        upsertRoom(room)
      } catch (e) {
        get().toast('添加人机失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    // 增强人机：移除人机（带 botId 移单个；不带清空全部并清除职业队标记）
    removeBots: async (roomId, botId) => {
      try {
        const room = await api.del<Room>(`/api/rooms/${roomId}/bots${botId ? `/${botId}` : ''}`)
        upsertRoom(room)
      } catch (e) {
        get().toast('移除人机失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    // 增强人机：人机调优（开赛后经控制台 bot_aim / bot_nades 下发）
    updateBotConfig: async (roomId, patch) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/botconfig`, patch)
        upsertRoom(room)
      } catch (e) {
        get().toast('人机设置保存失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    fetchBotCatalog: async () => {
      try {
        const res = await api.get<BotCatalog>('/api/bots/catalog')
        set({ botCatalog: res })
      } catch {
        /* 目录拉取失败时选择器仅保留手输名字输入 */
      }
    },

    sideAction: async (roomId, side) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/side`, { side })
        upsertRoom(room)
      } catch (e) {
        get().toast('选边失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    toggleDirectPick: async (roomId, mapId) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/directpick`, { mapId })
        upsertRoom(room)
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    startVeto: async (roomId) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/veto/start`)
        upsertRoom(room)
        get().toast('BP 已开始', '由 Team A 队长先手 Ban', 'success')
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    vetoAction: async (roomId, mapId, type) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/veto`, { mapId, type })
        upsertRoom(room)
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    resetVeto: async (roomId) => {
      try {
        const room = await api.post<Room>(`/api/rooms/${roomId}/veto/reset`)
        upsertRoom(room)
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    startMatch: async (roomId) => {
      const res = await api.post<StartMatchResult>(`/api/rooms/${roomId}/start`)
      upsertRoom(res.room)
      set((s) => ({
        matchRooms: { ...s.matchRooms, [res.matchId]: roomId },
        finalMaps: res.finalMap ? { ...s.finalMaps, [roomId]: res.finalMap } : s.finalMaps,
        matchServers: { ...s.matchServers, [roomId]: res.instance },
      }))
      return res
    },

    resetRoom: async (roomId) => {
      const res = await api.post<{ ok: boolean; matchId: number | null }>(`/api/rooms/${roomId}/end`)
      if (res.matchId !== null) {
        get().toast('比赛已结束', '服务器已释放', 'success')
      }
      const room = await api.get<Room>(`/api/rooms/${roomId}`)
      upsertRoom(room)
    },

    deleteRoom: async (roomId) => {
      try {
        await api.del(`/api/rooms/${roomId}`)
        get().applyRoomRemoved(roomId)
        get().toast('房间已解散')
      } catch (e) {
        get().toast('操作失败', e instanceof Error ? e.message : String(e), 'error')
      }
    },

    refreshRooms: async () => {
      try {
        const rooms = await api.get<Room[]>('/api/rooms')
        set({ rooms: rooms as Room[] })
      } catch {
        /* 网络异常由统一错误处理提示 */
      }
    },

    fetchRoom: async (id) => {
      try {
        const room = await api.get<Room>(`/api/rooms/${id}`)
        upsertRoom(room)
        return room
      } catch {
        return null
      }
    },

    fetchRecords: async () => {
      try {
        const records = await api.get<MatchRecord[]>('/api/records')
        set({ records: records as MatchRecord[] })
      } catch {
        /* 忽略 */
      }
    },

    fetchMaps: async () => {
      try {
        const res = await api.get<{ maps: MapMeta[] }>('/api/settings/maps')
        set({ maps: res.maps })
      } catch {
        /* 目录拉取失败时地图渲染走兜底(显示名=id) */
      }
    },

    fetchCommunityMaps: async () => {
      try {
        const res = await api.get<{ maps: MapMeta[] }>('/api/settings/community-maps')
        set({ communityMaps: res.maps })
      } catch {
        /* 社区池拉取失败时仅社区选图无图可显(房间池由后端下发) */
      }
    },

    applyRoom: (room) => upsertRoom(room),

    applyRoomRemoved: (roomId) => {
      set((s) => ({ rooms: s.rooms.filter((r) => r.id !== roomId) }))
    },
  }
})
