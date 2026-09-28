// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 房间「友军伤害」开关 → CS2 控制台指令
//
// 语义(CS2 libserver.so 内 cvar 帮助文本实测):
//   ff_damage_reduction_bullets 取值 0~1,1 = 与打敌人同等伤害,0 = 队友伤害为 0;
//   competitive / MatchZy live.cfg 默认 0.33(队友仅受 33% 子弹伤害)。
//   故「关闭友军伤害」= 保持 mp_friendlyfire 1(不改引擎友军交互分支)+ 子弹友伤系数归零。
//
// 下发通道:MatchZy 比赛 JSON 的 cvars 段 —— 插件在 exec live.cfg **之后**(1s 计时器,等 cfg 执行完)
// 由 ExecuteChangedConvars 逐条以控制台命令写入服务器(MatchZy 源码 SetupLiveFlagsAndCfg);
// 且 warmup 前(LoadMatchFromJSON)也会执行一次,热身阶段即生效。
// 关键:不能由后端开赛时自行 send —— live.cfg / gamemode_competitive.cfg 会在 live 阶段把
// ff_damage_reduction_bullets 重置为 0.33,早于 live 的下发必被覆盖;而 tmux 逐条注入存在
// 文本拼接/重复执行风险,批量/关键指令一律文件化或经插件下发。
//
// 房间开启(默认)时不写任何 cvar:沿用引擎/competitive 默认,MatchZy 亦会在 series end 还原(cvar 自愈)。
export const FRIENDLY_FIRE_OFF_CVARS = {
  mp_friendlyfire: '1',
  ff_damage_reduction_bullets: '0',
}

// enabled=true(开启友军伤害)→ 无需覆盖 cvar;false → 返回关闭用的控制台指令
export function friendlyFireCvars(enabled) {
  return enabled === false ? { ...FRIENDLY_FIRE_OFF_CVARS } : {}
}
