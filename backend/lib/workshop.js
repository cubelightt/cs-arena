// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 社区地图(workshop)下载编排(仅管理员触发)
//
// 机制:主机上各实例的 `game/bin/linuxsteamrt64/steamapps/workshop/content/730/<地图ID>/`
// 已通过 symlink 共享一份,
// 因此「下载」= 向一个空闲运行中实例(默认 main,共享目录持有者)下发 `host_workshop_map <id>`,
// 由游戏进程自行从 Steam 创意工坊下载;文件落盘一份,全部实例直接可用。
//
// 完成判定 = 两阶段(防网络中断的"字节数假稳定"):
//   ① 共享目录中该 <id> 项字节数连续 stablePolls 个轮询周期不再增长(且 ≥ minPresentBytes);
//   ② 实例控制台日志尾段出现该图 addon 加载签名(host_workshop_map 下载完成后自动换图加载,
//      真机日志:`Mounting addon '<id>'` → `SV:  addon='<id>'` → `Spawn Server: <内部名>`);
//      ② 超时(WORKSHOP_LOAD_CONFIRM_MS,默认 5 分钟)判失败,可重试(重试命中已落盘则直接 done)。
// 桥仅提供无状态的 workshop_status 文件盘点 op;下载状态机(下发/轮询/确认/超时/实例锁)全在本模块。
//
// 实例锁:下载期间目标实例置 booting(防自动分配重启实例掐断下载),结束(成功/失败)后复位 idle。
// 任务登记持久化在 settings 表 `workshop_download_jobs`,后端重启后由 initWorkshopJobs 恢复轮询。
import { getDb, now } from '../db.js'
import config from '../config.js'
import { getCommunityMapByWorkshopId } from './matchjson.js'
import { instanceState, setState, provisioningMessage } from './instances.js'
import { maintenanceMessage } from './jobs.js'
import * as bridge from './bridge.js'

const JOBS = new Map() // workshopId → job
let sweepStarted = false

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function jobView(job) {
  if (!job) return null
  return {
    workshopId: job.workshopId,
    instance: job.instance,
    status: job.status, // downloading / done / failed
    stage: job.stage ?? null, // downloading(字节落盘中) / confirming(等待加载签名)
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    sizeBytes: job.sizeBytes ?? null,
    error: job.error ?? null,
    alreadyPresent: !!job.alreadyPresent,
  }
}

// ---- workshop 共享目录盘点(经桥;短 TTL 缓存,列表接口与轮询共用) ----
let itemsCache = { at: 0, instance: null, items: null }
const ITEMS_TTL_MS = 3000

export async function listWorkshopItems(instance) {
  const inst = String(instance || config.workshop.downloadInstance)
  if (itemsCache.items && itemsCache.instance === inst && now() - itemsCache.at < ITEMS_TTL_MS) {
    return itemsCache.items
  }
  const r = await bridge.bridgeWorkshopStatus(inst)
  const items = r.data?.items ?? {}
  itemsCache = { at: now(), instance: inst, items }
  return items
}

// ---- 任务持久化(settings 表单行 JSON;仅 downloading 任务需要跨重启恢复) ----
function persistJobs() {
  const rows = [...JOBS.values()].filter((j) => j.status === 'downloading')
  getDb()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('workshop_download_jobs', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(JSON.stringify(rows), now())
}

export function initWorkshopJobs() {
  let rows = []
  try {
    const raw = getDb().prepare("SELECT value FROM settings WHERE key = 'workshop_download_jobs'").get()?.value
    rows = raw ? JSON.parse(raw) : []
  } catch {
    rows = []
  }
  for (const j of rows) {
    if (j?.status !== 'downloading' || !j.workshopId) continue
    // 后端重启期间下载一直在主机侧进行(与后端无关),恢复轮询即可
    JOBS.set(String(j.workshopId), { ...j, stableCount: 0, lastSize: j.lastSize ?? 0 })
  }
  if (JOBS.size > 0) {
    console.log(`[workshop] 恢复 ${JOBS.size} 个下载任务轮询`)
    startSweep()
  }
}

function startSweep() {
  if (sweepStarted) return
  sweepStarted = true
  const pollMs = Math.max(200, config.workshop.pollMs)
  setInterval(() => {
    for (const job of [...JOBS.values()]) {
      pollJob(job).catch((err) => {
        console.warn(`[workshop] 任务 ${job.workshopId} 轮询异常: ${err.message}`)
      })
    }
  }, pollMs)
}

// 实例控制台日志尾段(每轮只读一次,成功/失败两种签名共用)
async function logTailLines(instance, lines = 200) {
  const r = await bridge.bridgeLog(instance, lines)
  return r.data?.lines ?? []
}

// 成功签名(host_workshop_map 下载完成后自动换图):
//   `Mounting addon '3344448932'` / `SV:  addon='3344448932'` / `... addons(3344448932) ...`
// 尾段中同一行同时含 addon 字样与 workshop id 即视为加载成功。
function addonLoadedInLog(lines, workshopId) {
  return lines.some((l) => /addon/i.test(l) && String(l).includes(String(workshopId)))
}

// 失败签名:引擎挂载该 addon 却发现里面没有任何地图 —— host_workshop_map 时共享目录为空、
// Steam 也没有重新拉取。真机(2026-09-19)两种成因都见过:①实例侧 Steam 会话陈旧 → 该 id 的
// 工坊信息请求被拒(主机 Steam 日志 `GetDetails … Access Denied`),重启实例即恢复;②目录被删但
// 主机 Steam 侧仍记「已安装」→ 需 scripts/workshop_forget.py 清记录。
// 真机日志:`GetAvailableAddonMaps failed to find any maps in the '3082605693' addon - ...`
//          → `CHostStateMgr::QueueNewRequest( Changelevel (error) …)` → `Error map!` → `Unmounting addon`
// 计数式判定:与任务启动时的基线计数比较,**新增**出现才算本次失败 —— 上一轮失败的同一行
// 可能仍在尾段(200 行)窗口内,避免误判;窗口滑动导致旧行滚出时新行计数同样大于基线。
const ADDON_MISSING_RE = /failed to find any maps/i

function countAddonMissing(lines, workshopId) {
  const id = String(workshopId)
  return lines.filter((l) => ADDON_MISSING_RE.test(String(l)) && String(l).includes(id)).length
}

async function pollJob(job) {
  if (job.status !== 'downloading') return
  // 实例中途停止(崩溃/被手动停止)→ 下载或加载无从继续,判失败
  try {
    if ((await bridge.instanceStatus(job.instance)) === 'STOPPED') {
      return finalizeJob(job, 'failed', `实例 @${job.instance} 在下载期间停止`)
    }
  } catch {}
  let items
  try {
    items = await listWorkshopItems(job.instance)
  } catch {
    return // 桥瞬时不可达:等下一轮,由超时兜底
  }
  const size = items[job.workshopId]?.size ?? 0
  job.sizeBytes = size

  // 失败签名快速判定(下载与加载阶段都适用):否则要空等 45 分钟总超时,期间实例锁一直被占
  let lines = null
  try {
    lines = await logTailLines(job.instance)
  } catch {}
  if (lines && countAddonMissing(lines, job.workshopId) > (job.failBaseline ?? 0)) {
    return finalizeJob(
      job,
      'failed',
      `实例控制台报告 addon '${job.workshopId}' 内没有任何地图(共享目录为空且 Steam 未重新下载该图)。处理方法:重启该实例后再重试——实例侧 Steam 会话状态陈旧时会拒绝该 id 的工坊信息请求(Access Denied),重启即恢复;若刚从共享目录删除过该图,另需清掉主机 steamapps/workshop 里该 id 的已安装记录`,
    )
  }

  if (job.stage !== 'confirming') {
    // ① 字节数稳定判定(且 ≥ minPresentBytes)
    if (size >= config.workshop.minPresentBytes) {
      if (size === job.lastSize) job.stableCount += 1
      else {
        job.stableCount = 0
        job.lastSize = size
      }
      if (job.stableCount >= config.workshop.stablePolls) {
        job.stage = 'confirming'
        job.confirmStart = now()
        persistJobs()
      }
    }
  }

  if (job.stage === 'confirming') {
    // ② 加载签名确认:字节数稳定 ≠ 下载完整(网络中断也会"稳定"),以引擎实际换图为准
    const loaded = lines ? addonLoadedInLog(lines, job.workshopId) : false
    if (loaded) return finalizeJob(job, 'done')
    if (config.workshop.loadConfirmMs > 0 && now() - job.confirmStart > config.workshop.loadConfirmMs) {
      const mb = Math.round((job.sizeBytes ?? 0) / 1024 / 1024)
      return finalizeJob(
        job,
        'failed',
        `地图文件已落盘(约 ${mb}MB)但 ${Math.round(config.workshop.loadConfirmMs / 60000)} 分钟内未在实例控制台确认加载成功(下载可能中断),请重试或检查主机日志`,
      )
    }
    if (config.workshop.loadConfirmMs <= 0) return finalizeJob(job, 'done')
    return
  }

  // 下载阶段的总超时兜底
  if (now() - job.startedAt > config.workshop.timeoutMs) {
    return finalizeJob(job, 'failed', `下载超时(>${Math.round(config.workshop.timeoutMs / 60000)} 分钟),请检查主机网络后重试`)
  }
}

function finalizeJob(job, status, error) {
  job.status = status
  job.error = error ?? null
  job.finishedAt = now()
  // 复位实例锁(仍为本任务占用的 booting 时;管理员中途 reset 的情况不覆盖)
  try {
    if (instanceState(job.instance) === 'booting') setState(job.instance, 'idle', null)
  } catch {}
  persistJobs()
  console.log(`[workshop] ${job.workshopId} 下载${status === 'done' ? '完成' : '失败'}${error ? `: ${error}` : ''}(size=${job.sizeBytes ?? 0})`)
}

// ---- 对外:启动下载(幂等) ----
// 返回 { job, started }。已下载(共享目录已有该 id)→ 直接 done;任务进行中 → 409;失败任务可重发。
export async function startWorkshopDownload({ workshopId, instance } = {}) {
  const wid = String(workshopId ?? '').trim()
  if (!getCommunityMapByWorkshopId(wid)) throw new HttpError(404, '社区地图不存在(请先在地图池调整中录入)')

  const instName = String(instance || config.workshop.downloadInstance)
  const row = getDb().prepare('SELECT * FROM instances WHERE name = ?').get(instName)
  if (!row) throw new HttpError(400, `实例 ${instName} 不存在`)

  const existing = JOBS.get(wid)
  if (existing && existing.status === 'downloading') throw new HttpError(409, `地图 ${wid} 已有下载任务进行中`)
  const groupBusy = [...JOBS.values()].find(
    (j) => j.status === 'downloading' && j.groupId === row.game_server_id && j.workshopId !== wid,
  )
  if (groupBusy) throw new HttpError(409, `服务器组内实例 ${groupBusy.instance} 正在下载地图 ${groupBusy.workshopId},请等待完成`)

  const groupId = row.game_server_id
  const already = JOBS.get(wid)

  // 文件系统真源:已存在(≥ minPresentBytes)则无需下载
  let items
  try {
    items = await listWorkshopItems(instName)
  } catch (err) {
    throw new HttpError(502, `实例所在主机桥不可达: ${err.message}`)
  }
  const present = items[wid]?.size ?? 0
  if (present >= config.workshop.minPresentBytes) {
    const job = {
      workshopId: wid,
      instance: instName,
      groupId,
      status: 'done',
      startedAt: now(),
      finishedAt: now(),
      sizeBytes: present,
      alreadyPresent: true,
    }
    JOBS.set(wid, job)
    return { job, started: false }
  }

  // 维护守卫:该组维护中(更新任务进行中)→ 拒绝下载;供给中(创建/删除/待确认)的实例同样拒绝
  {
    const row = getDb().prepare('SELECT game_server_id, provision_state FROM instances WHERE name = ?').get(instName)
    if (row?.provision_state) throw new HttpError(409, provisioningMessage(row))
    const maint = row ? maintenanceMessage(row.game_server_id) : null
    if (maint) throw new HttpError(409, maint)
  }
  // 目标实例须空闲且运行中(下载由游戏进程完成,系统不唤醒停止的实例)
  const state = instanceState(instName)
  if (state === 'in_match') throw new HttpError(409, `实例 @${instName} 正在比赛中`)
  if (state === 'cooling') throw new HttpError(409, `实例 @${instName} 冷却中,请稍后`)
  if (state === 'booting') throw new HttpError(409, `实例 @${instName} 正在启动/下载中`)
  let health
  try {
    health = await bridge.instanceStatus(instName)
  } catch (err) {
    throw new HttpError(502, `实例所在主机桥不可达: ${err.message}`)
  }
  if (health !== 'RUNNING') throw new HttpError(409, `实例 @${instName} 未运行,请管理员先启动`)

  // 失败签名基线:先记下下发前尾段里已有的失败行数,轮询只认「本次新增」的失败行
  let failBaseline = 0
  try {
    failBaseline = countAddonMissing(await logTailLines(instName), wid)
  } catch {}

  // 下发 host_workshop_map(管理控制台通道)→ 占实例锁 → 登记任务并开始轮询
  try {
    await bridge.bridgeConsole(instName, `host_workshop_map ${wid}`)
  } catch (err) {
    throw new HttpError(502, `下发 host_workshop_map 失败: ${err.message}`)
  }
  setState(instName, 'booting', null)
  const job = {
    workshopId: wid,
    instance: instName,
    groupId,
    status: 'downloading',
    stage: 'downloading',
    startedAt: now(),
    sizeBytes: 0,
    lastSize: 0,
    stableCount: 0,
    failBaseline,
    ...(already ? { attempts: (already.attempts ?? 1) + 1 } : { attempts: 1 }),
  }
  JOBS.set(wid, job)
  persistJobs()
  startSweep()
  return { job, started: true }
}

export function workshopJobOf(workshopId) {
  return jobView(JOBS.get(String(workshopId ?? '').trim()) ?? null)
}
