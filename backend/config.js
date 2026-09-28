// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 全局配置。敏感项可用环境变量覆盖。
export default {
  // Web 后端监听端口
  port: Number(process.env.PORT || 8080),

  // 游戏服务器可访问到的本后端地址(用于 matchzy_loadmatch_url / remote_log_url)
  // 必须是游戏服可达的 http(s) URL,不含空格
  // 部署时通过 PUBLIC_BASE_URL 设置游戏主机可访问的平台地址
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:8080',
  // 桥离线多久开始告警;0 = 关闭该告警。smoke 用小值做确定性断言
  bridgeOfflineAlertMs: Number(process.env.BRIDGE_OFFLINE_ALERT_MS ?? 120000),

  // 桥接 agent 相关(全局:开发/运行环境属性)
  // mode: 'stub' = 本地模拟 msm(开发/验证);'reverse' = 主机上的 agent 主动连后端
  //       (WebSocket /api/agent),游戏服仅暴露游戏端口 —— 生产唯一形态。
  //       历史 http 模式(后端主动连桥)已移除;其余取值由 server.js 启动校验直接报错。
  // 注:具体 agent 归属按实例所属 game_servers 记录解析(DB 为准,本项不含)
  bridge: {
    mode: process.env.BRIDGE_MODE || 'stub',
    timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS || 20000),
    // send 前缀白名单(reverse 下**唯一**执行点:主机桥只校验单行/长度与实例白名单)
    sendPrefixes: [
      'matchzy_loadmatch',
      'matchzy_loadmatch_url',
      'get5_loadmatch_url',
      'arena_match_load',
      'matchzy_remote_log_url',
      'matchzy_remote_log_header_key',
      'matchzy_remote_log_header_value',
      'matchzy_endmatch',
      'get5_endmatch',
      'css_endmatch',
      'changelevel',
      'css_restart',
      'host_workshop_map',
      // 增强人机模式:开赛后经控制台下发(loadmatch/换图 bot_kick 之后重建命名人机)
      'bot_kick',
      'bot_add_ct',
      'bot_add_t',
      'bot_quota',
      'bot_aim',
      'bot_nades',
      'mp_teamlogo_1',
      'mp_teamlogo_2',
      'mp_autoteambalance',
      'mp_limitteams',
    ],
  },

  // ArenaMatch 独立开赛链路配置:
  // 仅当桥具有 arena_match_ipc 能力,且 enabled=true 或实例名在 instances 白名单时启用;
  // 默认根据 ENABLE_ARENA_MATCH / ARENA_MATCH_INSTANCES 决定,未配置时回退 MatchZy 确保稳定。
  arenaMatch: {
    enabled: process.env.ENABLE_ARENA_MATCH === '1',
    instances: (process.env.ARENA_MATCH_INSTANCES || '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // 增强人机模式专用实例:仅在配置了 BOT_INSTANCE_NAME 的实例启用
  botInstanceName: process.env.BOT_INSTANCE_NAME || '',

  // 实例最大玩家数默认值(-maxplayers;运行时可在管理面板调整,存 settings 表 default_max_players)
  // 语义 = 引擎启动项数值,SourceTV 另占 1 席 → 房间可用玩家席 = 该值 - 1
  defaultMaxPlayers: Number(process.env.DEFAULT_MAX_PLAYERS || 12),

  // 社区(workshop)图预加载缓冲:开赛时 send host_workshop_map 后等待毫秒数
  // (需主机已下载该图;首次下载慢时可调大,smoke 设 0)
  workshopPreloadDelayMs: Number(process.env.WORKSHOP_PRELOAD_DELAY_MS || 0),

  // 社区(workshop)图下载(仅管理员):向一个空闲运行中实例(默认 main —— 主机共享目录持有者,
  // 见主机 use.md §8:match1/2/3 的 steamapps 目录 symlink 到 inst-main,一份文件全实例共用)下发
  // host_workshop_map,由游戏进程自行从 Steam 创意工坊下载;
  // 完成判定 = 两阶段:① 共享目录中该 <id> 项字节数连续 stablePolls 个轮询周期不再增长;
  // ② 控制台出现该图 addon 加载签名(host_workshop_map 下载完成后会自动换图,日志含
  // `Mounting addon '<id>'` / `SV: addon='<id>'`)—— 防网络中断导致的"字节数假稳定"
  workshop: {
    downloadInstance: process.env.WORKSHOP_DOWNLOAD_INSTANCE || 'main',
    pollMs: Number(process.env.WORKSHOP_DOWNLOAD_POLL_MS || 5000),
    stablePolls: Number(process.env.WORKSHOP_DOWNLOAD_STABLE_POLLS || 6),
    timeoutMs: Number(process.env.WORKSHOP_DOWNLOAD_TIMEOUT_MS || 45 * 60 * 1000),
    // ② 阶段窗口:字节数稳定后等待加载签名的最长毫秒数;0 = 跳过加载确认(仅大小稳定即 done)
    loadConfirmMs: Number(process.env.WORKSHOP_LOAD_CONFIRM_MS || 5 * 60 * 1000),
    // 共享目录中该项字节数达到该值才视为「已存在」(防下载刚起步/空目录误判)
    minPresentBytes: Number(process.env.WORKSHOP_MIN_PRESENT_BYTES || 1024 * 1024),
  },

  // 社区地图缩略图存储(仅管理员上传;按 <workshopId>.<png|jpg|jpeg|webp> 存储,公开只读,
  // 与总竞技图池官方图的前端静态缩略图 public/maps/<官方名>.webp 同一展示口径)
  mapImage: {
    dir: process.env.MAP_IMAGE_DIR || new URL('./data/map-images/', import.meta.url).pathname,
    maxBytes: Number(process.env.MAP_IMAGE_MAX_BYTES || 5 * 1024 * 1024),
  },

  // 人数不等房间(teamA ≠ teamB)的 ready 阈值口径:
  //   'strict'(默认)= players_per_team 取**较大队名额** → 任一队少人在场/有人未 ready 都不开赛;
  //                    较小队因达不到该值,需其全员 ready 后由任一队员输入 .forceready 才能开赛
  //   'lenient'      = 取**较小队名额**(旧行为:人数多的一队少 1 人也会开赛;不会卡 ready)
  asymmetricReady: process.env.ASYMMETRIC_READY === 'lenient' ? 'lenient' : 'strict',

  msm: {
    stubPath: new URL('./scripts/msm-stub.sh', import.meta.url).pathname,
  },

  // 游戏服务器 —— 仅作为**首次运行种子**写入 game_servers 表;
  // 运行时(桥地址/主机信息/实例表)以 DB 为准,便于后续远程新增/编辑
  // 字段与 game_servers 表列同名(snake_case)
  gameServers: [
    {
      id: process.env.GAME_SERVER_ID || 'g1',
      name: process.env.GAME_SERVER_NAME || '示例服务器组',
      host_ip: process.env.GAME_HOST_IP || '192.0.2.211',
      region: process.env.GAME_HOST_REGION || 'example-region',
      bridge_url: process.env.BRIDGE_URL || 'http://192.0.2.212:3001',
      bridge_token: process.env.BRIDGE_TOKEN || 'replace-this-before-use',
      // 面板展示用的历史标签(http 传输已移除,该字段不参与任何传输决策;
      // 面板添加/编辑仍强制写 http,见 routes/gameServers.js)
      bridge_mode: 'http',
      instances: [
        { name: 'main', port: 27015 },
        { name: 'match1', port: 27016 },
        { name: 'match2', port: 27017 },
        { name: 'match3', port: 27018 },
      ],
    },
  ],

  // 实例启动后轮询 RUNNING 的超时与间隔
  bootTimeoutMs: 180000,
  bootPollMs: 2000,
  // RUNNING 后等待插件(CounterStrikeSharp/MatchZy)加载完的缓冲(ms)
  // CS2 进程存活 ≠ 插件已就绪,过早 send 会被丢弃
  pluginReadyDelayMs: Number(process.env.PLUGIN_READY_DELAY_MS || 15000),
  // 分配实例时若已在运行,是否先重启以清空 MatchZy setup 状态
  restartIfRunning: true,

  // 从房间状态生成比赛配置的默认值
  // 地图目录(总竞技图池 = maps 表全部):官方名称 + 中文显示名;新增官方图经 /api/settings/maps 录入
  mapDefs: [
    { fullName: 'de_mirage', displayName: '荒漠迷城' },
    { fullName: 'de_inferno', displayName: '炼狱小镇' },
    { fullName: 'de_nuke', displayName: '核子危机' },
    { fullName: 'de_dust2', displayName: '炙热沙城Ⅱ' },
    { fullName: 'de_ancient', displayName: '远古遗迹' },
    { fullName: 'de_anubis', displayName: '阿努比斯' },
    { fullName: 'de_vertigo', displayName: '殒命大厦' },
    { fullName: 'de_train', displayName: '火车站' },
    { fullName: 'de_cache', displayName: '死亡游乐园' },
    { fullName: 'de_overpass', displayName: '死城之谜' },
  ],
  // 服役地图池默认(恒 7 张,BP 专用;须为总池子集,管理员可改)
  defaultActiveMapPool: ['de_mirage', 'de_inferno', 'de_nuke', 'de_dust2', 'de_ancient', 'de_anubis', 'de_vertigo'],
  defaultTeamNames: ['TEAM A', 'TEAM B'],

  // demo 上传与实例冷却
  demo: {
    storageDir: process.env.DEMO_STORAGE_DIR || new URL('./demos', import.meta.url).pathname,
    maxUploadBytes: Number(process.env.DEMO_MAX_UPLOAD_BYTES || 200 * 1024 * 1024), // 200MB
    retentionDays: Number(process.env.DEMO_RETENTION_DAYS || 15), // 默认存 15 天
    cleanupIntervalMs: Number(process.env.DEMO_CLEANUP_INTERVAL_MS || 6 * 3600 * 1000), // 每 6h 清理
    // 实例冷却解除兜底:正常由"该比赛 demo 全部到齐"触发立即解除;
    // 上传失败(无重试)时靠此超时兜底(series_end 后 / 强制结束后)
    coolingTimeoutMs: Number(process.env.DEMO_COOLING_TIMEOUT_MS || 300000), // 5min
    forceEndCoolingTimeoutMs: Number(process.env.FORCE_END_COOLING_TIMEOUT_MS || 60000), // 1min
    coolingSweepMs: Number(process.env.DEMO_COOLING_SWEEP_MS || 30000), // 冷却状态扫描间隔
  },

  // BP 每轮操作超时(毫秒),超时后后端自动随机 ban/pick(e2e 测试可调短)
  vetoTurnTimeoutMs: Number(process.env.VETO_TURN_TIMEOUT_MS || 15000),

  // 断线自动退房宽限(毫秒):玩家 socket 断开(关网页/断网)后在此时间内未重连则自动退出所在房间
  roomDisconnectGraceMs: Number(process.env.ROOM_DISCONNECT_GRACE_MS || 30000),

  // 管理员(可多个,逗号分隔覆盖);运行时判定,无需改表
  adminSteamIds: (process.env.ADMIN_STEAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // 管理员密码最小长度
  adminPasswordMinLength: Number(process.env.ADMIN_PASSWORD_MIN_LENGTH || 6),

  // 实例控制台(管理面板)
  consolePollMs: Number(process.env.CONSOLE_POLL_MS || 1000), // 后端轮询实例日志间隔
  consoleCommandMaxLen: Number(process.env.CONSOLE_COMMAND_MAX_LEN || 2000),

  // 前端 dev server 来源(CORS / Socket.io)
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:5175'],

  // 后端访问 Steam 时用的代理(OpenID 校验/资料获取),可为 null
  steam: {
    proxy: process.env.STEAM_PROXY || ''
  },
}
