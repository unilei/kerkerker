# Kerkerker - 影视资源聚合平台

一个基于 Next.js 的影视资源聚合平台，支持从 Dailymotion 获取资源，并提供美观的播放界面和后台管理功能。

## 📋 目录

- [功能特性](#-功能特性)
- [界面预览](#-界面预览)
- [快速开始](#-快速开始)
- [环境配置](#-环境配置)
- [豆瓣 API 代理](#-豆瓣-api-代理)
- [Docker 部署](#-docker-部署)
- [本地开发](#-本地开发)

## ✨ 功能特性

- 🎬 聚合 Dailymotion 视频资源
- 📝 豆瓣电影信息自动匹配
- 📱 响应式设计，完美支持移动端
- 🎨 现代化 UI/UX，类似 TikTok 的短剧刷视频体验
- 🔐 后台管理系统，支持源管理和配置, 打开/login访问
- 🚀 支持 Docker 一键部署

## 📸 界面预览

### 首页

精美的首页设计，包含轮播 Banner 和分类影片展示，支持豆瓣评分显示。

![首页](screenshot/home.png)

### 搜索页

强大的搜索功能，支持多源聚合搜索，按来源筛选结果。

![搜索](screenshot/movie-search.png)

### 详情页

完整的影片详情页，展示评分、简介、演员等信息，支持多播放源选择。

![详情页](screenshot/movie-detail.png)

### 播放页

沉浸式播放体验，支持剧集选择和清晰度切换。

![播放页](screenshot/movie-playing.png)

## 🚀 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/your-repo/kerkerker.git
cd kerkerker

# 2. 复制环境配置
cp .env.example .env

# 3. 编辑 .env 文件，配置必要的环境变量（至少配置 MONGODB_URI）

# 4. 启动开发环境
npm run docker:dev
```

## 🔧 环境配置

项目依赖以下环境变量，请参考 `.env.example` 创建 `.env` 文件。

### 应用配置

| 变量名 | 说明 | 必填 | 默认值 | 示例 |
|--------|------|:----:|--------|------|
| `ADMIN_PASSWORD` | 后台管理密码 | 否 | `admin123` | `MySecurePass123!` |
| `NODE_ENV` | 环境模式 | 否 | `development` | `production` |

### 数据库配置

| 变量名 | 说明 | 必填 | 默认值 | 示例 |
|--------|------|:----:|--------|------|
| `MONGODB_URI` | MongoDB 连接字符串 | **是** | - | `mongodb://localhost:27017/kerkerker` |
| `MONGODB_DB_NAME` | 数据库名称 | 否 | `kerkerker` | `kerkerker_prod` |

**MongoDB URI 示例：**

```bash
# Docker 环境
MONGODB_URI=mongodb://mongodb:27017/kerkerker

# 本地开发
MONGODB_URI=mongodb://localhost:27017/kerkerker

# 云端 MongoDB Atlas
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/kerkerker
```

### 缓存配置（可选）

| 变量名 | 说明 | 必填 | 默认值 | 示例 |
|--------|------|:----:|--------|------|
| `REDIS_URL` | Redis 连接 URL | 否 | 内存缓存 | `redis://localhost:6379` |

> 💡 如果不配置 Redis，系统会自动降级为内存缓存。

### TMDB 配置（可选）

| 变量名 | 说明 | 必填 | 默认值 | 示例 |
|--------|------|:----:|--------|------|
| `TMDB_API_KEY` | TMDB API Bearer Token | 否 | - | `eyJhbGci...` |
| `TMDB_BASE_URL` | TMDB API 基础 URL | 否 | `https://api.themoviedb.org/3` | - |

> 获取 TMDB API Key: [https://www.themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)

### 豆瓣 API 代理配置

| 变量名 | 说明 | 必填 | 默认值 | 示例 |
|--------|------|:----:|--------|------|
| `DOUBAN_API_PROXY` | 豆瓣代理地址（支持多个，逗号分隔） | 否 | - | `https://proxy.workers.dev` |
| `DOUBAN_PROXY_ACCOUNTS` | Cloudflare 账号信息（用于自动部署） | 否 | - | 见下文 |

---

## 🎬 豆瓣 API 代理

由于豆瓣 API 有 IP 访问限制，建议部署 Cloudflare Workers 代理。

### 代理功能特性

- ✅ CORS 完整支持（包括 OPTIONS 预检请求）
- ✅ 响应缓存（减少请求频率，避免被封）
- ✅ 健康检查接口 `/health`
- ✅ 支持 GET/POST 请求
- ✅ 多代理负载均衡

### 方式一：自动部署（推荐）

1. **获取 Cloudflare 信息**：
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
   - **Account ID**: Workers 页面右侧或 URL 中
   - **API Token**: My Profile → API Tokens → Create Token → 选择 "Edit Cloudflare Workers"

2. **配置环境变量**：

   ```bash
   # 格式: 账号名:KV_ID:KV_PREVIEW_ID:ACCOUNT_ID:API_TOKEN
   # KV_ID 和 KV_PREVIEW_ID 可以留空，用占位符
   DOUBAN_PROXY_ACCOUNTS="myaccount:::acc_id_here:api_token_here"
   
   # 多账号示例（实现负载均衡）
   DOUBAN_PROXY_ACCOUNTS="acc1:::id1:token1,acc2:::id2:token2"
   ```

3. **运行部署脚本**：

   ```bash
   ./scripts/deploy-douban-proxy.sh
   ```

4. **配置代理地址**：
   部署成功后，将输出的 Worker URL 添加到 `.env`：

   ```bash
   DOUBAN_API_PROXY=https://douban-proxy.your-account.workers.dev
   ```

### 方式二：手动部署

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages** → **Create Application** → **Create Worker**
3. 复制 `docs/cloudflare-douban-proxy.js` 的内容粘贴到编辑器
4. 点击 **Deploy** 部署
5. 将生成的 Worker URL 配置到 `DOUBAN_API_PROXY`

---

## 🐳 Docker 部署

### 1. 构建并推送镜像（开发者）

```bash
# 构建多架构镜像并推送到 Docker Hub
npm run server:deploy
```

该脚本会：

- 检查 Docker Hub 登录状态
- 创建多架构构建器（amd64/arm64）
- 构建镜像并推送

### 2. 服务器部署

**准备文件**：

```text
your-server/
├── docker-compose.server.yml
└── .env
```

**启动服务**：

```bash
# 拉取镜像并启动
docker-compose -f docker-compose.server.yml up -d

# 查看日志
docker-compose -f docker-compose.server.yml logs -f

# 停止服务
docker-compose -f docker-compose.server.yml down
```

**更新服务**：

```bash
docker-compose -f docker-compose.server.yml pull
docker-compose -f docker-compose.server.yml up -d
```

### 3. Docker Compose 文件说明

| 文件 | 用途 |
|------|------|
| `docker-compose.yml` | 本地开发（包含完整服务栈） |
| `docker-compose.dev.yml` | 开发环境（热重载） |
| `docker-compose.server.yml` | 生产服务器部署 |

---

## 💻 本地开发

### 使用 Docker（推荐）

```bash
# 启动开发环境（包含 MongoDB、Redis 等服务）
npm run docker:dev

# 停止服务
npm run docker:stop
```

### 不使用 Docker

```bash
# 1. 安装依赖
npm install

# 2. 确保 MongoDB 已运行，并配置 .env 中的 MONGODB_URI

# 3. 启动开发服务器
npm run dev

# 4. 访问应用
open http://localhost:3000
```

### NPM 脚本说明

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run docker:dev` | Docker 开发环境（热重载 + 完整服务栈） |
| `npm run docker:prod` | Docker 生产环境 |
| `npm run docker:stop` | 停止 Docker 服务 |
| `npm run server:deploy` | 构建并推送镜像到 Docker Hub |

## 📁 项目结构

```text
kerkerker/
├── app/                    # Next.js App Router 页面
├── components/             # React 组件
├── lib/                    # 工具函数和数据库连接
├── hooks/                  # React Hooks
├── types/                  # TypeScript 类型定义
├── docs/                   # 文档和脚本
│   └── cloudflare-douban-proxy.js  # 豆瓣代理 Worker 代码
├── scripts/                # 部署脚本
│   ├── deploy-server.sh    # Docker 构建部署
│   └── deploy-douban-proxy.sh  # 豆瓣代理部署
└── docker-compose*.yml     # Docker 编排文件
```

## 📜 License

MIT
