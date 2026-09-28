# Docker 构建、部署与 Docker Hub 发布

平台分为两个镜像：前端使用 Vite 构建、Nginx 提供静态页面和代理；后端使用 Node.js 22 与 SQLite。游戏主机的 Agent、CS2 与 ArenaMatch 单独安装。

当前平台版本为 `v1.0`，两个镜像均使用 `v1.0` 标签；npm 工程使用对应的 `1.0.0`。发布版本不再使用日期命名。

## 已发布镜像

Docker Hub 当前公开提供 Linux amd64 的 v1.0 镜像：

```bash
docker pull cubelightt/cs-arena-backend:v1.0
docker pull cubelightt/cs-arena-frontend:v1.0
```

在 `.env` 中填写以下镜像配置及实际平台地址、管理员、游戏主机和桥令牌：

```dotenv
BACKEND_IMAGE=cubelightt/cs-arena-backend
FRONTEND_IMAGE=cubelightt/cs-arena-frontend
ARENA_VERSION=v1.0
```

随后执行 `docker compose pull` 与 `docker compose up -d`。前后端使用同一版本，数据映射到 `.env` 中 `DATA_DIR` 指定的宿主机目录，默认 `./data`。

## 部署与构建文件

- `compose.yaml`：直接运行已发布镜像，不包含 build 定义；使用 `docker compose pull` 和 `docker compose up -d`。
- `compose.build.yaml`：只包含镜像构建定义；在完整源码仓库执行 `docker compose -f compose.build.yaml build --pull`。
- `.env.docker.example`：带配置注释的 Docker 环境模板，复制为与 compose.yaml 同级的 `.env`。Compose 默认读取该文件，无需 --env-file。

## 本地构建

在平台仓库根目录执行，宿主机只需 Docker Engine、Compose v2 和 Git：

```bash
cp .env.docker.example .env
# 编辑 .env，填写真实平台地址、管理员 Steam ID、主机和桥令牌。
export SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose -f compose.build.yaml build --pull
```

也可以仅构建，不创建配置文件、不启动容器：

```bash
docker build --pull --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -f deploy/docker/backend.Dockerfile -t cs-arena-backend:v1.0 .
docker build --pull --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -f deploy/docker/frontend.Dockerfile -t cs-arena-frontend:v1.0 .
```

`docker build` 不启动应用服务，也不发布监听端口。Dockerfile 固定基础镜像 digest，应用依赖使用锁文件安装。首次构建下载基础镜像与 npm 依赖，后续复用缓存。构建机架构即镜像架构；不要把宿主机 node_modules 复制进镜像。

## 使用

```bash
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

默认入口为 `http://平台IP:18081`；以配置中的最终平台地址为准。后端 8080 只在 Compose 网络内使用。

| 配置 | 设置方法 |
|---|---|
| `DATA_DIR` | 宿主机数据目录，默认 compose.yaml 同级的 ./data，也可填写绝对路径 |
| `PUID` / `PGID` | 后端运行 UID/GID，默认 1000:1000，需与数据目录权限一致 |
| `HTTP_PORT` | 宿主机入口端口，默认 18081，部署前确认未占用 |
| `HTTP_BIND` | `0.0.0.0` 允许外部访问；`127.0.0.1` 仅供宿主机入口代理 |
| `PUBLIC_BASE_URL` | 浏览器和 Agent 均可达的最终平台地址，无末尾 `/` |
| `CORS_ORIGINS` | 最终网页来源，多个来源逗号分隔；用于 Socket.IO 来源配置 |
| `BRIDGE_MODE` | 真实比赛用 `reverse`，本地模拟用 `stub` |
| `ADMIN_STEAM_IDS` | 管理员 Steam ID64，逗号分隔 |
| `BRIDGE_TOKEN` | 首次服务器组种子令牌；已有库以平台内服务器组记录为准 |
| `GAME_SERVER_ID` / `GAME_HOST_IP` | 首次服务器组标识与游戏主机地址 |
| `ENABLE_ARENA_MATCH=1` | 启用 ArenaMatch，主机需已部署插件并报告对应桥能力 |
| `STEAM_PROXY` | 留空直连；代理必须从容器可达，容器的 localhost 不是宿主机 |
| `ARENA_VERSION` | 前后端镜像版本，保持一致 |
| `BACKEND_IMAGE` / `FRONTEND_IMAGE` | 本地镜像名或完整 Docker Hub 仓库名，不包含版本标签 |

已有宿主机反向代理时，设 `HTTP_BIND=127.0.0.1`，将最终站点代理到平台入口端口，开启 WebSocket 转发，并允许至少 256 MiB 上传及足够超时。入口本身在另一容器时使用共享 Docker 网络连接，不能使用该入口容器自己的 localhost。HTTPS 由外层入口终止，平台配置填写最终 HTTPS 地址。

Nginx 保留 `/api/` 路径（含 `/api/agent`），并转发 `/socket.io/`。前端同源请求，不需要设置 VITE_API_BASE。后端 Demo 上限默认 200 MiB，Nginx 上限 256 MiB；后端整段读入内存，应按并发上传量安排内存。

`DATA_DIR` 映射到容器的 `/var/lib/arena`，保存 SQLite 与 WAL/SHM、Demo 和社区图片。相对路径以 `compose.yaml` 所在目录为基准；容器删除后该宿主机目录仍保留。

首次启动前，按默认配置准备目录：

```bash
mkdir -p ./data
sudo chown 1000:1000 ./data
```

修改 DATA_DIR、PUID 或 PGID 后，同步调整上述命令。也可让容器使用已有目录属主的 UID/GID；实际运行用户必须可写。Compose 不自动创建一个由 root 拥有的数据目录，也不修改已有目录属主。

从旧版命名卷迁移时，先备份并复制数据库（含 WAL/SHM）、Demo 和图片到 DATA_DIR，保留原数据卷；修改目录配置不会自动迁移数据。

## 上传到 Docker Hub

1. 使用自己的 Docker Hub 账号，在 Hub 创建 `cs-arena-backend`、`cs-arena-frontend` 两个仓库，并选择需要的公开或私有可见性。Docker Hub 可见性与 GitHub 源码仓库独立。
2. 在 Docker 账户设置中创建允许 Read、Write 的 Personal access token。登录时将 token 填在密码提示处，不把令牌写到配置示例、命令或 Git。
3. 以下命令针对使用 `docker build` 生成的本地短名称镜像。使用 Compose 构建时，镜像名称由 `.env` 的 BACKEND_IMAGE / FRONTEND_IMAGE 决定；设置为自己的 Hub 仓库名后可直接执行 `docker compose -f compose.build.yaml push`。

给本地短名称镜像添加命名空间标签并上传：

```bash
# 改为你的 Docker Hub 用户名，它不一定与 GitHub 用户名相同。
export ARENA_DOCKERHUB_USER=YOUR_DOCKERHUB_USERNAME
export ARENA_RELEASE_VERSION=v1.0

docker login --username "$ARENA_DOCKERHUB_USER"
# Password 提示中粘贴 Docker Hub token。

docker tag "cs-arena-backend:$ARENA_RELEASE_VERSION" \
  "$ARENA_DOCKERHUB_USER/cs-arena-backend:$ARENA_RELEASE_VERSION"
docker tag "cs-arena-frontend:$ARENA_RELEASE_VERSION" \
  "$ARENA_DOCKERHUB_USER/cs-arena-frontend:$ARENA_RELEASE_VERSION"

docker push "$ARENA_DOCKERHUB_USER/cs-arena-backend:$ARENA_RELEASE_VERSION"
docker push "$ARENA_DOCKERHUB_USER/cs-arena-frontend:$ARENA_RELEASE_VERSION"
```

在两个仓库 Tags 页确认版本。首次发布建议使用明确版本；后续新版本使用新标签，保留旧标签便于回退。需要 `latest` 时另行添加该标签并 push，不覆盖旧版本标签。

步骤与权限说明见 [Docker 官方上传指南](https://docs.docker.com/docker-hub/repos/manage/hub-images/push/)、[个人访问令牌](https://docs.docker.com/security/access-tokens/personal-access-tokens/)。

## 在另一台主机拉取使用

在任意部署目录创建 `compose.yaml` 和 `.env`，完整内容见[根 README 的 Docker Compose 部署步骤](../../README.md#docker-compose-部署)。该方式直接使用已发布镜像，无需克隆或访问源码仓库。自建镜像仓库时可将镜像配置改为：

```dotenv
BACKEND_IMAGE=YOUR_DOCKERHUB_USERNAME/cs-arena-backend
FRONTEND_IMAGE=YOUR_DOCKERHUB_USERNAME/cs-arena-frontend
ARENA_VERSION=v1.0
```

同时填写该主机的平台地址、管理员和游戏主机信息。私有镜像先在该主机登录 Docker Hub；按前文说明创建数据目录并设置权限，随后：

```bash
docker compose pull
docker compose up -d
```

部署用 compose.yaml 没有 build 定义，直接运行已发布镜像即可，无需 --no-build、Node、npm 或完整源代码。首次数据库初始化后，实例和服务器组配置由数据库管理。

## 更新与备份

升级前，在无进行中比赛时停止容器并复制完整数据目录。以下命令以默认 ./data 为例，使用自定义 DATA_DIR 时替换对应路径：

```bash
docker compose stop
arena_backup_dir="./backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$arena_backup_dir"
cp -a ./data "$arena_backup_dir/data"
docker compose start
```

备份配置文件时妥善保存令牌。将 `.env` 的版本改为新发布版本，再拉取并重建两个服务：

```bash
docker compose pull
docker compose up -d --force-recreate cs-arena cs-arena-web
```

保持映射的数据目录，变更 DATA_DIR 前先迁移需要保留的数据。环境变量改动使用 `up -d` 更新，单独 `restart` 不会重载容器环境。回退旧镜像前检查数据库迁移兼容性。

## 源码与许可

镜像携带项目 LICENSE、第三方许可说明，后端运行依赖保留自身许可证。自有代码采用 GPL-3.0-only。发布时同时提供与镜像对应的完整源码和所需第三方许可材料；镜像 revision 标签记录构建时提交，代码来源为本仓库。私有 GitHub 链接本身不等于接收者可取得对应源码，公开发布时应提供可访问的对应源码下载。
