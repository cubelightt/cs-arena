# CS Arena 后端 · v1.0

Express、Socket.IO 与 Node 内置 SQLite 后端，提供认证、房间、比赛、Demo、服务器管理和桥连接功能。运行要求 Node.js 22.13 或更新版本。

## 启动

```bash
npm ci
cp ../.env.example .env
node --env-file=.env server.js
```

配置通过环境变量读取。`npm start` 启动时需预先导出环境变量，或由服务管理器加载配置文件。

正式部署使用 `BRIDGE_MODE=reverse`，并配置 `PUBLIC_BASE_URL`、`ADMIN_STEAM_IDS`、桥令牌和 `CORS_ORIGINS`。启用 ArenaMatch 时设置 `ENABLE_ARENA_MATCH=1`，或用 `ARENA_MATCH_INSTANCES` 指定实例。

数据库默认位于 `data/arena.db`，Demo 默认保存在 `demos/`，地图缩略图默认保存在 `data/map-images/`；可通过 `DB_PATH`、`DEMO_STORAGE_DIR`、`MAP_IMAGE_DIR` 更改位置。请为运行用户提供写入权限并持久保存这些目录。

完整平台配置见[根 README](../README.md)，服务部署见[部署说明](../deploy/README.md)。
