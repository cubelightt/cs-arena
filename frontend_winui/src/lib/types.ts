// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

export type TeamSide = 'ct' | 't'
export type MatchType = 'custom' | 'duel'

export interface SteamUser {
  steamId: string
  name: string
  avatarUrl: string
  isAdmin?: boolean
}

export interface Player {
  id: string
  steamId: string
  name: string
  avatarUrl: string
}

export interface PlayerSlot {
  player: Player
  team: TeamSide | 'spec'
  /**
   * v2 扩展：队内槽位序号（0 基，各队伍独立编号）。
   * 后端落地槽位语义前该字段缺省 —— 前端回退为紧凑补位渲染；
   * 落地后：按 slot 落位渲染，点击空槽携带 index 直达指定槽位（同队移位原槽留空）。
   */
  slot?: number | null
  /** 增强人机槽位标记（伪玩家，steamId 形如 bot-1；不参与队长/换位申请） */
  isBot?: boolean
}

// ---- 增强人机模式（仅 botCapable 实例可用，见 增强人机设置）----

export type BotAimMode = 'mixed' | 'head' | 'body'
export type BotNadeMode = 'off' | 'less' | 'normal' | 'more' | 'max'

export interface BotProTeam {
  id: string
  name: string
  roster: string[]
}

/** GET /api/bots/catalog：人机名字池 + 职业队目录（前端选择器数据源） */
export interface BotCatalog {
  names: string[]
  proTeams: BotProTeam[]
}

export type AddBotsInput =
  | { mode: 'single'; name: string; team: TeamSide }
  | { mode: 'random'; team: TeamSide; count: number }
  | { mode: 'proteam'; teamId: string }

export const BOT_AIM_LABELS: Record<BotAimMode, string> = {
  mixed: '混合瞄准',
  head: '优先爆头',
  body: '优先躯干',
}

export const BOT_NADES_LABELS: Record<BotNadeMode, string> = {
  off: '禁用道具',
  less: '少量道具',
  normal: '正常道具',
  more: '大量道具',
  max: '地狱道具',
}

export type BestOf = 1 | 3
export type PickMode = 'direct' | 'veto' | 'community'
export type RoomStatus = 'waiting' | 'vetoing' | 'starting' | 'live' | 'finished'

/** 单挑对决（1v1）「地图池选择」：total=总竞技图池(官方图，默认) / duel=单挑图池(社区图中勾选「单挑对决」的地图)。
 *  仅 pickMode=direct 时决定房间地图池；仅 duel 房间可传（custom 房间传给后端 400） */
export type MapPoolKind = 'total' | 'duel'

export const MAP_POOL_KIND_LABELS: Record<MapPoolKind, string> = {
  total: '总竞技图池',
  duel: '单挑图池',
}

export interface MapDef {
  fullName: string
  displayName: string
  gradient: string
  workshopId?: string | null
  internalName?: string | null
}

// 地图目录条目(GET /api/settings/maps 官方 / /api/settings/community-maps 社区,同构)
// id:官方图=fullName(de_mirage);社区图=workshopId(数字串);matchTypes=适用房间类型
export interface MapMeta {
  id: string
  fullName: string
  displayName: string
  kind: 'official' | 'workshop'
  workshopId: string | null
  internalName: string | null
  matchTypes: MatchType[]
  /** 社区图后端缩略图（管理员上传，公开读取，恒为 WebP）；官方图无此字段 */
  hasThumbnail?: boolean
  /** 缩略图稳定直连路径（`<img>` 直接用，同官方图展示口径）；未上传为 null */
  thumbnailUrl?: string | null
  /** 主机共享目录是否已有该图（文件系统真源；桥不可达时 null = 未知） */
  downloaded?: boolean | null
  /** 已下载字节数（与 downloaded 同源；未知为 null） */
  sizeBytes?: number | null
}

export interface VetoAction {
  id: string
  mapId: string
  type: 'ban' | 'pick'
  byTeam: TeamSide
  byPlayerId: string
  at: number
}

export interface PendingSwap {
  id: string
  fromPlayerId: string
  targetPlayerId: string
  at: number
}

export interface ServerInfo {
  ip: string
  port: number
  password: string
  region: string
}

/** POST /api/rooms/:id/spectate 响应（非名单玩家「中途加入观战」申请）
 *  名单内玩家（参赛/观战席）alreadyInMatch=true 短路返回，不追加命令 */
export interface SpectateResult {
  ok: true
  alreadyInMatch: boolean
  /** 本次是否真的追加成功（重复申请为 false） */
  added?: boolean
  /** 实例侧使用的 ASCII 化名（控制台通道丢非 ASCII，空则回退 Spec-<后4位>） */
  name?: string
  /** 追加后剩余可申请席位 */
  seatsLeft?: number
  server: ServerInfo | null
}

/** GET /api/rooms/:id/status 的 match 字段（直链/刷新补状态用） */
export interface RoomStatusMatch {
  id: number
  status: string
  /** 本场占用的实例名（auto 分配模式下由后端给出，比赛页实例徽章用） */
  instanceName: string | null
  currentScores: { score1: number; score2: number } | null
  /** 本场经「中途加入观战」追加的非名单观战者 steamid（比赛页据此判断"我已获准观战"） */
  extraSpectators: string[]
}

/** GET /api/rooms/:id/status 响应 */
export interface RoomStatusResponse {
  room: Room
  match: RoomStatusMatch | null
  /** 观战开关快照：roomAllowed=房间开关（房主）/ platformAllowed=平台总开关（管理员） */
  spectate: { roomAllowed: boolean; platformAllowed: boolean }
}

export interface Room {
  id: string
  code: string
  name: string
  hostId: string
  password?: string
  matchType: MatchType
  teamA: number
  teamB: number
  teamAName: string
  teamBName: string
  specSeats: number
  bestOf: BestOf
  pickMode: PickMode
  /** 单挑对决「地图池选择」（仅 duel 房间）：total=总竞技图池 / duel=单挑图池；缺省视为 total（与后端一致） */
  mapPoolKind?: MapPoolKind
  /** 单挑对决回合局数（开赛经 cvars 下发 mp_maxrounds）：1~101 奇数；duel 房后端恒给生效值
   *  （房间覆盖 ?? 玩法类型默认：rifle/pistol/sniper 31、solo 固定 51），custom 房恒为 null。
   *  经 POST /rooms/:id/config 修改（仅房主；solo 下禁改 400） */
  maxRounds?: number | null
  /** 单挑玩法类型（仅 duel 房间；custom 房恒为 null）。缺省视为 rifle（与后端默认一致） */
  duelPreset?: DuelPreset | null
  status: RoomStatus
  slots: PlayerSlot[]
  mapPool: string[]
  banned: string[]
  picked: string[]
  vetoHistory: VetoAction[]
  vetoTurn: number
  vetoDeadlineAt: number | null
  bpPhase: 'ban' | 'pick' | 'side' | 'done' | null
  sideChoices: Record<number, string>
  sidePendingFor: 'team1' | 'team2' | null
  /** 竞技加时默认开启，BO3 强制开启；单挑始终关闭。 */
  overtimeEnabled?: boolean
  knifeRound: boolean
  /** 房间级「友军伤害」开关（仅房主可改，默认开启）。false = 开赛经比赛 JSON cvars 下发
   *  mp_friendlyfire 1 + ff_damage_reduction_bullets 0（队友免疫子弹伤害）；缺省视为开启 */
  friendlyFire?: boolean
  /** 开赛时实例的 -maxplayers 生效值 = maxPlayersOverride ?? 全局默认（见 GET /api/settings/max-players） */
  maxPlayers?: number
  /** 房间级 maxPlayers 覆盖（**仅管理员可改**；null = 跟随全局默认） */
  maxPlayersOverride?: number | null
  /** v2 扩展：槽位面板「自动补位」开关（房主可控，广播全体）。缺省视为关闭（精确槽位） */
  autoFill?: boolean
  /** 房间级「允许玩家修改局内ID」开关（房主可改，**默认关闭**）。关闭时只有管理员能改
   *  对局显示名（玩家自助改名 403）；开启后玩家可改自己。关掉开关不会清除已设置的名字 */
  allowDisplayName?: boolean
  /** 房间级「保存Demo」开关（房主/管理员可改，**默认开启**；缺省视为开启）。
   *  开赛时快照为比赛 JSON 的 record_demo，false = 不保存对局录像、完赛不再等待 Demo；
   *  录制门控由 ArenaMatch 插件执行（旧 MatchZy 不读取此字段） */
  recordDemo?: boolean
  /** 房间级「允许中途加入观战」开关（房主可改，**默认开启**；缺省视为开启）。
   *  关闭后本房间拒绝非名单观战申请（403）；平台级总开关见 settings.spectator_join（管理员） */
  spectatorJoin?: boolean
  /** 对局内显示名（比赛用 ID，与房间绑定，只在本房间生效）：`{ steamId: name }`，
   *  仅当前在房间的成员有条目；开赛时写进比赛 JSON 的玩家名（缺省用账号昵称） */
  displayNames?: Record<string, string>
  /** 增强人机模式：TeamB 全为人机、TeamA 为真人（可选加人机）；仅 `botCapable` 实例可用，固定 BO1 */
  botMode?: boolean
  /** 人机瞄准模式（开赛经 bot_aim 下发），默认 mixed */
  botAim?: BotAimMode
  /** 人机道具模式（开赛经 bot_nades 下发），默认 normal */
  botNades?: BotNadeMode
  /** 已添加的职业队 id（整队添加时写入，开赛下发 mp_teamlogo_2；清空人机时重置） */
  botProteam?: string | null
  captainA: string | null
  captainB: string | null
  pendingSwap: PendingSwap | null
  serverChoice: { mode: 'auto' | 'manual'; group: string | null; instance: string | null }
  server: ServerInfo | null
  createdAt: number
}

export interface RecordPlayer {
  steamId: string
  name: string
  avatarUrl: string
  team: TeamSide | 'spec'
  isHost: boolean
}

export interface GroupServer {
  name: string
  /** 游戏端口（后端来自实例表；未知为 0） */
  port?: number
  status: 'in_match' | 'idle' | 'stopped' | 'unknown' | string
  statusLabel: string
  health: string
  state: string
  matchId: number | null
  adminOnly?: boolean
  /** 增强人机模式可用实例（装有 CS2-Bot-Improver，当前为 match3） */
  botCapable?: boolean
}

export interface ServerGroup {
  groupId: string
  groupName: string
  hostIp: string
  region: string
  summary: { inMatch: number; idle: number; stopped: number; unknown: number }
  servers: GroupServer[]
}

// ---- 主机概况（管理面板「主机概况」Tab；GET /api/host/status，仅管理员；桥 v2 专属）----
// 数据源是桥的 host_status op（主机级只读盘点）；
// 旧 Python 桥未声明该能力 → 组对象 ok=false + error（前端按状态机降级渲染）。

/** 主机自身标识与能力（capabilities 是桥声明的能力名列表） */
export interface HostStatusHost {
  name?: string
  ip?: string
  agentVersion?: string
  capabilities?: string[]
}

export interface HostStatusDisk {
  totalBytes: number
  freeBytes: number
  usedPct: number
  /** true = 剩余空间低于更新阈值（minFreeBytes），面板要警示色 */
  warn: boolean
  minFreeBytes: number
}

export interface HostStatusMemory {
  totalBytes: number
  availableBytes: number
}

export interface HostStatusGameInstalled {
  build: string | null
  steamInfPath: string | null
  /** 安装清单 mtime，**秒**级时间戳（其它时间戳均为毫秒） */
  mtime: number | null
}

export interface HostStatusGameLatest {
  build: string | null
  /** 官方最新版本查询时间（毫秒） */
  queriedAt: number | null
  /** 查询来源，如 api.steamcmd.net */
  source: string | null
  /** 查询失败摘要（非空时前端显示「查询失败」，不整体报错） */
  error?: string | null
}

export interface HostStatusGame {
  installed: HostStatusGameInstalled | null
  latest: HostStatusGameLatest | null
  updateAvailable: boolean
}

export interface HostStatusProcess {
  running: boolean
  pid: number | null
  /** 进程运行时长（秒） */
  uptimeSec: number
  tmuxSession: string | null
}

export interface HostStatusInstance {
  name: string
  /** 桥侧编号（1 基） */
  idx: number
  port: number
  gotvPort: number
  process: HostStatusProcess
  /** 主机侧进程态（RUNNING/STOPPED/…），平台锁态见 GET /api/instances */
  health: string
  logPath: string | null
  logBytes: number
  addonsBytes: number
  demBytes: number
  /** 平台锁态（stub/真机都可能带，缺省不显示） */
  platformState?: string
  matchId?: number | null
}

/** 残留占用条目（M6 清理复用同一口径）；恒为对象，键可缺省 */
export interface HostStatusResidualEntry {
  path: string
  bytes: number
  files: number
}

export interface HostStatusResidual {
  demos?: HostStatusResidualEntry
  backup?: HostStatusResidualEntry
  msmLog?: HostStatusResidualEntry
  workshop?: HostStatusResidualEntry
  archives?: HostStatusResidualEntry
  /** 已删实例残留目录（仅在有残留时出现） */
  staleInstanceDirs?: string[]
  [k: string]: HostStatusResidualEntry | string[] | undefined
}

export interface HostStatusMaintenance {
  groupId: string
  enabled: boolean
  reason: string | null
  jobId: string | null
}

/** 单组主机概况（数组元素；ok=false 时除 groupId/groupName/error 外字段可缺省） */
export interface HostStatus {
  groupId: string
  groupName: string
  /** 该组的桥（agent）是否在线 */
  connected: boolean
  /** agent=真机数据；stub=后端本地夹具（仅开发联调） */
  dataSource?: 'agent' | 'stub'
  /** 本份数据的缓存时刻（毫秒） */
  cachedAt?: number
  ok: boolean
  /** 降级原因：有数据时是「数据可能过期」提示，ok=false 时是失败原因 */
  error?: string | null
  host?: HostStatusHost
  disk?: HostStatusDisk
  memory?: HostStatusMemory
  game?: HostStatusGame
  /** 空集合约定：恒为数组（[] 而非 null） */
  instances?: HostStatusInstance[]
  /** 空集合约定：恒为对象 */
  residual?: HostStatusResidual
  /** 空数组 = 非维护态 */
  maintenance?: HostStatusMaintenance[]
  /** 实例清单来源：backend=hello_ack 下发 / cache=离线缓存 / none=未获得 */
  instancesSource?: 'backend' | 'cache' | 'none'
}

export interface HostStatusResponse {
  ok: boolean
  /** 服务端缓存 TTL（毫秒），refresh=1 可绕过 */
  ttlMs: number
  groups: HostStatus[]
}

/** 桥能力名 → 中文（未登记的能力原样显示） */
export const CAPABILITY_LABELS: Record<string, string> = {
  config_sync: '配置同步',
  host_status: '主机概况',
  instances_report: '实例上报',
  state_sync: '状态同步',
}

/** 实例清单来源（instancesSource）文案；backend 是正常态，降级才需要提示 */
export const INSTANCES_SOURCE_LABELS: Record<string, string> = {
  backend: '实例清单：后端下发',
  cache: '实例清单：离线缓存',
  none: '实例清单：未获得',
}

/** 残留占用条目名 → 中文（未登记的原样显示） */
export const RESIDUAL_LABELS: Record<string, string> = {
  demos: '比赛录像',
  backup: '备份',
  msmLog: 'MSM 日志',
  workshop: '创意工坊',
  archives: '历史归档',
}

/** 残留条目的固定展示顺序（其后是后端新增的未知键，按字典序） */
export const RESIDUAL_ORDER = ['demos', 'backup', 'msmLog', 'workshop', 'archives']

// ---- 任务（job）与按组维护（管理面板「更新任务」Tab；M4 桥 v2 job 框架）----
// 任务真源在主机侧桥，平台 jobs 表是镜像；
// 面板日常用 socket 的 job:* 事件推进，REST 用于列表/详情/兜底。

export type JobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled'

/** 任务对象（GET /api/jobs 与 socket 的字段并集；socket 侧 id 叫 jobId） */
export interface Job {
  id: number
  /** 任务类型：game_update；M5 起有 provision_instance / delete_instance 等 */
  kind: string
  serverId?: string | null
  groupId: string | null
  instanceName?: string | null
  status: JobStatus
  /** 当前步骤名（与桥侧 internal/job/kinds.go 逐字一致） */
  step: string | null
  stepIndex: number
  stepTotal: number
  /** 0~100 */
  progress: number
  params?: Record<string, unknown>
  result?: unknown
  /** 失败原因；强制取消时是「可能半更新」的提示 */
  error?: string | null
  /** panel = 平台触发；cli = 主机侧 cs 命令发起（经 job_report 收敛） */
  origin: 'panel' | 'cli' | string
  createdBy: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** 按组维护态（后端只返回生效中的组） */
export interface MaintenanceInfo {
  groupId: string
  enabled: boolean
  reason: string | null
  jobId?: number | null
  startedAt?: number | null
  by?: string | null
}

export interface JobsResponse {
  ok: boolean
  jobs: Job[]
  /** 进行中（queued/running/cancelling） */
  active: Job[]
  maintenance: MaintenanceInfo[]
}

export interface JobsCurrentResponse {
  ok: boolean
  jobs: Job[]
  maintenance: MaintenanceInfo[]
}

export interface JobDetailResponse {
  ok: boolean
  job: Job
  lines?: string[]
  /** 增量拉取时返回的下一字节偏移（尾段读时后端给 size） */
  offset?: number
  size?: number
  error?: string
}

// ---- 实例生命周期（M5 建删实例闭环；管理面板「实例管理」Tab）----
// 供给态（provisionState）非 null 期间实例**不可分配/手动选择/启停**。

/** 供给状态：creating=正在建 / deleting=正在删 / failed=建失败（桥已回滚半成品，可重试）/ unconfirmed=主机侧建，待确认 */
export type ProvisionState = 'creating' | 'deleting' | 'failed' | 'unconfirmed'

/** 实例来源：seed=首次种子 / panel=面板创建或编辑 / bridge_report=主机侧创建（经 instances_report 登记） */
export type InstanceSource = 'seed' | 'panel' | 'bridge_report'

/** GET /api/instances 条目（M5 起含 idx / provisionState / provisionError / source） */
/** 一键启停全部（POST /api/instances/{start,stop}-all，仅管理员）：
 *  acted = 已下发命令的实例；skipped = 自动跳过的（已在目标状态 / 供给中 / 组维护中，带原因）；
 *  failed = 下发失败的（桥不可达等） */
export interface BulkInstanceOpResult {
  ok: boolean
  action: 'start' | 'stop'
  acted: string[]
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; error: string }>
}

export interface InstanceItem {
  name: string
  port: number
  state: string
  matchId: number | null
  health: string
  adminOnly?: boolean
  /** 实例编号（组内 1 基递增；删除后作废不回收） */
  idx: number | null
  provisionState: ProvisionState | null
  provisionError: string | null
  source: InstanceSource | null
}

/** 供给状态的面板表现（徽章文案 / 语气 / 置灰原因） */
export const PROVISION_META: Record<
  ProvisionState,
  { label: string; variant: 'info' | 'caution' | 'cautionSolid' | 'destructive'; hint: string }
> = {
  creating: {
    label: '创建中',
    variant: 'info',
    hint: '正在创建：创建期间不可启停/删除，任务结束后端口由主机回读',
  },
  deleting: { label: '删除中', variant: 'caution', hint: '正在删除：任务结束后卡片消失' },
  failed: {
    label: '创建失败',
    variant: 'destructive',
    hint: '上次创建失败（主机已回滚半成品）：可用同名实例「重试」，或先删除该行',
  },
  unconfirmed: {
    label: '待确认',
    variant: 'cautionSolid',
    hint: '主机侧创建（cs new）：点「确认」后才参与自动分配',
  },
}

export const INSTANCE_SOURCE_LABELS: Record<InstanceSource, string> = {
  seed: '首次种子',
  panel: '面板创建',
  bridge_report: '主机侧创建',
}

export const instanceSourceLabel = (source: InstanceSource | null | undefined) =>
  source ? (INSTANCE_SOURCE_LABELS[source] ?? source) : null

/** 实例名规则（与后端 `^[\w.-]{1,32}$` 一致） */
export const INSTANCE_NAME_RE = /^[\w.-]{1,32}$/
export const INSTANCE_NAME_HINT = '1~32 位字母/数字/下划线/点/连字符'

/** 建实例入参（POST /api/instances）：port 留空 = 主机自动分配；cloneFrom 留空 = 桥侧默认 main */
export interface InstanceCreateInput {
  name: string
  gameServerId: string
  port?: number | null
  cloneFrom?: string | null
}

/** instance_create 任务终态 result（桥回读；平台据此写回 port/idx） */
export interface InstanceCreateResult {
  name?: string
  idx?: number | null
  port?: number | null
  gotvPort?: number | null
}

/** instance_delete 任务终态 result（freedBytes = 释放字节数；removed = 被删目录） */
export interface InstanceDeleteResult {
  name?: string
  freedBytes?: number
  removed?: string[]
}

export interface InstanceCreateResponse {
  ok: boolean
  instance: InstanceItem | null
  task: Job
}

export interface InstanceDeleteResponse {
  ok: boolean
  task: Job
}

export interface InstanceConfirmResponse {
  ok: boolean
  instance: InstanceItem | null
}

/** GET /api/game-servers 的实例条目（M5 起含 idx/state/provisionState/source；服务器组 Tab 与建实例弹窗共用） */
export interface GroupInstanceItem {
  name: string
  port: number
  idx: number | null
  state: string
  provisionState: ProvisionState | null
  source: InstanceSource | null
}

/** GET /api/game-servers 条目（管理面板编辑用；含 bridge_token 明文与 bridge 连接态） */
export interface GameServerGroup {
  id: string
  name: string
  hostIp: string
  region: string
  bridgeUrl: string
  bridgeToken: string
  bridgeMode: string
  isActive: boolean
  connected?: boolean
  instances: GroupInstanceItem[]
}

/** 建/删实例的任务类型（面板按这两个 kind 关联到实例卡片） */
export const INSTANCE_JOB_KINDS = ['instance_create', 'instance_delete']

/** 任务终态 result（未知形状返回 null；建删任务的 port/idx/freedBytes 都在这里） */
export function jobResultOf<T>(job: Job | null | undefined): T | null {
  const r = job?.result
  return r && typeof r === 'object' ? (r as T) : null
}

/** 健康检查快照（房间页/服务器页据此提示维护中；5s 轮询） */
export interface HealthSnapshot {
  ok: boolean
  time: number
  bridgeMode?: string
  instances?: Array<{ name: string; port: number; state: string; matchId: number | null }>
  maintenance?: MaintenanceInfo[]
}

/** 游戏更新任务的 7 步计划（确认弹窗预览用；与桥侧 kinds.go 的 Step.Name 一致） */
export const GAME_UPDATE_STEPS = [
  '前置检查(磁盘余量/msm 可执行)',
  '停止全部实例',
  '备份关键产物(cfg + 实例 MatchZy 配置)',
  'msm update(steamcmd)',
  '启动全部实例',
  '回读状态与版本',
  '提示:CS2 更新可能还原主机侧补丁(需复测)',
]

/** 触发更新的二次确认串（后端精确校验，前端要求手工输入） */
export const UPDATE_CONFIRM = 'UPDATE'
/** 强制取消的二次确认串（后端精确校验） */
export const FORCE_CANCEL_CONFIRM = 'FORCE'
/** 主机清理「真删」的二次确认串（后端精确校验 `confirm:"CLEAN"`；dry-run 不需要） */
export const CLEANUP_CONFIRM = 'CLEAN'

/**
 * 磁盘清理的白名单模式（与桥 `cleanupPattern`、后端 `CLEANUP_PATTERNS` 一一对应；
 * 新增模式时三处同步）。`.dem` 永不在白名单内 —— 清理任务不会删录像。
 */
export const CLEANUP_PATTERNS: Array<{ id: string; label: string; desc: string }> = [
  { id: 'backup:old', label: '旧备份', desc: '归档根与 ~/backup 下的历次备份（每根保留最新一份，只删早于保留天数的）' },
  { id: 'logs:rotate', label: '日志轮转', desc: 'msm 实例控制台日志中早于保留天数的旧文件' },
  { id: 'sniper:stubs', label: 'sniper 残留', desc: 'msm 根下的 sniper_platform* / run-in-sniper* 残留' },
  { id: 'stale-instance-dirs', label: '已删实例目录', desc: '注册表里已不存在的实例遗留目录' },
  {
    id: 'bridge:old',
    label: '桥冗余件',
    desc: '桥自身目录：旧二进制/旧桥备份每类只留最新一份、bridge.log 超 8 MiB 轮转、__pycache__ 与超 20 份的旧任务日志',
  },
]

/** 录像归集任务的步骤（确认弹窗预览用；与桥侧 kinds_files.go 的 Step.Name 一致） */
export const DEMO_COLLECT_STEPS = ['归集对局录像']

/** 主机清理任务的步骤（确认弹窗预览用；与桥侧 kinds_files.go 的 Step.Name 一致） */
export const HOST_CLEANUP_STEPS = ['清理(白名单模式)']

export const JOB_STATUS_META: Record<JobStatus, { label: string; variant: 'success' | 'info' | 'caution' | 'destructive' | 'secondary' }> = {
  queued: { label: '排队中', variant: 'secondary' },
  running: { label: '进行中', variant: 'info' },
  cancelling: { label: '取消中', variant: 'caution' },
  done: { label: '已完成', variant: 'success' },
  failed: { label: '失败', variant: 'destructive' },
  cancelled: { label: '已取消', variant: 'secondary' },
}

export const JOB_KIND_LABELS: Record<string, string> = {
  game_update: '游戏更新',
  instance_create: '新建实例',
  instance_delete: '删除实例',
  plugin_sync: '插件同步',
  plugin_deploy: '插件部署',
  demo_collect: '录像归集',
  host_cleanup: '主机清理',
}

/** 任务是否仍在进行（终态三个：done/failed/cancelled） */
export const isJobActive = (status: JobStatus) => status === 'queued' || status === 'running' || status === 'cancelling'

export interface MatchRecord {
  id: string
  roomId: string
  roomName: string
  code: string
  matchType: MatchType
  bestOf: BestOf
  maps: string[]
  players: RecordPlayer[]
  score1: number | null
  score2: number | null
  winner: 'team1' | 'team2' | null
  createdAt: number
}

export interface StartMatchResult {
  matchId: number
  instance: string
  finalMap: string | null
  room: Room
}

export interface CreateRoomInput {
  overtimeEnabled?: boolean
  name: string
  matchType: MatchType
  /** 增强人机模式（仅 `botCapable` 实例可用；固定 BO1+关刀局，TeamB 全人机） */
  botMode?: boolean
}

export const TEAM_COUNT_OPTIONS = Array.from({ length: 10 }, (_, i) => i + 1)
/** 观战席数量选项：0 = 禁止观战（不显示「0 席」）；上限 5 由产品口径确定 */
export const SPEC_SEAT_OPTIONS = [0, 1, 2, 3, 4, 5]

/** 观战席数量文案：0 表示不允许观战 */
export const specSeatLabel = (n: number) => (n === 0 ? '禁止观战' : `${n} 席`)

/** 对局内显示名长度上限（与后端 normalizeDisplayName 的 DISPLAY_NAME_MAX 一致） */
export const DISPLAY_NAME_MAX = 32

/** 实例最大玩家数（-maxplayers）设置：全局默认（管理面板）与房间级覆盖共用同一结构 */
/** 录像定期归档设置(杂项设置;GET/PUT /api/settings/demo-archive,写仅管理员) */
export interface DemoArchiveSetting {
  /** 每日自动把实例 MatchZy/*.dem 归集到主机 demo_dir(只搬不删) */
  enabled: boolean
  /** 执行时刻(0~23 时整点) */
  hour: number
  /** 上次自动执行日期('YYYY-MM-DD';null = 尚未自动执行过) */
  lastRun: string | null
}

/** 全局建房模式开关(杂项设置;GET/PUT /api/settings/room-modes,写仅管理员) */
export interface RoomModeAvailability {
  custom: boolean
  duel: boolean
  botMode: boolean
}

export interface MaxPlayersSetting {
  /** 实例启动项 -maxplayers 的值（引擎口径，含 SourceTV 席位） */
  maxPlayers: number
  min: number
  max: number
  /** 实例固定占用的 SourceTV 席位数 → 可用玩家席 = maxPlayers - tvSlots */
  tvSlots: number
}

/** 首页内容（首页左右两卡）：settings KV 存储，管理面板「首页内容」在线编辑。
 *  source='file' = 更新日志尚未在后台保存过，内容来自仓库文件 update/CHANGELOG.md（左卡为空）；
 *  source='db' = 已保存过，以 DB 内容为准 */
export interface HomeContent {
  leftCard: string
  changelog: string
  source: 'file' | 'db'
}

/** 单挑玩法类型（duelPreset，仅 duel 房间可改；custom 房恒为 null）：
 *  solo 固定 51 回合 = 10 手枪 + 28 长枪 + 13 狙击（阶段回合数后端固定不可配），其余玩法 maxRounds 默认 31 */
export type DuelPreset = 'rifle' | 'pistol' | 'sniper' | 'solo'
export const DUEL_PRESET_LABELS: Record<DuelPreset, string> = {
  rifle: '长枪决斗',
  pistol: '手枪决斗',
  sniper: '狙击决斗',
  solo: 'Solo三项',
}

/** Solo三项各武器类别的回合数（后端固定，开赛经 arena_duel_phase_* cvars 下发，不可配置） */
export const DUEL_SOLO_PHASE_ROUNDS: Record<'pistol' | 'rifle' | 'sniper', number> = {
  pistol: 10,
  rifle: 28,
  sniper: 13,
}

export const MATCH_TYPE_LABELS: Record<MatchType, string> = {
  custom: '自定义竞技',
  duel: '单挑对决',
}
