// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 单挑对决(1v1)开局 cfg:玩法类型 / 回合局数 / 无加时 / 冻结与回合时间 / 阵营平衡交换 / 禁购买
//
// 需求(2026-09-19):单挑对决为「N 局先到 (N+1)/2 胜」固定局数制,回合节奏与平衡规则与 5v5 竞技不同:
//   - 玩法类型 duelPreset(仅 duel 房间):rifle=长枪决斗(默认)/ pistol=手枪决斗 / sniper=狙击决斗 /
//     solo=Solo三项(51 回合 = 10 手枪 + 28 长枪 + 13 狙击,按固定回合边界切换武器类别)
//   - mp_maxrounds = 局数(房主可改,必须**奇数**:偶数打满可能平分,无法分辨胜负;
//     mp_match_can_clinch=1 由 live.cfg 提供,先到 (N+1)/2 胜即完赛)。
//     长枪/手枪/狙击默认 31;Solo三项固定 51(阶段 10/28/13 仅对 51 成立,/config 禁改)
//   - mp_overtime_enable 0:单挑没有加时(奇数局数下不可能平局,双保险)
//   - mp_freezetime 1 / mp_roundtime 1.5:快节奏(每回合冻结 1 秒、1 分半);
//     defuse/hostage 变体一并覆盖(duel 房在官方 de_ 图上回合时长由 defuse 变体决定)
//   - mp_buytime 0:禁购买(购买菜单 UI 仍可客户端打开但无法购买;选枪走插件 .guns 指令)
//   - mp_give_player_c4 0:不下发 C4(1v1 决斗无炸弹攻防;选枪/装备全归插件)
//   - 阵营平衡:aim 类单挑图 CT/T 出生点固定 —— 自 ArenaDuel 0.4.0 起采用「固定双方队伍身份 + 奇数回合轮换出生点」架构
//     执行(门控 arena_duel_roundswap 1;mp_halftime 0 关闭引擎半场;双方队伍/map_sides 恒定,记分牌/横幅/胜负归属天然正确;
//     旧 0.2/0.3 版本的换队记账已退役,机制约定见 ArenaMatch 的 MatchContract.cs)。
//
// arena_* cvars = ArenaDuel 伴随插件的门控/配置通道(ArenaMatch 的 MatchContract.cs;插件未安装时引擎仅
// 打 "Unknown command" 控制台噪声,无副作用):
//   - arena_duel_roundswap:出生点轮换平衡门控(1=开;插件每回合读值,关=全部 no-op)
//   - arena_duel_preset:玩法类型(插件据此决定选枪菜单与默认武器)
//   - arena_duel_phase_pistol/rifle/sniper:仅 solo —— 各武器类别的回合数(插件按累计回合数切阶段)
//
// 下发通道 = MatchZy 比赛 JSON cvars(与 lib/friendlyfire.js 同款):插件在 exec live.cfg
// **之后**由 ExecuteChangedConvars 逐条执行,loadmatch(热身)时也执行一次。必须覆盖
// live.cfg 的竞技默认值(mp_maxrounds 24 / mp_overtime_enable 1 / mp_freezetime 18 /
// mp_roundtime 1.92 / mp_buytime 20)—— 自行 send 必被覆盖;MatchZy 在 series end 还原 cvar
// (matchzy_reset_cvars_on_series_end 默认开),同实例连续开房不残留。
//
// 仅作用于 matchType=duel 的房间(两种地图池都生效:官方总池 / 单挑图池);
// custom(5v5)房间沿用 live.cfg 竞技默认,不受影响。

export const DEFAULT_DUEL_MAX_ROUNDS = 31
export const DUEL_MIN_ROUNDS = 1
export const DUEL_MAX_ROUNDS = 101

// 玩法类型:Solo三项的阶段回合数(手枪→长枪→狙击)仅对总回合 51 成立,故 solo 锁定 51
export const DUEL_PRESETS = {
  rifle: { name: '长枪决斗', defaultMaxRounds: 31 },
  pistol: { name: '手枪决斗', defaultMaxRounds: 31 },
  sniper: { name: '狙击决斗', defaultMaxRounds: 31 },
  solo: { name: 'Solo三项', defaultMaxRounds: 51, phases: { pistol: 10, rifle: 28, sniper: 13 } },
}
export const DEFAULT_DUEL_PRESET = 'rifle'

// 归一化玩法类型(非法 → null);custom 房间不适用
export function normalizeDuelPreset(raw) {
  return typeof raw === 'string' && DUEL_PRESETS[raw] ? raw : null
}

// 生效回合数:solo 恒 51;其余 = 房间覆盖(rooms.max_rounds)?? 31
export function resolveDuelMaxRounds(preset, rawMaxRounds) {
  if (normalizeDuelPreset(preset) === 'solo') return DUEL_PRESETS.solo.defaultMaxRounds
  return rawMaxRounds ?? DEFAULT_DUEL_MAX_ROUNDS
}

// 房间生效局数(room = 序列化后 JSON 或 instances.js roomForJson:duelPreset 原样、maxRounds 原样)
export function effectiveDuelMaxRounds(room) {
  return resolveDuelMaxRounds(room?.duelPreset, room?.maxRounds)
}

// 单挑对决比赛 JSON cvars(非 duel 房间返回空对象,不写任何键)
export function duelMatchCvars(room) {
  if (room?.matchType !== 'duel') return {}
  const preset = normalizeDuelPreset(room.duelPreset) ?? DEFAULT_DUEL_PRESET
  const spec = DUEL_PRESETS[preset]
  const cvars = {
    mp_maxrounds: String(resolveDuelMaxRounds(preset, room.maxRounds)),
    mp_overtime_enable: '0',
    mp_freezetime: '1',
    mp_roundtime: '1.5',
    mp_roundtime_defuse: '1.5',
    mp_roundtime_hostage: '1.5',
    mp_halftime: '0',
    mp_buytime: '0',
    mp_give_player_c4: '0',
    arena_duel_roundswap: '1',
    arena_duel_preset: preset,
  }
  if (spec.phases) {
    for (const [phase, rounds] of Object.entries(spec.phases)) {
      cvars[`arena_duel_phase_${phase}`] = String(rounds)
    }
  }
  return cvars
}
