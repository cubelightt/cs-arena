# 平台部署

平台使用 Node.js 22.13 或更新版本运行后端，前端构建后由静态服务器提供。`arena-backend.service` 是后端 systemd 系统服务模板。

## 后端

创建专用 `arena` 用户，将仓库放到 `/opt/cs-arena`，并安装 `backend/` 的 npm 依赖。将填写后的配置保存到 `/etc/arena/backend.env`，参考[配置示例](../.env.example)。

设置 `BRIDGE_MODE=reverse`，填写 `PUBLIC_BASE_URL`、`ADMIN_STEAM_IDS`、桥令牌和 `CORS_ORIGINS`。首次初始化服务器组时填写主机信息；启用 ArenaMatch 时设置 `ENABLE_ARENA_MATCH=1` 或指定 `ARENA_MATCH_INSTANCES`。实际桥令牌应与平台数据库中服务器组的令牌一致。

建议将 `DB_PATH`、`DEMO_STORAGE_DIR`、`MAP_IMAGE_DIR` 指向 `/var/lib/arena/` 下的独立目录，确保 `arena` 用户可写。配置文件仅允许管理员和服务用户读取。

```bash
sudo useradd --system --home /var/lib/arena --shell /usr/sbin/nologin arena
sudo install -d -o arena -g arena /opt/cs-arena /var/lib/arena
sudo install -m 0644 deploy/arena-backend.service /etc/systemd/system/arena-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now arena-backend
sudo systemctl status arena-backend --no-pager
```

查看日志：

```bash
sudo journalctl -u arena-backend -f
```

## 前端

在 `frontend_winui/` 执行 `npm ci` 和 `npm run build`，通过静态服务器提供生成的 `dist/` 目录。将 `/api/` 和 `/socket.io/` 代理到后端，启用 WebSocket 转发，并为网页路由配置 SPA 回退。`PUBLIC_BASE_URL` 应使用用户和游戏主机均可访问的入口地址。

## 数据与升级

保留数据库及其 WAL/SHM、Demo 和上传资源。升级前备份数据和配置，再替换源码或前端构建产物并重启服务。平台健康接口为 `/api/health`，连接游戏主机后还需确认桥状态为 connected。

## Docker

前后端双镜像构建、Compose 使用、数据备份及 Docker Hub 发布见 [Docker 部署说明](docker/README.md)。脱敏环境示例为根目录 `.env.docker.example`，实际配置保存为 compose.yaml 同级的 `.env`，不提交 Git。数据通过 `DATA_DIR` 映射宿主机目录，默认 ./data；镜像部署使用 compose.yaml，源码构建使用 compose.build.yaml。
