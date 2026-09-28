// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 增强人机模式:人机名字库与职业队目录 + 名字消毒
// 名字经 cfg(bot_add_t "<name>")下发,必须杜绝引号/分号等注入字符
// 注意:名字需存在于 mod(CS2-Bot-Improver)的 overrides/botprofile.vpk 名字库,
// 否则开赛时控制台报 no profile、该人机缺席(带 * 号的为文档实测验证过的名字)
export const BOT_NAME_POOL = [
  'NiKo', // * Falcons 实测
  'm0NESY', // *
  'TeSeS', // *
  'karrigan', // *
  'kyousuke', // *
  'donk', // * 文档实测
  'ZywOo',
  's1mple',
  'device',
  'sh1ro',
  'ropz',
  'broky',
  'rain',
  'b1t',
  'jL',
  'w0nderful',
  'aleksib',
  'chopper',
  'zont1x',
  'magixx',
  'apEX',
  'flameZ',
  'mezii',
  'kscerato',
  'yuurih',
  'sunpayus',
  'Snappi',
  'Torzsi',
  'Spinx',
  'Jimpphat',
]

// 职业队(整队添加,仅 TeamB):roster 5 人 + 队标(mp_teamlogo_2)
// falcons 为 增强人机设置 文档验证组合;其余为常见强队,需实机验证后增删
export const PRO_TEAMS = [
  {
    id: 'falcons',
    name: 'Falcons',
    logo: 'fal',
    roster: ['NiKo', 'TeSeS', 'm0NESY', 'karrigan', 'kyousuke'], // * 文档验证
  },
  { id: 'spirit', name: 'Spirit', logo: 'spirit', roster: ['donk', 'zont1x', 'magixx', 'chopper', 'sh1ro'] },
  { id: 'navi', name: 'NAVI', logo: 'navi', roster: ['w0nderful', 'b1t', 'jL', 'aleksib', 'iM'] },
  { id: 'vitality', name: 'Vitality', logo: 'vita', roster: ['ZywOo', 'apEX', 'flameZ', 'mezii', 'ropz'] },
]

// bot_aim / bot_nades 合法取值(mod 控制台命令参数)
export const BOT_AIM_MODES = ['mixed', 'head', 'body']
export const BOT_NADE_MODES = ['off', 'less', 'normal', 'more', 'max']

export function getProTeam(id) {
  return PRO_TEAMS.find((t) => t.id === id) ?? null
}

// 人机名消毒:仅字母/数字/空格/下划线/点/横线,≤24 字符(控制台安全)
export function sanitizeBotName(name) {
  const s = String(name ?? '').trim()
  if (!s || s.length > 24 || !/^[A-Za-z0-9 _.\-]+$/.test(s)) return null
  return s
}

// ---- 人机槽位(rooms.slots 内的伪玩家,PlayerSlot.isBot=true) ----

export function makeBotSlot(name, team, slotNum, seq) {
  return {
    player: { id: `bot-${seq}`, steamId: `bot-${seq}`, name, avatarUrl: '' },
    team,
    slot: slotNum,
    isBot: true,
  }
}

export function nextBotSeq(slots) {
  let max = 0
  for (const s of slots) {
    const m = /^bot-(\d+)$/.exec(s.player.steamId)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

export function usedBotNames(slots) {
  return new Set(slots.filter((s) => s.isBot).map((s) => s.player.name))
}

// 增强人机:生成"就位 cfg"文本(固化方案,替代开赛控制台下发)
// 由后端开赛时经桥写入实例 cfg/arena_bots.cfg,挂在 match3 的 MatchZy warmup.cfg /
// live_override.cfg 末尾 exec —— 全程不经控制台通道,根除 tmux 注入拼接竞态;
// 指令全部幂等(bot 已存在仅报无害的 already in game),cfg 链每次 warmup/live 重放自带自愈
// 普通比赛写入空文件,中和同实例(如 match3)上一场人机房的残留
export function buildBotCfg(slots, roomRow) {
  const lines = [
    '// arena 增强人机就位指令(每场比赛由后端自动覆写)',
    'bot_quota 0',
    'mp_autoteambalance false',
    'mp_limitteams 0',
    // 人机烟雾索敌模式降耗(mod 指令,实测回显 smoke mode set to 1)
    'bv_smoke_mode 1',
  ]
  for (const b of (slots || []).filter((s) => s.isBot)) {
    lines.push(`${b.team === 'ct' ? 'bot_add_ct' : 'bot_add_t'} "${b.player.name}"`)
  }
  lines.push(`bot_aim ${roomRow.bot_aim || 'mixed'}`)
  lines.push(`bot_nades ${roomRow.bot_nades || 'normal'}`)
  if (roomRow.bot_proteam) {
    const pt = getProTeam(roomRow.bot_proteam)
    if (pt) lines.push(`mp_teamlogo_2 ${pt.logo}`)
  }
  return lines.join('\n') + '\n'
}
