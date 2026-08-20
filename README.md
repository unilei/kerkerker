# 🎬 Kerkerker - 影视资源聚合平台

<div align="center">

![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript)
![MongoDB](https://img.shields.io/badge/MongoDB-7-green?style=flat-square&logo=mongodb)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

**现代化影视资源聚合平台** - 支持 Dailymotion 视频源、豆瓣信息匹配、多种部署方式

🌐 **在线演示**: [https://kerkerker.vercel.app](https://kerkerker.vercel.app)

[功能特性](#-功能特性) • [部署方式](#-部署方式) • [环境变量](#-环境变量) • [本地开发](#-本地开发)

</div>

---

## 插件平台架构

内容数据、播放资源、网盘资源、弹幕、图片、搜索和推荐按统一插件契约演进。架构基线与开发验收标准见 [`docs/plugin-platform/README.md`](docs/plugin-platform/README.md) 和 [`docs/plugin-platform/development-standard.md`](docs/plugin-platform/development-standard.md)；当前分支已提供 v1 契约、Manifest 校验、静态注册中心以及 Douban/KKPAN 参考适配器。

## ✨ 功能特性

- 🎬 **视频聚合** - 聚合 Dailymotion 等多个视频源
- 📝 **豆瓣匹配** - 自动匹配豆瓣电影信息和评分
- 💬 **弹幕功能** - 自动匹配加载弹幕，支持手动搜索
- 🎥 **高级播放器** - ArtPlayer 播放器，支持 HLS、倍速、快捷键
- 📱 **响应式设计** - 完美支持移动端和桌面端
- 🎨 **现代化 UI** - Netflix 风格界面设计
- 🔐 **后台管理** - 视频源配置、频道管理 (`/login`)
- ☁️ **影片网盘同步中心** - 按站内目录批量发现、同步、重试和每日更新网盘资源
- 🚀 **多种部署** - 支持 Vercel、Docker、VPS 一键部署

## 📸 界面预览

<details>
<summary>点击展开预览图</summary>

### 首页

![首页](screenshot/home.png)

### 搜索页

![搜索](screenshot/movie-search.png)

### 详情页

![详情页](screenshot/movie-detail.png)

### 播放页

![播放页](screenshot/movie-playing.png)

</details>

---

## 🚀 部署方式

### 方式一：Vercel 部署（推荐）

> 无需服务器，免费托管，自动 HTTPS

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/unilei/kerkerker)

**步骤：**

1. 点击上方按钮，Fork 项目到 Vercel
2. 在 Vercel 控制台设置环境变量：
   ```
   MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/kerkerker
   ADMIN_PASSWORD=your_password
   ```
3. 部署完成！

> 💡 **提示**：Vercel 部署需要使用云端 MongoDB（如 [MongoDB Atlas](https://www.mongodb.com/atlas) 免费版）

---

### 方式二：Docker Compose 部署

#### 快速启动

```bash
# 1. 克隆项目
git clone https://github.com/unilei/kerkerker.git
cd kerkerker

# 2. 创建配置文件
cp .env.example .env

# 3. 编辑配置（可选）
nano .env

# 4. 启动服务
docker-compose up -d

# 5. 查看日志
docker-compose logs -f app
```

#### docker-compose.yml 说明

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000" # 修改左侧端口号自定义访问端口
    environment:
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
      - MONGODB_URI=mongodb://mongodb:27017/kerkerker
    depends_on:
      mongodb:
        condition: service_healthy

  mongodb:
    image: mongo:7
    volumes:
      - mongodb-data:/data/db # 数据持久化
```

#### 常用命令

```bash
docker-compose up -d       # 后台启动
docker-compose down        # 停止服务
docker-compose logs -f     # 查看日志
docker-compose restart     # 重启服务
docker-compose pull        # 更新镜像
```

---

### 方式三：VPS 一键部署

在任何装有 Docker 的服务器上执行：

```bash
# 使用 curl
curl -fsSL https://raw.githubusercontent.com/unilei/kerkerker/master/scripts/install.sh | bash

# 使用 wget
wget -qO- https://raw.githubusercontent.com/unilei/kerkerker/master/scripts/install.sh | bash
```

**部署后管理：**

```bash
cd ~/kerkerker
./kerkerker.sh start     # 启动
./kerkerker.sh stop      # 停止
./kerkerker.sh restart   # 重启
./kerkerker.sh logs      # 日志
./kerkerker.sh update    # 更新
./kerkerker.sh backup    # 备份
```

---

## ⚙️ 环境变量

### 必需变量

| 变量名        | 说明               | 示例                                             |
| ------------- | ------------------ | ------------------------------------------------ |
| `MONGODB_URI` | MongoDB 连接字符串 | `mongodb+srv://user:pass@cluster.mongodb.net/db` |

### 可选变量

| 变量名                        | 说明           | 默认值                               |
| ----------------------------- | -------------- | ------------------------------------ |
| `ADMIN_PASSWORD`              | 后台管理密码   | `admin123`                           |
| `MONGODB_DB_NAME`             | 数据库名称     | `kerkerker`                          |
| `KKPAN_SYNC_CRON_SECRET`      | kkpans 定时同步 Bearer 密钥 | -                         |
| `CRON_SECRET`                 | 兼容部署平台的定时任务 Bearer 密钥（优先使用 `KKPAN_SYNC_CRON_SECRET`） | - |
| `NEXT_PUBLIC_DANMU_API_URL`   | 弹幕 API 地址  | `https://danmuapi1-eight.vercel.app` |
| `NEXT_PUBLIC_DANMU_API_TOKEN` | 弹幕 API Token | -                                    |

### MongoDB URI 示例

```bash
# Docker 内部（docker-compose 自动配置）
MONGODB_URI=mongodb://mongodb:27017/kerkerker

# 本地 MongoDB
MONGODB_URI=mongodb://localhost:27017/kerkerker

# MongoDB Atlas（云端）
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/kerkerker
```

配置 `KKPAN_SYNC_CRON_SECRET` 后，定时任务可用
`Authorization: Bearer <secret>` 调用
`POST /api/pan-resources/sync-kkpan`，无需依赖 7 天有效的管理员 cookie。
该 Bearer 接口保留给外部运维调用；常规部署不需要再配置服务器 crontab。

### 影片网盘同步中心

登录 `/admin` 的“网盘资源”页后，使用“影片网盘同步中心”可以：

1. **发现影片**：收集站内分类分页、电影/电视剧分类、最新页、首页推荐、日历和 Top250 中已经展示的条目，并补入历史上已经录入过网盘资源的影片，按豆瓣 ID 建立同步台账。
2. **一键同步未处理**：后台按小批次逐片搜索 kkpans，自动入库匹配资源；页面会轮询进度，不需要逐片点击。
3. **状态筛选和重试**：`未同步`、`同步中`、`已同步`、`已检查无资源`、`失败` 分开统计；每一行都可以再次同步。

台账的范围是站内展示目录与已有网盘资源的并集，不会把整个豆瓣库当作同步目标。每日任务会重新发现目录、把超过 24 小时未检查的影片放回队列，并处理一批到期影片。

登录后台“网盘资源”页的“后台自动同步”面板，可以分别配置“影片目录同步”和“kkpans 增量同步”：

1. 设置每天执行时间、每批数量和最多批次，单独打开或关闭任务。
2. 点击“立即运行”后，任务在应用进程中异步执行，不占用浏览器请求；页面会显示当前影片、处理/新增/失败/剩余数量和进度条。
3. 在“最近运行”和“执行日志”中查看每次运行的触发方式、错误、上游统计和停止状态；运行中的任务可以请求停止。

调度配置、运行台账和事件日志都保存在 MongoDB。应用重启后，未完成任务会被标记为失败，避免静默丢失；日志和运行记录保留 30 天自动清理。调度器默认关闭每个任务，首次部署后请在后台确认上游可用，再打开对应开关。

部署环境可用 `PAN_SYNC_SCHEDULER_DISABLED=true` 暂停应用内轮询，或用 `PAN_SYNC_SCHEDULER_POLL_MS` 调整检查间隔（10 秒到 10 分钟）。这两个变量只控制调度器进程，不会删除已保存的配置和运行记录。

如需保留外部运维调度，也可使用同一个 Bearer 密钥：

```bash
# 每天执行一批影片级更新（limit 可按服务器能力调整到 1-20）
curl -fsS -X POST https://your-domain.example/api/pan-resources/catalog-sync \
  -H "Authorization: Bearer ${KKPAN_SYNC_CRON_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"action":"daily","limit":20}'

# 继续执行原有 kkpans 全局增量同步
curl -fsS -X POST https://your-domain.example/api/pan-resources/sync-kkpan \
  -H "Authorization: Bearer ${KKPAN_SYNC_CRON_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"mode":"incremental","limit":50}'
```

两个任务共用同步租约；外部调用与后台任务同时执行时，其中一个会返回 `409`，不会并发写入。

首次部署或数据库为空时，建议先在后台点击一次“一键同步未处理”，确认目录发现和资源写入正常，再打开后台自动任务。

已有数据库升级到当前版本前，先备份 MongoDB，并在应用目录依次执行只读预览：

```bash
npx tsx scripts/pan-dedup.ts
npx tsx scripts/content-identity-backfill.ts
```

两个预览发现的跨影片、来源引用或 `content_id` 冲突都必须人工对账，脚本不会猜测或覆盖
已有身份。预览通过后，停止所有应用实例、调度器和外部同步写入，再显式执行维护：

```bash
npx tsx scripts/pan-dedup.ts --apply --maintenance
npx tsx scripts/content-identity-backfill.ts --apply --maintenance
```

维护完成并通过脚本的最终对账后再重启应用。默认预览不会创建索引或修改文档；身份回填只给
缺失字段写入已确认的映射，错误、孤立或不一致的现有 `content_id` 会直接中止迁移。
`pan-dedup.ts` 会把所有待修改或删除的原文档写入 `pan_resource_dedup_backups`，并在
`pan_resource_dedup_runs` 保存原索引摘要和运行状态。若运行状态为 `failed`，索引和数据步骤
可能只完成了一部分，必须保持停写并按对应 `backup_run_id` 对账，不能直接启动应用或再次部署。

### 当前分支 Docker 自动部署

`cn-compliance` 分支包含独立的 GitHub Actions 部署流程：push 到该分支后，流程会先执行
Lint、TypeScript 检查和全部 `tests/*.test.ts`，再构建 `linux/amd64` 镜像推送到 GHCR，最后通过 SSH 更新 VPS 上的
Docker Compose 服务。不会触发 `master` 分支的部署。

生产镜像内含编译后的迁移运行器。部署任务会先启动 MongoDB 并执行两份只读预览，预览通过后
停止旧应用并进入维护写入；只有迁移及最终对账都成功才启动新应用。发现身份冲突时发布会失败并恢复
旧应用，数据库不会被静默猜测修复；此时应根据 Actions 日志和迁移运行记录人工对账。
发布前还会从应用容器验证豆瓣服务的 `/api/v1/250` 必须返回完整 250 条数据，因此应先部署
`kerkerker-douban-service` 的 `cn-compliance` 工作流，再部署本项目。

GitHub 不提供公开仓库中的私有分支。若该分支包含不能公开的插件或部署实现，必须把分支和
工作流放入私有部署仓库，或先把整个仓库设为私有；不要将待保密提交推到当前公开 origin。

仓库需要配置以下 Actions Secrets：

| Secret | 作用 |
| --- | --- |
| `DEPLOY_HOST` / `DEPLOY_USER` | VPS 地址和 SSH 用户 |
| `DEPLOY_SSH_KEY` / `DEPLOY_KNOWN_HOSTS` | 部署私钥和固定主机指纹 |
| `DEPLOY_ADMIN_PASSWORD` / `DEPLOY_ADMIN_SESSION_SECRET` | 后台登录与会话密钥 |
| `DEPLOY_DOUBAN_API_URL` | 服务器上的豆瓣服务地址 |
| `DEPLOY_KKPAN_SYNC_CRON_SECRET` | 网盘同步接口 Bearer 密钥 |

可选的仓库 Variables：`DEPLOY_PATH`（默认 `/www/wwwroot/kerkerker`）、
`DEPLOY_PORT`（默认 `3003`）和 `DEPLOY_BIND`（默认 `0.0.0.0`）。默认端口是为了避开服务器上已有的
3000 端口服务；私有部署仓库还可以用 `IMAGE_NAME` 指定私有 GHCR 镜像名。变更端口后，
反向代理配置也要同步调整。部署过程会保留上一份 `.env`，健康检查失败时自动恢复旧容器配置。

---

## 💻 本地开发

### 使用 Docker（推荐）

```bash
# 启动开发环境（包含 MongoDB）
npm run docker:dev

# 停止服务
docker-compose -f docker-compose.dev.yml down
```

### 不使用 Docker

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，设置 MONGODB_URI

# 3. 启动开发服务器
npm run dev

# 4. 访问
open http://localhost:3000
```

### 脚本说明

| 命令                  | 说明                      |
| --------------------- | ------------------------- |
| `npm run dev`         | 启动开发服务器            |
| `npm run build`       | 构建生产版本              |
| `npm run docker:dev`  | Docker 开发环境（热重载） |
| `npm run docker:prod` | 构建并推送 Docker 镜像    |

---

## 📁 项目结构

```
kerkerker/
├── app/                    # Next.js App Router
├── components/             # React 组件
│   └── player/             # 播放器组件
│       ├── LocalHlsPlayer.tsx  # 本地 HLS 播放器
│       └── DanmakuPanel.tsx    # 弹幕搜索面板
├── lib/                    # 工具库
│   ├── cache.ts            # 内存缓存
│   ├── db.ts               # MongoDB 连接
│   └── player/             # 播放器工具
│       └── danmaku-service.ts  # 弹幕服务
├── scripts/                # 部署脚本
│   └── install.sh          # 一键部署脚本
├── docker-compose.yml      # 生产环境
├── docker-compose.dev.yml  # 开发环境
└── docker-compose.server.yml
```

## 📄 License

MIT License © 2026
