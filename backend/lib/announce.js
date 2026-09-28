// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 开局公告:开赛瞬间发给全体玩家的聊天消息(MatchZy match_start_message)
//
// 触发时机 = MatchZy HandleMatchStart():所有人 .ready 达成、或管理员 .start / css_start 之后,
// 由插件逐行 PrintToAllChat(带 matchzy_chat_prefix 前缀)。后端不做任何控制台下发。
//
// 下发通道 = 比赛 JSON cvars(与房间级 cvar 覆盖同一通道):插件在 loadmatch(热身)与
// exec live.cfg 之后应用这些 cvar。**文本必须走这条通道**:实测 msm/tmux send 会丢中文
// (非 ASCII 字符全部丢失),而 JSON → 插件 → Server.ExecuteCommand 原样保留中文/$$$/{Color}(2026-09-18 实机验证)。
//
// 文本能力(MatchZy 源码 + 实机核对):
//   - `$$$` 分行:每段一条独立聊天消息(matchzy_match_start_message 以 $$$ 分割后逐条打印)
//   - `{Green}` / `{Red}` / `{Default}` 等颜色占位符:插件侧 GetColorTreatedString 转聊天颜色码
//     (可用名字见 CSSharp ChatColors 字段;Unknown 名字会原样输出,故只用下列已验证的几个)
//   - `{MAP}` `{MAPNUMBER}` `{MATCH_ID}` `{TEAM1}` `{TEAM2}` `{TEAM1_SCORE}` `{TEAM2_SCORE}` `{TIME}`
//     由 MatchZy FormatCvarValue 替换(扩展公告时可直接引用当前比赛信息)
//
// 新增公告:在 MATCH_START_ANNOUNCERS 追加一条 build(ctx) 即可(ctx = { knifeRound, friendlyFire }),
// 返回 null / 空串表示该条不输出。不要在别处拼文本、写颜色码或直接改 cvars 键名。

export const COLOR = { green: '{Green}', red: '{Red}', reset: '{Default}' }

// 多行分隔符(MatchZy 约定)
export const LINE_SEP = '$$$'

// 引擎控制台命令行上限约 512 字节(插件以控制台命令下发本 cvar),留足余量:
// 整行放不下就丢弃该行并告警(不截断,避免出现半句话)
export const MAX_MESSAGE_BYTES = 400

// 注:聊天署名前缀(MatchZy matchzy_chat_prefix)此处**不改**——经 cvars 通道下发时值会被
// MatchZy 加引号(ExecuteChangedConvars 固定 `key "value"`),而前缀命令处理器不剥引号,
// 聊天里会显示成 `"[CS Arena]"`;保持插件默认 `[MatchZy]` 最干净。若要换署名,改主机
// cfg/MatchZy/config.cfg 的 matchzy_chat_prefix(不带引号)或接受引号。

// 已开启(绿)/ 已关闭(红)
function onOff(on) {
  return on ? `${COLOR.green}已开启${COLOR.reset}` : `${COLOR.red}已关闭${COLOR.reset}`
}

// 开局公告清单(ctx: { knifeRound: 本场是否刀局, friendlyFire: 友军伤害是否开启 })
export const MATCH_START_ANNOUNCERS = [
  // 房间设置回顾(现状:拼刀选边 + 友军伤害)
  (ctx) => `当前比赛 拼刀选边 ${onOff(ctx.knifeRound)}，友军伤害 ${onOff(ctx.friendlyFire)}`,
  // 关闭友军伤害时的补充提醒:只关了子弹伤害,投掷物仍生效
  (ctx) => (ctx.friendlyFire ? null : `注意！当前比赛已关闭友军伤害，但是${COLOR.red}手雷、燃烧弹${COLOR.reset}等投掷物仍会造成伤害！`),
]

// 生成开局公告文本行(空数组 = 无公告)
export function buildMatchStartMessages(ctx = {}) {
  const lines = []
  for (const build of MATCH_START_ANNOUNCERS) {
    try {
      const line = build(ctx)
      if (line) lines.push(String(line).trim())
    } catch (err) {
      // 单条公告出错不影响其它消息与开赛流程
      console.warn('[announce] 生成开局公告失败:', err.message)
    }
  }
  return lines
}

// 比赛 JSON cvars 覆盖(无公告 → 返回空对象,不写任何键)
export function matchStartAnnouncementCvars(ctx = {}) {
  const kept = []
  for (const line of buildMatchStartMessages(ctx)) {
    const bytes = Buffer.byteLength([...kept, line].join(LINE_SEP), 'utf8')
    if (bytes > MAX_MESSAGE_BYTES) {
      console.warn(`[announce] 公告超长(${bytes} > ${MAX_MESSAGE_BYTES} 字节),已丢弃:${line.slice(0, 40)}…`)
      continue
    }
    kept.push(line)
  }
  if (kept.length === 0) return {}
  return { matchzy_match_start_message: kept.join(LINE_SEP) }
}
