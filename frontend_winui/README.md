# WinUI 前端 · v1.0

React、TypeScript 与 Vite 网页前端，使用 WinUI 风格的界面，提供大厅、房间、比赛、战绩和管理页面。使用 Node.js 22.13 或更新版本。

## 启动与构建

```bash
npm ci
npm run dev
```

默认地址为 `http://localhost:5175`，API 和 Socket.IO 请求代理到 `http://localhost:8080`。

```bash
npm run build
```

构建产物位于 `dist/`。`VITE_API_BASE` 留空表示使用同源 API；生产静态服务器需将 `/api/` 和 `/socket.io/` 代理到后端，支持 WebSocket，并对网页路由配置 SPA 回退。

平台启动与配置见[根 README](../README.md)。
