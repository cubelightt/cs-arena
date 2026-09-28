// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 地图池管理
// 总竞技图池 = maps 表 kind=official(官方名+中文显示名);社区地图池 = maps 表 kind=workshop(workshop id+内部名)
// 服役地图池(active_map_pool)= 恒 7 张官方图,BP 专用
// 服役池/总池读任意登录;写仅管理员
import { Router } from 'express'
import express from 'express'
import { requireAuth, requireAdmin } from '../lib/auth.js'
import {
  getActiveMapPool, setActiveMapPool, getDisconnectGrace, setDisconnectGrace, getHomeContent, setHomeContent,
  getDemoArchive, setDemoArchive, getRoomModeAvailability, setRoomModeAvailability,
} from '../lib/settings.js'
import { runDemoArchiveAll } from '../lib/demoArchive.js'
import { getSpectatorJoinSetting, setSpectatorJoinSetting } from '../lib/spectators.js'
import { getMaxPlayersSetting, setDefaultMaxPlayers } from '../lib/roomlimits.js'
import { listMaps, listCommunityMaps, getCommunityMapByWorkshopId, getMap } from '../lib/matchjson.js'
import { listWorkshopItems, startWorkshopDownload, workshopJobOf } from '../lib/workshop.js'
import { readThumbnail, saveThumbnail, deleteThumbnail, sniffImageExt, MAP_IMAGE_MAX_BYTES } from '../lib/mapimages.js'
import { getDb, now } from '../db.js'

const FULL_NAME_RE = /^(de|cs)_[a-z0-9_]+$/
// 社区图内部地图名放宽(竞技场/单挑图多为 aim_xxx / 1v1_xxx 等,非 de_/cs_ 前缀;如 aim_gryn)
const COMMUNITY_INTERNAL_NAME_RE = /^[a-z0-9_]{3,32}$/
const WORKSHOP_ID_RE = /^\d{6,20}$/
const NAME_MAX = 32
const MATCH_TYPES = ['custom', 'duel']

export function createSettingsRouter() {
  const router = Router()

  // ---- 服役地图池(恒 7 张,从总池选择;BP 专用) ----
  router.get('/map-pool', requireAuth(), (req, res) => {
    res.json({ mapIds: getActiveMapPool() })
  })

  router.put('/map-pool', requireAdmin(), (req, res) => {
    const { mapIds } = req.body ?? {}
    try {
      res.json({ mapIds: setActiveMapPool(mapIds) })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // ---- 杂项设置:断线自动退房宽限 ----
  // 读任意登录(前端管理面板展示);写仅管理员。{ enabled: boolean, seconds: 0~999(0=永不超时) }
  router.get('/disconnect', requireAuth(), (req, res) => {
    res.json(getDisconnectGrace())
  })

  router.put('/disconnect', requireAdmin(), (req, res) => {
    const { enabled, seconds } = req.body ?? {}
    try {
      res.json(setDisconnectGrace({ enabled, seconds }))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // ---- 杂项设置:全局建房模式开关 ----
  // 读任意登录(创建房间弹窗);写仅管理员。缺省三种模式全部开启。
  router.get('/room-modes', requireAuth(), (req, res) => {
    res.json(getRoomModeAvailability())
  })

  router.put('/room-modes', requireAdmin(), (req, res) => {
    try {
      res.json(setRoomModeAvailability(req.body ?? {}))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // ---- 首页内容(左卡 + 更新日志):读任意登录(首页展示),写仅管理员(管理面板在线编辑) ----
  // { leftCard, changelog, source };source='file' = 更新日志尚未在后台保存过(来自仓库 update/CHANGELOG.md)
  router.get('/home-content', requireAuth(), (req, res) => {
    res.json(getHomeContent())
  })

  router.put('/home-content', requireAdmin(), (req, res) => {
    try {
      res.json(setHomeContent(req.body ?? {}))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // ---- 杂项设置:非名单用户中途加入观战 ----
  // 读任意登录(前端判断是否显示「观战」入口);写仅管理员。{ allow: boolean },默认 false = 不允许
  router.get('/spectator-join', requireAuth(), (req, res) => {
    res.json(getSpectatorJoinSetting())
  })

  router.put('/spectator-join', requireAdmin(), (req, res) => {
    try {
      res.json(setSpectatorJoinSetting(req.body?.allow))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // ---- 实例最大玩家数默认值(-maxplayers):房间/实例容量上限 ----
  // 读任意登录;写仅管理员。{ maxPlayers, min, max, tvSlots }(tvSlots = SourceTV 固定占席)
  router.get('/max-players', requireAuth(), (req, res) => {
    res.json(getMaxPlayersSetting())
  })

  router.put('/max-players', requireAdmin(), (req, res) => {
    try {
      res.json(setDefaultMaxPlayers(req.body?.maxPlayers))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // ---- 录像定期归档(杂项设置;M6)----------------------------------------------
  // 读任意登录(面板展示);写仅管理员。{ enabled: boolean, hour: 0~23, lastRun: 'YYYY-MM-DD' }
  router.get('/demo-archive', requireAuth(), (req, res) => {
    res.json(getDemoArchive())
  })

  router.put('/demo-archive', requireAdmin(), (req, res) => {
    try {
      res.json(setDemoArchive(req.body ?? {}))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // 立即归档一次(仅管理员;不等定时):对全部"可归档"的组各下一个 demo_collect 任务(全量、真搬)。
  // 组忙/桥未连等原因逐组返回 started=false + reason(面板据此提示),不影响其它组。
  router.post('/demo-archive/run', requireAdmin(), async (req, res) => {
    try {
      const results = await runDemoArchiveAll(req.app.get('io'), { trigger: 'panel' })
      const started = results.filter((r) => r.started)
      res.json({
        ok: true,
        started: started.length,
        jobs: started.map((r) => r.job),
        skipped: results.filter((r) => !r.started),
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ---- 总竞技图池(官方图,maps 表 kind=official) ----
  router.get('/maps', requireAuth(), (req, res) => {
    res.json({ maps: listMaps().filter((m) => m.kind === 'official') })
  })

  // 录入官方地图:POST { fullName: "de_office", displayName: "办公室" } → 自动入总池
  router.post('/maps', requireAdmin(), (req, res) => {
    const fullName = String(req.body?.fullName ?? '').trim()
    const displayName = String(req.body?.displayName ?? '').trim()
    if (!FULL_NAME_RE.test(fullName)) {
      return res.status(400).json({ error: 'fullName 需为官方地图名(如 de_mirage / cs_office)' })
    }
    if (fullName.length > NAME_MAX) return res.status(400).json({ error: `fullName 过长(上限 ${NAME_MAX} 字符)` })
    if (!displayName) return res.status(400).json({ error: 'displayName 不能为空' })
    if (displayName.length > NAME_MAX) return res.status(400).json({ error: `displayName 过长(上限 ${NAME_MAX} 字符)` })
    if (getMap(fullName)) return res.status(409).json({ error: `地图 ${fullName} 已存在` })
    getDb()
      .prepare('INSERT INTO maps (full_name, display_name, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(fullName, displayName, 'official', now())
    res.status(201).json({ map: getMap(fullName) })
  })

  // 修改官方地图中文名:仅更新 display_name,fullName 为身份键不可改
  router.put('/maps/:fullName', requireAdmin(), (req, res) => {
    const fullName = String(req.params.fullName ?? '')
    const map = getMap(fullName)
    if (!map) return res.status(404).json({ error: '地图不存在' })
    const displayName = String(req.body?.displayName ?? '').trim()
    if (!displayName) return res.status(400).json({ error: 'displayName 不能为空' })
    if (displayName.length > NAME_MAX) return res.status(400).json({ error: `displayName 过长(上限 ${NAME_MAX} 字符)` })
    getDb().prepare('UPDATE maps SET display_name = ? WHERE full_name = ?').run(displayName, fullName)
    res.json({ map: getMap(fullName) })
  })

  // 移除官方地图:服役池在用 → 409;总池将不足 7 张 → 409
  router.delete('/maps/:fullName', requireAdmin(), (req, res) => {
    const fullName = String(req.params.fullName ?? '')
    if (!getMap(fullName)) return res.status(404).json({ error: '地图不存在' })
    const active = getActiveMapPool()
    if (active.includes(fullName)) {
      return res.status(409).json({ error: '服役地图池正在使用该地图,请先从服役池移除' })
    }
    const total = listMaps().filter((m) => m.kind === 'official')
    if (total.length <= 7) return res.status(409).json({ error: '总竞技图池至少需保留 7 张(服役池恒 7 张)' })
    getDb().prepare('DELETE FROM maps WHERE full_name = ?').run(fullName)
    res.json({ ok: true, maps: listMaps().filter((m) => m.kind === 'official') })
  })

  // ---- 社区地图池(workshop 图,独立管理) ----
  // 列表附带下载状态(downloaded/sizeBytes 来自主机共享目录文件系统真源;桥不可达时为 null=未知)
  router.get('/community-maps', requireAuth(), async (req, res) => {
    const maps = listCommunityMaps()
    let items = null
    try {
      items = await listWorkshopItems()
    } catch {}
    res.json({
      maps: maps.map((m) => ({
        ...m,
        downloaded: items ? (items[m.workshopId]?.size ?? 0) > 0 : null,
        sizeBytes: items ? (items[m.workshopId]?.size ?? null) : null,
      })),
    })
  })

  // 录入社区地图:POST { displayName, workshopId, internalName, matchTypes, localMap? }
  // workshopId 为创意工坊 id(host_workshop_map <id> 加载);internalName 为服务器内部地图名(MatchZy 换图必需)
  // localMap=true(方案②):本地图 —— 以实例本地 maps/<internalName>.vpk 加载(不挂载工坊 addon,
  // 地图脚本/自带 cfg 均不存在,参数全由平台接管);开赛前经桥预检本地文件,部署见 scripts/deploy-local-map.sh
  router.post('/community-maps', requireAdmin(), (req, res) => {
    const displayName = String(req.body?.displayName ?? '').trim()
    const workshopId = String(req.body?.workshopId ?? '').trim()
    const internalName = String(req.body?.internalName ?? '').trim()
    const matchTypes = req.body?.matchTypes
    const localMap = req.body?.localMap === true
    if (!displayName) return res.status(400).json({ error: 'displayName 不能为空' })
    if (displayName.length > NAME_MAX) return res.status(400).json({ error: `displayName 过长(上限 ${NAME_MAX} 字符)` })
    if (!WORKSHOP_ID_RE.test(workshopId)) return res.status(400).json({ error: 'workshopId 需为创意工坊数字 id(6~20 位)' })
    if (!COMMUNITY_INTERNAL_NAME_RE.test(internalName)) {
      return res.status(400).json({ error: 'internalName 需为服务器内部地图名(3~32 位小写字母/数字/下划线,如 de_breach / aim_gryn)' })
    }
    if (!Array.isArray(matchTypes) || matchTypes.length === 0 || !matchTypes.every((t) => MATCH_TYPES.includes(t))) {
      return res.status(400).json({ error: `matchTypes 必须为非空数组,取值为 ${MATCH_TYPES.join(' / ')}` })
    }
    if (getCommunityMapByWorkshopId(workshopId)) return res.status(409).json({ error: `社区地图 ${workshopId} 已存在` })
    // 内部名不得与官方图冲突(MatchZy 换图会误认)
    if (getMap(internalName)) return res.status(400).json({ error: `internalName ${internalName} 与官方图重名` })
    getDb()
      .prepare('INSERT INTO maps (full_name, display_name, kind, workshop_id, internal_name, match_types, local_map, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(workshopId, displayName, 'workshop', workshopId, internalName, JSON.stringify([...new Set(matchTypes)]), localMap ? 1 : 0, now())
    res.status(201).json({ map: getCommunityMapByWorkshopId(workshopId) })
  })

  // 修改社区地图:{ displayName, internalName, matchTypes? };workshopId 为身份键不可改
  // internalName 变更仅影响新比赛 maplist,历史比赛 JSON 不变
  router.put('/community-maps/:workshopId', requireAdmin(), (req, res) => {
    const workshopId = String(req.params.workshopId ?? '')
    const map = getCommunityMapByWorkshopId(workshopId)
    if (!map) return res.status(404).json({ error: '社区地图不存在' })
    const patch = {}
    if (req.body?.displayName !== undefined) {
      const displayName = String(req.body.displayName ?? '').trim()
      if (!displayName) return res.status(400).json({ error: 'displayName 不能为空' })
      if (displayName.length > NAME_MAX) return res.status(400).json({ error: `displayName 过长(上限 ${NAME_MAX} 字符)` })
      patch.display_name = displayName
    }
    if (req.body?.internalName !== undefined) {
      const internalName = String(req.body.internalName ?? '').trim()
      if (!COMMUNITY_INTERNAL_NAME_RE.test(internalName)) {
        return res.status(400).json({ error: 'internalName 需为服务器内部地图名(3~32 位小写字母/数字/下划线,如 de_breach / aim_gryn)' })
      }
      // 排除自身:社区图行 full_name=workshopId(数字串),getMap 按 full_name 查不会命中自身
      if (getMap(internalName)) return res.status(400).json({ error: `internalName ${internalName} 与官方图重名` })
      patch.internal_name = internalName
    }
    if (req.body?.matchTypes !== undefined) {
      const matchTypes = req.body.matchTypes
      if (!Array.isArray(matchTypes) || matchTypes.length === 0 || !matchTypes.every((t) => MATCH_TYPES.includes(t))) {
        return res.status(400).json({ error: `matchTypes 必须为非空数组,取值为 ${MATCH_TYPES.join(' / ')}` })
      }
      patch.match_types = JSON.stringify([...new Set(matchTypes)])
    }
    if (req.body?.localMap !== undefined) {
      // 本地自维护图开关(方案②):切换只改流程(工坊加载 ↔ 本地文件加载),文件部署需配合
      // scripts/deploy-local-map.sh;未部署时开赛会报「未部署」错误
      patch.local_map = req.body.localMap === true ? 1 : 0
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: '无可更新字段(displayName / internalName / matchTypes / localMap)' })
    }
    const sets = Object.keys(patch).map((k) => `${k} = ?`)
    getDb()
      .prepare(`UPDATE maps SET ${sets.join(', ')} WHERE workshop_id = ?`)
      .run(...Object.values(patch), workshopId)
    res.json({ map: getCommunityMapByWorkshopId(workshopId) })
  })

  // 移除社区地图(房间引用遗留由开赛校验兜底)
  router.delete('/community-maps/:workshopId', requireAdmin(), (req, res) => {
    const workshopId = String(req.params.workshopId ?? '')
    const map = getCommunityMapByWorkshopId(workshopId)
    if (!map) return res.status(404).json({ error: '社区地图不存在' })
    getDb().prepare('DELETE FROM maps WHERE workshop_id = ?').run(workshopId)
    // 缩略图随地图条目一并清理(共享目录中的地图文件不动,重录同 id 免重复下载)
    deleteThumbnail(workshopId)
    res.json({ ok: true, maps: listCommunityMaps() })
  })

  // ---- 社区地图下载(仅管理员;文件落主机共享目录一份,全实例共用,见 lib/workshop.js 头注释) ----
  // 启动:POST { instance? }(缺省 WORKSHOP_DOWNLOAD_INSTANCE=main)→ 立即返回任务,进度经 GET 轮询
  router.post('/community-maps/:workshopId/download', requireAdmin(), async (req, res) => {
    try {
      const { job, started } = await startWorkshopDownload({
        workshopId: req.params.workshopId,
        instance: req.body?.instance,
      })
      res.json({ ok: true, started, job })
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message })
    }
  })

  // 状态:GET → 任务(内存状态机)+ 文件系统真源(downloaded/sizeBytes;桥不可达为 null)
  router.get('/community-maps/:workshopId/download', requireAuth(), async (req, res) => {
    const workshopId = String(req.params.workshopId ?? '')
    if (!getCommunityMapByWorkshopId(workshopId)) return res.status(404).json({ error: '社区地图不存在' })
    let downloaded = null
    let sizeBytes = null
    try {
      const items = await listWorkshopItems()
      sizeBytes = items[workshopId]?.size ?? 0
      downloaded = sizeBytes > 0
    } catch {}
    res.json({ workshopId, job: workshopJobOf(workshopId), downloaded, sizeBytes })
  })

  // ---- 社区地图缩略图(仅管理员上传;公开读取,与官方图前端静态资源同一展示口径) ----
  // 上传原始图片字节(image/png|jpeg|webp 或 octet-stream;魔数嗅探,≤ MAP_IMAGE_MAX_BYTES),覆盖式
  router.post(
    '/community-maps/:workshopId/thumbnail',
    requireAdmin(),
    express.raw({ type: () => true, limit: MAP_IMAGE_MAX_BYTES + 64 * 1024 }),
    async (req, res) => {
      const workshopId = String(req.params.workshopId ?? '')
      if (!getCommunityMapByWorkshopId(workshopId)) return res.status(404).json({ error: '社区地图不存在' })
      const buf = req.body
      if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: '缺少图片数据(请以原始字节上传)' })
      if (buf.length > MAP_IMAGE_MAX_BYTES) {
        return res.status(400).json({ error: `图片过大(上限 ${Math.round(MAP_IMAGE_MAX_BYTES / 1024 / 1024)}MB)` })
      }
      if (!sniffImageExt(buf)) return res.status(400).json({ error: '仅支持 PNG / JPEG / WebP 图片' })
      // 统一转 WebP 存储(与官方图前端静态资源同格式;sharp 重编码)
      try {
        await saveThumbnail(workshopId, buf)
      } catch (err) {
        return res.status(500).json({ error: `缩略图转换失败: ${err.message}` })
      }
      res.json({ ok: true, map: getCommunityMapByWorkshopId(workshopId) })
    },
  )

  // 读取:公开(无鉴权)—— 前端 <img> 直连稳定路径;未上传 404
  router.get('/community-maps/:workshopId/thumbnail', (req, res) => {
    const img = readThumbnail(String(req.params.workshopId ?? ''))
    if (!img) return res.status(404).json({ error: '未上传缩略图' })
    res.setHeader('Content-Type', img.contentType)
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.send(img.buf)
  })

  // 删除缩略图(仅管理员;地图条目保留)
  router.delete('/community-maps/:workshopId/thumbnail', requireAdmin(), (req, res) => {
    const workshopId = String(req.params.workshopId ?? '')
    if (!getCommunityMapByWorkshopId(workshopId)) return res.status(404).json({ error: '社区地图不存在' })
    const removed = deleteThumbnail(workshopId)
    res.json({ ok: true, removed, map: getCommunityMapByWorkshopId(workshopId) })
  })

  return router
}
