# CS Arena 平台 v1.0

CS Arena 是 Counter-Strike 2 比赛管理平台，由 Node.js 后端和 WinUI 风格网页前端组成，支持房间、选图、竞技比赛、单挑、比赛记录、Demo 和游戏实例管理。

游戏主机使用 [CS Arena Agent](https://github.com/cubelightt/cs-arena-agent) 连接平台，比赛由 [ArenaMatch](https://github.com/cubelightt/cs-arena-match) 插件执行。

## 运行要求

- Node.js 22.13 或更新版本、npm。
- 正式比赛需要 Linux 游戏主机、CS2 服务端、CS Arena Agent 和 CounterStrikeSharp / ArenaMatch。

## 启动平台

安装后端依赖，复制配置示例并填写环境变量：

```bash
cd backend
npm ci
cp ../.env.example .env
node --env-file=.env server.js
```

`.env.example` 默认使用本地模拟桥；连接游戏主机时设为 `BRIDGE_MODE=reverse`。`npm start` 也可启动后端，但环境变量需由 shell 或服务管理器提供。

另开终端启动前端：

```bash
cd frontend_winui
npm ci
npm run dev
```

前端默认访问 `http://localhost:5175`，请求代理到 `http://localhost:8080`。

## 构建前端

```bash
cd frontend_winui
npm ci
npm run build
```

输出目录为 `frontend_winui/dist/`。构建时 `VITE_API_BASE` 留空表示使用同源 API；静态服务器需将 `/api/` 和 `/socket.io/` 代理到后端，支持 WebSocket，并对网页路由配置 SPA 回退。

## Docker Compose 部署

使用已发布镜像部署，主机只需 Docker Engine 和 Docker Compose v2，无需安装 Node.js、npm 或在本机编译。当前镜像版本为 `v1.0`，支持 Linux amd64：

- [cubelightt/cs-arena-backend:v1.0](https://hub.docker.com/r/cubelightt/cs-arena-backend)
- [cubelightt/cs-arena-frontend:v1.0](https://hub.docker.com/r/cubelightt/cs-arena-frontend)

### 1. 创建部署目录与 Compose 配置

镜像已包含前后端运行所需程序。部署时直接使用 Docker Hub 镜像，创建以下两个配置文件即可，无需访问 GitHub 私有仓库或克隆源码。

```bash
mkdir -p cs-arena-deploy
cd cs-arena-deploy
```

在此目录创建 `compose.yaml`，填写以下完整内容：

```yaml
name: cs-arena

services:
  cs-arena:
    image: ${BACKEND_IMAGE:-cubelightt/cs-arena-backend}:${ARENA_VERSION:-v1.0}
    env_file: .env
    user: "${PUID:-1000}:${PGID:-1000}"
    environment:
      NODE_ENV: production
      PORT: "8080"
      DB_PATH: /var/lib/arena/arena.db
      DEMO_STORAGE_DIR: /var/lib/arena/demos
      MAP_IMAGE_DIR: /var/lib/arena/map-images
    volumes:
      - type: bind
        source: ${DATA_DIR:-./data}
        target: /var/lib/arena
        bind:
          create_host_path: false
    networks:
      default:
        aliases:
          - backend
    expose:
      - "8080"
    restart: unless-stopped
    init: true
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:8080/api/health', {signal: AbortSignal.timeout(4000)}).then(r => {if (!r.ok) process.exit(1)}).catch(() => process.exit(1))"
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s

  cs-arena-web:
    image: ${FRONTEND_IMAGE:-cubelightt/cs-arena-frontend}:${ARENA_VERSION:-v1.0}
    ports:
      - "${HTTP_BIND:-0.0.0.0}:${HTTP_PORT:-18081}:80"
    depends_on:
      cs-arena:
        condition: service_healthy
        restart: true
    restart: unless-stopped
```

此配置只拉取和运行已发布镜像，不包含源码构建步骤。

### 2. 填写配置

在同一目录创建 `.env`，填写以下内容，并替换示例中的平台地址、管理员 Steam ID、游戏主机地址和桥令牌：

```dotenv
# 前后端镜像与发布版本。镜像名不含版本标签。
BACKEND_IMAGE=cubelightt/cs-arena-backend
FRONTEND_IMAGE=cubelightt/cs-arena-frontend
ARENA_VERSION=v1.0

# 宿主机数据目录：相对路径以 compose.yaml 所在目录为基准，也可填绝对路径。
# 保存 SQLite（含 WAL/SHM）、Demo 和社区地图图片；默认 ./data。
# 首次启动前创建目录，并确保目录属主与下面 PUID/PGID 一致。
DATA_DIR=./data
# 后端运行 UID/GID；默认镜像的 node 用户为 1000:1000。
# 可用 id -u / id -g 查询宿主机用户，并填为目录属主对应的数值。
PUID=1000
PGID=1000

# 网页入口端口；0.0.0.0 允许外部访问，127.0.0.1 仅供宿主机反向代理。
HTTP_BIND=0.0.0.0
HTTP_PORT=18081
# 改为浏览器和游戏主机都能访问的最终平台地址，不加末尾 /。
# 以下 192.0.2.x 是文档示例地址，必须替换；使用 HTTPS 时填最终 HTTPS 地址。
PUBLIC_BASE_URL=http://192.0.2.10:18081
# 最终网页来源；多个来源用逗号分隔，供 Socket.IO 使用。
CORS_ORIGINS=http://192.0.2.10:18081

# 管理员 Steam ID64；多个 ID 用逗号分隔。
ADMIN_STEAM_IDS=YOUR_STEAM_ID64
# 正式比赛使用 reverse，由游戏主机 Agent 主动连接；stub 仅用于本地模拟。
BRIDGE_MODE=reverse

# 以下服务器组信息与令牌仅在首次初始化数据库时写入。
# 已有数据库以管理面板中的服务器组记录为准，修改此处不会覆盖旧记录。
GAME_SERVER_ID=g1
GAME_SERVER_NAME=My-CS2-Host
GAME_HOST_IP=192.0.2.211
GAME_HOST_REGION=local
# 替换为随机令牌，与 Agent 配置一致；可用 openssl rand -hex 32 生成。
BRIDGE_TOKEN=REPLACE_WITH_A_RANDOM_TOKEN

# 主机已安装 ArenaMatch 且 Agent 声明对应能力时启用。
ENABLE_ARENA_MATCH=1
# 只启用特定实例时，可设 ENABLE_ARENA_MATCH=0 并填写逗号分隔的实例名。
ARENA_MATCH_INSTANCES=
# 可选增强人机实例名；相关插件由用户在游戏主机另行安装，不使用则留空。
BOT_INSTANCE_NAME=

# 留空直连 Steam；需代理时填写容器可达的 HTTP 代理地址。
# 容器内 localhost 指向容器自身，不是宿主机。
STEAM_PROXY=
# 影响定时归档等任务使用的本地时间。
TZ=Asia/Shanghai
```

配置项的用途与填写方式已写在 `.env` 注释中。游戏主机另行安装 [CS Arena Agent](https://github.com/cubelightt/cs-arena-agent) 和 [ArenaMatch](https://github.com/cubelightt/cs-arena-match)，Agent 连接平台的 `/api/agent`。

首次启动前，按默认配置创建数据目录并设置属主：

```bash
mkdir -p ./data
sudo chown 1000:1000 ./data
```

如果修改了 `DATA_DIR`、`PUID` 或 `PGID`，请同步替换命令中的目录与 UID/GID。只需创建数据目录，不需要复制程序或源码。已有目录应确认运行用户可写；不要改动已有数据库文件。

已有宿主机反向代理时可设 `HTTP_BIND=127.0.0.1`，将入口代理到 `127.0.0.1:18081`；外层代理需支持 WebSocket 和 Demo 上传。最终使用 HTTPS 时，平台地址也填写 HTTPS。

### 3. 拉取并启动

在 `compose.yaml` 所在目录执行：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

浏览器访问 `http://平台IP:18081`（或配置的最终平台地址）。默认只有前端 Nginx 入口端口对外开放，后端 8080 仅在容器网络内使用。部署前确认 `HTTP_PORT` 未被其他服务占用。

查看日志：

```bash
docker compose logs -f --tail=100
```

### 4. 数据保存、停止与更新

数据直接保存在宿主机 `DATA_DIR` 指定的目录，默认是 `compose.yaml` 同级的 `./data`，包含 SQLite 数据库及 WAL/SHM、Demo 和社区地图图片。重建容器时继续映射该目录。从旧版命名卷迁移时，先备份并复制数据到目标目录，保留原卷；更改映射不会自动迁移数据。

```bash
# 停止并移除容器和网络，保留宿主机数据目录。
docker compose down

# 再次启动，沿用原数据。
docker compose up -d
```

升级前备份数据目录与 `.env`，将 `.env` 中的 `ARENA_VERSION` 改为已发布的新版本，然后执行：

```bash
docker compose pull
docker compose up -d --force-recreate cs-arena cs-arena-web
```

完整配置、备份和 Docker Hub 发布方法见 [Docker 部署说明](deploy/docker/README.md)。

### 从源码构建镜像

部署文件 `compose.yaml` 只有镜像运行配置，因此 `docker compose up -d` 不会构建源码，不需要 `--no-build`。构建定义单独放在 [`compose.build.yaml`](compose.build.yaml)。

自行构建时，克隆完整仓库，在根目录执行：

```bash
cp .env.docker.example .env
# 按 .env 内注释填写配置。
export SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose -f compose.build.yaml build --pull
```

该命令只构建镜像。需要运行时，准备数据目录，再执行 `docker compose up -d`。完整构建与备份说明见 [Docker 部署说明](deploy/docker/README.md)。

## 配置与部署

配置示例见 [`.env.example`](.env.example)，systemd 部署说明见 [`deploy/README.md`](deploy/README.md)。

| 环境变量 | 用途 |
|---|---|
| `PORT` | 后端监听端口，默认 8080 |
| `BRIDGE_MODE` | `stub` 为本地模拟；`reverse` 为游戏主机主动连接 |
| `PUBLIC_BASE_URL` | 浏览器和游戏主机均可访问的平台地址 |
| `CORS_ORIGINS` | 允许的前端来源，以逗号分隔 |
| `ADMIN_STEAM_IDS` | 管理员 Steam ID64，以逗号分隔 |
| `GAME_SERVER_ID`、`GAME_SERVER_NAME`、`GAME_HOST_IP` | 首次初始化的游戏服务器组信息 |
| `BRIDGE_TOKEN` | 首次初始化的桥令牌，与主机桥配置一致 |
| `ENABLE_ARENA_MATCH=1` | 启用 ArenaMatch；也可用 `ARENA_MATCH_INSTANCES` 限定实例 |
| `BOT_INSTANCE_NAME` | 启用增强人机的专用实例名称 |
| `DB_PATH` | SQLite 数据库路径 |
| `DEMO_STORAGE_DIR`、`MAP_IMAGE_DIR` | Demo 和地图缩略图存储目录 |

服务器组和实例配置初始化后由平台数据库管理，修改首次初始化环境变量不会覆盖已有数据库记录。数据库及其 WAL/SHM、Demo 和上传资源需要持久保存。

## 目录

- [`backend/`](backend/README.md)：后端源码。
- [`frontend_winui/`](frontend_winui/README.md)：网页前端源码。
- [`deploy/`](deploy/README.md)：部署模板。
- [`update/CHANGELOG.md`](update/CHANGELOG.md)：平台页面使用的用户更新日志。

## 可选插件

本项目的“增强人机”功能需要与 [CS2-Bot-Improver](https://github.com/ed0ard/CS2-Bot-Improver) 配合使用。该插件为可选组件，由用户自行安装，不随本项目分发，其许可证及使用要求请参阅上游项目。

本项目提供的比赛插件为 [ArenaMatch](https://github.com/cubelightt/cs-arena-match)；其他插件由用户自行安装和管理。

## 鸣谢

感谢以下开源项目及其贡献者为本项目提供基础能力、设计资源和参考：

| 项目 | 使用或参考方式 |
|---|---|
| [React](https://github.com/facebook/react)、[Vite](https://github.com/vitejs/vite)、[TypeScript](https://github.com/microsoft/TypeScript) | 当前前端框架与构建工具 |
| [Radix UI](https://github.com/radix-ui/primitives)、[Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | 当前前端交互组件与样式基础 |
| [React Router](https://github.com/remix-run/react-router)、[Zustand](https://github.com/pmndrs/zustand) | 当前前端路由与状态管理 |
| [Lucide](https://github.com/lucide-icons/lucide) | 当前界面图标；部分图标源自 [Feather](https://github.com/feathericons/feather) |
| [Microsoft WinUI](https://github.com/microsoft/microsoft-ui-xaml) | 当前前端颜色、圆角等设计令牌的移植来源 |
| [Express](https://github.com/expressjs/express)、[Socket.IO](https://github.com/socketio/socket.io) | 当前后端 HTTP 服务与实时通信 |
| [sharp](https://github.com/lovell/sharp)、[libvips](https://github.com/libvips/libvips) | 当前图片处理能力 |
| [DOMPurify](https://github.com/cure53/DOMPurify)、[Marked](https://github.com/markedjs/marked) | 当前网页内容清理与 Markdown 渲染 |
| [CS2 Map Images](https://github.com/ghostcap-gaming/cs2-map-images) | 当前前端地图缩略图的素材来源 |
| [CS2 Multi Server Manager](https://github.com/GamesTwoLife/cs2-multiserver) | 游戏主机多实例管理，由 CS Arena Agent 集成 |
| [CounterStrikeSharp](https://github.com/roflmuffin/CounterStrikeSharp) | ArenaMatch 使用的 CS2 插件框架 |
| [MatchZy](https://github.com/shobhit-pathak/MatchZy)（历史参考） | 早期赛事方案及兼容接口的参考项目；当前比赛实现由 ArenaMatch 提供，发布包不包含 MatchZy |

第三方代码和素材保留各自的许可证或授权条款；本节鸣谢不替代相应的版权与许可声明。

## 开源协议

本项目自有代码采用 GNU General Public License v3.0 ，详见 [LICENSE](LICENSE)。
