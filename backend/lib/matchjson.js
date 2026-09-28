// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 比赛 JSON 生成器:房间状态 → MatchZy 接受的下发格式
// 源码核对(0.8.15):
//  - 必填: maplist / team1 / team2 / num_maps
//  - teamX.players 必须是对象 {"steamid": "名字"}(GetPlayerTeam 用 steamId.ToString() 索引)
//  - maplist.length == num_maps → 强制 skip_veto,按前 num_maps 张图开赛
//  - cvars 两处执行:loadmatch 时(warmup 前)一次;exec live.cfg **之后**再执行一次
//    (SetupLiveFlagsAndCfg 内 1s 计时器 → ExecuteChangedConvars)—— 房间级 cvar 覆盖
//    (如关闭友军伤害)必须走这里,自行 send 会被 live.cfg 的取值覆盖
//  - maplist 必须是完整地图名(de_nuke 等);ChangeMap 仅当 IsMapValid 才 changelevel,
//    短 id(如 nuke)会导致换图被静默跳过,比赛永远打服务器启动图
import { getDb } from '../db.js'
import { friendlyFireCvars } from './friendlyfire.js'
import { duelMatchCvars } from './duel.js'
import { matchStartAnnouncementCvars } from './announce.js'
import { hasThumbnail } from './mapimages.js'

// 地图 id 统一为**官方名称**(de_mirage / cs_office),目录存 maps 表(官方名+中文显示名)。
// 下表仅为旧 7 图短 id(mirage)的**迁移别名**,新代码不再写入短 id。
export const MAP_NAME_MAP = {
  mirage: 'de_mirage',
  inferno: 'de_inferno',
  nuke: 'de_nuke',
  dust2: 'de_dust2',
  ancient: 'de_ancient',
  anubis: 'de_anubis',
  vertigo: 'de_vertigo',
}

// 总竞技图池(maps 表全部,含社区图):[
//   { id, fullName, displayName, kind: 'official'|'workshop', workshopId, internalName, matchTypes }
// ]
// id:官方图 = fullName(de_mirage);社区图 = workshopId(数字串)
export function listMaps() {
  return getDb()
    .prepare('SELECT full_name, display_name, kind, workshop_id, internal_name, match_types, local_map FROM maps ORDER BY rowid')
    .all()
    .map((r) => {
      let matchTypes = []
      try {
        matchTypes = JSON.parse(r.match_types || '[]')
      } catch {}
      const isWorkshop = r.kind === 'workshop'
      const wid = isWorkshop ? String(r.workshop_id) : null
      return {
        id: isWorkshop ? String(r.workshop_id) : r.full_name,
        fullName: r.full_name,
        displayName: r.display_name,
        kind: r.kind,
        workshopId: wid,
        internalName: r.internal_name ?? null,
        matchTypes,
        // 本地自维护社区图:开赛跳过 host_workshop_map,以实例本地 maps/<internalName>.vpk 加载
        localMap: isWorkshop ? !!r.local_map : false,
        // 缩略图(仅社区图;官方图为前端静态资源 public/maps/<官方名>.webp,不经后端):
        // hasThumbnail=后端是否已上传;thumbnailUrl=稳定访问路径(公开 GET)
        hasThumbnail: isWorkshop ? hasThumbnail(wid) : false,
        thumbnailUrl: isWorkshop ? `/api/settings/community-maps/${wid}/thumbnail` : null,
      }
    })
}

// 按官方名称查(仅官方图)
export function getMap(fullName) {
  return listMaps().find((m) => m.fullName === fullName) ?? null
}

// 按地图 id 查(官方名或社区 workshop id)
export function getMapById(id) {
  const s = String(id ?? '')
  if (/^\d{6,20}$/.test(s)) return listMaps().find((m) => m.kind === 'workshop' && String(m.workshopId) === s) ?? null
  return listMaps().find((m) => m.fullName === s) ?? null
}

// 社区图查询(按 workshop id)
export function getCommunityMapByWorkshopId(wid) {
  const m = listMaps().find((x) => x.kind === 'workshop' && String(x.workshopId) === String(wid))
  return m ?? null
}

// 社区地图池(kind=workshop)
export function listCommunityMaps() {
  return listMaps().filter((m) => m.kind === 'workshop')
}

// 地图是否合法:目录内(官方名/workshop id),或为旧迁移别名
export function isKnownMap(id) {
  if (getMapById(id)) return true
  return !!MAP_NAME_MAP[id]
}

// id → MatchZy 完整地图名:官方名原样;社区图 → internal_name(换图依赖);旧短 id 经别名转换
// de_/cs_ 开头的名字本就是合法图名(不查库,供纯函数单元测试);仅数字 workshop id 需要查库
export function mapIdToName(id) {
  if (typeof id !== 'string') return id
  if (MAP_NAME_MAP[id]) return MAP_NAME_MAP[id]
  if (/^(de|cs)_/.test(id)) return id
  const m = getMapById(id)
  if (m) return m.kind === 'workshop' ? m.internalName || String(m.workshopId) : m.fullName
  return id
}

export function mapNameToId(name) {
  for (const [id, full] of Object.entries(MAP_NAME_MAP)) {
    if (full === name) return id
  }
  if (typeof name === 'string' && name.startsWith('de_')) return name.slice(3)
  return name
}

export function sanitizeTeamName(name) {
  return String(name || '')
    .replace(/["\n\r%]/g, '')
    .slice(0, 32)
}

export function buildMatchJson({
  matchId,
  room,
  maplist,
  playersPerTeam,
  minPlayersToReady,
  publicBaseUrl,
  token,
}) {
  // 队名取房间字段(sanitize + trim,空值回退默认 TEAM A / TEAM B)
  const a = sanitizeTeamName(room.teamAName ?? 'TEAM A').trim()
  const b = sanitizeTeamName(room.teamBName ?? 'TEAM B').trim()
  const teamNames = [a || 'TEAM A', b || 'TEAM B']
  const team1 = { id: 'team_a', name: teamNames[0], players: {} }
  const team2 = { id: 'team_b', name: teamNames[1], players: {} }
  const specs = {}

  // 玩家名:房间级「对局内显示名」(比赛用 id)优先,缺省用账号昵称。
  // MatchZy 会把这里的三处名字写成强制名文件并执行 sv_load_forced_client_names_file → 引擎按此显示。
  const displayNames = room.displayNames || {}
  const nameOf = (slot) => displayNames[String(slot.player.steamId)] || slot.player.name

  for (const slot of room.slots || []) {
    if (slot.isBot) continue // 增强人机:bot 不进 MatchZy 名单(名单校验/ready 全部只看真人;bot 由控制台 bot_add 下发)
    const key = String(slot.player.steamId)
    if (slot.team === 'ct') team1.players[key] = nameOf(slot)
    else if (slot.team === 't') team2.players[key] = nameOf(slot)
    else specs[key] = nameOf(slot)
  }

  const k = maplist.length
  // 房间级 cvar 覆盖:MatchZy 逐条以控制台命令下发(见 friendlyfire.js 头注释)
  const cvars = {
    matchzy_remote_log_url: `${publicBaseUrl}/api/events`,
    matchzy_remote_log_header_key: 'X-Arena-Token',
    matchzy_remote_log_header_value: token,
    // demo 上传:每张图结束服务器 POST .dem 到后端(与事件同 token 鉴权)
    matchzy_demo_upload_url: `${publicBaseUrl}/api/demos`,
    matchzy_demo_upload_header_key: 'X-Arena-Token',
    matchzy_demo_upload_header_value: token,
    // 友军伤害关闭(friendlyFire=false)才下发;开启(默认)不覆盖引擎取值
    ...friendlyFireCvars(room.friendlyFire !== false),
    // 普通竞技必须显式覆盖引擎默认值；单挑参数随后覆盖并保持无加时。
    mp_maxrounds: '24',
    mp_halftime: '1',
    mp_match_can_clinch: '1',
    mp_overtime_enable: room.bestOf === 3 || room.overtimeEnabled !== false ? '1' : '0',
    mp_overtime_maxrounds: '6',
    mp_overtime_startmoney: '16000',
    // 单挑对决(1v1)开局 cfg(局数/无加时/冻结/回合时间/半场交换);custom 房间返回空对象
    ...duelMatchCvars(room),
  }
  // map_sides:
  //  - BP 模式(veto):按选边结果生成 —— BO1 = TeamB 选(team2_ct/team2_t);BO3 = 图1 TeamB 选 + 图2 TeamA 选 + 图3 刀局(knife)
  //  - 直接选图模式(direct):knifeRound 开关 —— true=每图刀局 / false=固定 team1 先 CT
  let mapSides
  if (room.pickMode === 'veto') {
    const sc = room.sideChoices || {}
    mapSides = maplist.map((_, i) => {
      if (room.bestOf === 3 && i === k - 1) return 'knife' // BO3 图三刀局
      return sc[i] || (i === 0 ? 'team2_ct' : 'team1_ct') // 兜底(开赛已强制选边完成)
    })
  } else {
    const knife = room.knifeRound !== false
    mapSides = Array(k).fill(knife ? 'knife' : 'team1_ct')
  }

  // 开局公告(开赛瞬间的全体聊天消息):map_sides 定稿后生成,拼刀状态取实际刀局结果
  Object.assign(
    cvars,
    matchStartAnnouncementCvars({
      // 本场(系列)是否含刀局:veto BO3 图三刀局、direct/community 由 knifeRound 开关决定
      knifeRound: mapSides.includes('knife'),
      friendlyFire: room.friendlyFire !== false,
    }),
  )

  return {
    matchid: Number(matchId),
    maplist: maplist.map(mapIdToName), // 短 id → 完整地图名(MatchZy 换图依赖)
    num_maps: k,
    players_per_team: playersPerTeam,
    min_players_to_ready: minPlayersToReady ?? playersPerTeam * 2,
    min_spectators_to_ready: 0,
    team1,
    team2,
    spectators: { players: specs },
    skip_veto: true,
    map_sides: mapSides,
    clinch_series: true,
    wingman: false,
    record_demo: (room.recordDemo != null ? room.recordDemo : room.record_demo) !== false,
    cvars,
  }
}

// 从房间摘出最终比赛地图(直接选图或 BP 完成后的 picked)
export function finalMaplist(room) {
  const picked = room.picked || []
  if (picked.length === 0) return []
  const pool = room.mapPool || []
  const valid = picked.filter((id) => pool.includes(id))
  return valid.length === picked.length ? picked : valid
}
