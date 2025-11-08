# 影视聚合播放平台

<div align="center">

[![Next.js](https://img.shields.io/badge/Next.js-16.0.1-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-7.0-green?style=flat-square&logo=mongodb)](https://www.mongodb.com/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-4.0-38B2AC?style=flat-square&logo=tailwind-css)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

基于 Next.js 16 + TypeScript 开发的现代化影视聚合播放平台，集成多视频源切换、智能匹配播放、豆瓣数据同步等功能

[在线演示](https://kerkerker.vercel.app/) · [问题反馈](https://github.com/unilei/kerkerker/issues) · [功能建议](https://github.com/unilei/kerkerker/issues)

</div>

## 📋 目录

- [✨ 核心特性](#-核心特性)
- [🚀 快速开始](#-快速开始)
- [📝 配置说明](#-配置说明)
- [🛠️ 技术栈](#️-技术栈)
- [🏗️ 项目架构](#️-项目架构)
- [📦 部署指南](#-部署指南)
- [⚙️ 环境变量](#️-环境变量)
- [🎮 键盘快捷键](#-键盘快捷键)
- [📱 浏览器支持](#-浏览器支持)
- [⚡ 性能优化](#-性能优化)
- [🔒 安全特性](#-安全特性)
- [🤝 贡献指南](#-贡献指南)
- [📄 开源协议](#-开源协议)
- [💡 常见问题](#-常见问题)
- [🎯 预设视频源](#-预设视频源)
- [🙏 致谢](#-致谢)

## ✨ 核心特性

### 🎬 影视功能
- **多源聚合**: 集成9个高质量视频源，支持一键切换
- **智能播放**: 自动匹配最佳播放源，支持多个播放器解析
- **豆瓣同步**: 实时获取豆瓣 Top250、热映榜单、最新电影等数据
- **分类筛选**: 支持38+种分类筛选，按类型、地区、年份等条件过滤
- **搜索功能**: 全文搜索影视内容，支持关键词匹配
- **播放历史**: 自动记录观看进度和播放历史
- **剧集管理**: 支持千集以上剧集列表，快速切换上下集

### 🎯 技术亮点
- **MongoDB持久化**: 使用MongoDB数据库存储配置，跨设备共享数据
- **后台管理**: 可视化管理视频源配置，支持导入预设配置
- **响应式设计**: 完美适配桌面端、平板和移动端
- **深色模式**: 护眼的夜间主题，支持系统主题自动切换
- **无限滚动**: 流畅的瀑布流加载体验，优化性能
- **键盘快捷键**: 支持键盘操作，提升使用体验
- **图片懒加载**: 优化页面加载速度，节省带宽

## 🚀 快速开始

### 环境要求

- Node.js 18.0+
- MongoDB 5.0+
- npm 或 yarn

### 一键部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/unilei/kerkerker)

点击上方按钮，一键部署到 Vercel（推荐）

### 本地开发

```bash
# 克隆项目
git clone https://github.com/unilei/kerkerker.git
cd kerkerker

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 文件，填入 MongoDB 连接信息

# 启动开发服务器
npm run dev
```

访问 [http://localhost:3000](http://localhost:3000) 查看应用

## 📝 配置说明

### 1. 环境变量配置

创建 `.env.local` 文件：

```bash
# MongoDB 数据库连接 URI（必需）
MONGODB_URI=mongodb://localhost:27017/kerkerker

# 数据库名称（可选，默认为 kerkerker）
MONGODB_DB_NAME=kerkerker

# 管理后台密码（可选，用于后台管理页面保护）
ADMIN_PASSWORD=your_admin_password
```

### 2. 配置视频源

部署完成后，访问后台管理页面配置视频源：

```
http://your-domain.com/admin/settings
```

**方式一：导入预设配置**
- 点击「导入预设配置」按钮
- 系统自动导入 9 个预配置的视频源

**方式二：手动添加**
```typescript
{
  key: 'source_key',       // 唯一标识
  name: '资源站名称',      // 显示名称
  api: 'https://api.example.com/api.php/provide/vod',  // API地址
  playUrl: 'https://player.example.com/?url=',         // 播放器地址
  type: 'json'             // 数据格式: json 或 xml
}
```

### 3. 数据库配置

应用使用 MongoDB 数据库存储配置数据，确保：

- MongoDB 服务正常运行
- 网络连接正常
- 有足够的存储空间

**数据库集合结构**：
- `vod_sources`: 视频源配置
- `vod_source_selection`: 当前选中的视频源

## 🛠️ 技术栈

| 技术 | 说明 | 版本 |
|------|------|------|
| [Next.js](https://nextjs.org/) | React 全栈框架 | 16.0.1 |
| [TypeScript](https://www.typescriptlang.org/) | 类型安全的 JavaScript | 5.0 |
| [MongoDB](https://www.mongodb.com/) | NoSQL 数据库 | 7.0 |
| [Tailwind CSS](https://tailwindcss.com/) | 实用优先的 CSS 框架 | 4.0 |
| [React](https://react.dev/) | 用户界面库 | 19.2.0 |
| [Lucide React](https://lucide.dev/) | 图标库 | 0.553.0 |
| [Axios](https://axios-http.com/) | HTTP 客户端 | 1.13.2 |

## 🏗️ 项目架构

```
kerkerker/
├── app/                    # Next.js App Router
│   ├── admin/             # 后台管理页面
│   ├── api/               # API 路由
│   ├── category/          # 分类页面
│   ├── latest/            # 最新内容
│   ├── login/             # 登录页面
│   ├── movies/            # 电影页面
│   ├── play/              # 播放页面
│   ├── search/            # 搜索页面
│   ├── tv/                # 电视剧页面
│   ├── layout.tsx         # 根布局
│   ├── page.tsx           # 首页
│   └── globals.css        # 全局样式
├── components/            # React 组件
│   ├── DoubanCard.tsx     # 豆瓣卡片组件
│   └── Toast.tsx          # 通知组件
├── lib/                   # 工具库
│   ├── auth.ts            # 认证相关
│   ├── db.ts              # 数据库连接
│   ├── preset-vod-sources.ts  # 预设视频源
│   ├── utils.ts           # 工具函数
│   └── vod-sources-db.ts  # 视频源数据库操作
├── types/                 # TypeScript 类型定义
├── public/                # 静态资源
└── data/                  # 静态数据
```

## 📦 部署指南

### Vercel（推荐）

1. **准备 MongoDB 数据库**
   - 推荐使用 [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) 免费版
   - 或使用 [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres) 配合 MongoDB

2. **Fork 并部署**
   - Fork 本项目到你的 GitHub
   - 在 [Vercel](https://vercel.com) 导入项目
   - 配置环境变量：
     ```bash
     MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/kerkerker
     MONGODB_DB_NAME=kerkerker
     ADMIN_PASSWORD=your_admin_password
     ```
   - 点击部署

3. **初始化配置**
   - 部署完成后访问 `/admin/settings`
   - 导入预设视频源配置
   - 开始使用！

### Railway（支持持久化）

1. **连接 GitHub 仓库到 Railway**
2. **添加 MongoDB 服务**
3. **配置环境变量**
4. **自动部署**

### Docker 部署

```dockerfile
FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci

# 复制源代码
COPY . .

# 构建应用
RUN npm run build

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["npm", "start"]
```

```bash
# 构建并运行
docker build -t kerkerker .
docker run -p 3000:3000 -e MONGODB_URI=your_mongodb_uri kerkerker
```

### 自托管

```bash
# 构建
npm run build

# 使用 PM2 运行
pm2 start npm --name "kerkerker" -- start

# 或使用 forever
forever start -c "npm start" ./
```

## ⚙️ 环境变量

创建 `.env.local` 文件：

```bash
# MongoDB 数据库连接 URI（必需）
MONGODB_URI=mongodb://localhost:27017/kerkerker

# 数据库名称（可选，默认为 kerkerker）
MONGODB_DB_NAME=kerkerker

# 管理后台密码（可选，用于后台管理页面保护）
ADMIN_PASSWORD=your_admin_password

# 豆瓣 API 代理（可选，用于解决访问限制）
DOUBAN_API_PROXY=https://your-proxy.com
```

### 环境变量说明

| 变量名 | 类型 | 必需 | 说明 |
|--------|------|------|------|
| `MONGODB_URI` | string | ✅ | MongoDB 数据库连接字符串 |
| `MONGODB_DB_NAME` | string | ❌ | 数据库名称，默认为 `kerkerker` |
| `ADMIN_PASSWORD` | string | ❌ | 后台管理页面访问密码 |
| `DOUBAN_API_PROXY` | string | ❌ | 豆瓣 API 代理地址 |

## 🎮 键盘快捷键

播放页面支持的快捷键：

| 快捷键 | 功能 |
|--------|------|
| `←` / `→` | 上一集 / 下一集 |
| `↑` / `↓` | 上一集 / 下一集 |
| `S` | 打开设置面板 |
| `L` | 显示 / 隐藏选集列表 |
| `ESC` | 返回 / 关闭弹窗 |

## 📱 浏览器支持

| 浏览器 | 最低版本 | 状态 |
|--------|----------|------|
| Chrome | 90+ | ✅ 完全支持 |
| Firefox | 88+ | ✅ 完全支持 |
| Safari | 14+ | ✅ 完全支持 |
| Edge | 90+ | ✅ 完全支持 |
| 移动端 Chrome | 最新版 | ✅ 完全支持 |
| 移动端 Safari | 14+ | ✅ 完全支持 |

## ⚡ 性能优化

### 前端优化
- **代码分割**: 使用 Next.js 自动代码分割，减少初始加载时间
- **图片懒加载**: 优化图片加载，提升页面性能
- **无限滚动**: 按需加载内容，避免一次性加载大量数据
- **骨架屏**: 提供流畅的加载体验
- **缓存策略**: 合理使用浏览器缓存和 CDN

### 后端优化
- **数据库索引**: MongoDB 查询优化，提升数据检索速度
- **API 缓存**: 减少重复请求，降低服务器负载
- **连接池**: 数据库连接复用，提高响应速度

### 部署优化
- **CDN 加速**: 静态资源通过 CDN 分发
- **边缘计算**: 利用 Vercel Edge Network
- **压缩传输**: Gzip/Brotli 压缩减少传输大小

## 🔒 安全特性

### 数据安全
- **环境变量保护**: 敏感信息通过环境变量管理
- **数据库安全**: MongoDB 连接使用认证机制
- **API 限制**: 防止恶意请求和滥用

### 隐私保护
- **无用户追踪**: 不收集用户个人信息
- **本地存储**: 播放历史等数据仅存储在用户数据库
- **透明开源**: 代码完全开源，可自行审查

### 部署安全
- **HTTPS 强制**: 生产环境强制使用 HTTPS
- **CORS 配置**: 合理配置跨域访问策略
- **后台保护**: 管理页面可设置密码保护 

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发流程

1. **Fork 本项目**
2. **创建特性分支**
   ```bash
   git checkout -b feature/AmazingFeature
   ```
3. **提交更改**
   ```bash
   git commit -m 'Add some AmazingFeature'
   ```
4. **推送到分支**
   ```bash
   git push origin feature/AmazingFeature
   ```
5. **提交 Pull Request**

### 代码规范

- 使用 TypeScript 进行类型安全开发
- 遵循 ESLint 和 Prettier 配置
- 组件使用 PascalCase 命名
- 文件名使用 kebab-case 或 camelCase
- 提交信息使用约定式提交格式

### 问题反馈

提交 Issue 时请包含：
- 详细的问题描述
- 复现步骤
- 环境信息（浏览器、操作系统等）
- 相关错误日志

## 📄 开源协议

本项目基于 [MIT](LICENSE) 协议开源

## 💡 常见问题

<details>
<summary><b>Q: 如何配置 MongoDB 数据库？</b></summary>

A: 
1. 推荐使用 [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) 免费版
2. 创建集群后，获取连接字符串
3. 在环境变量中设置 `MONGODB_URI`
4. 确保网络访问权限配置正确
</details>

<details>
<summary><b>Q: 部署后视频源无法播放？</b></summary>

A: 
1. 确保在 `/admin/settings` 中配置了视频源
2. 检查视频源 API 是否可访问
3. 尝试切换到其他视频源
4. 检查播放器解析接口是否正常
</details>

<details>
<summary><b>Q: 豆瓣数据加载失败？</b></summary>

A: 
1. 部分地区可能无法访问豆瓣 API
2. 可以配置 `DOUBAN_API_PROXY` 环境变量
3. 或使用代理服务器访问
</details>

<details>
<summary><b>Q: 如何添加自己的视频源？</b></summary>

A: 
1. 访问 `/admin/settings` 页面
2. 点击"添加视频源"
3. 填写视频源信息（API地址、播放器地址等）
4. 测试连接并保存
</details>

<details>
<summary><b>Q: 移动端体验如何优化？</b></summary>

A: 
1. 项目已内置响应式设计
2. 支持触摸手势操作
3. 建议使用移动端 Chrome 或 Safari 浏览器
4. 可以添加到主屏幕获得类 App 体验
</details>

## 🎯 预设视频源

项目内置了 9 个高质量视频源：

1. **如意资源站** - https://cj.rycjapi.com
2. **茅台资源** - https://caiji.maotaizy.cc
3. **U酷资源网** - https://api.ukuapi88.com
4. **暴风资源** - https://bfzyapi.com
5. **360资源** - https://360zy.com
6. **卧龙资源** - https://collect.wolongzy.cc
7. **魔都资源网** - https://caiji.moduapi.cc
8. **iKun资源** - https://ikunzyapi.com
9. **极速资源** - https://jszyapi.com

## 🙏 致谢

- [豆瓣电影](https://movie.douban.com/) - 提供影视数据
- [Next.js](https://nextjs.org/) - 优秀的 React 框架
- [Tailwind CSS](https://tailwindcss.com/) - 实用优先的 CSS 框架
- [MongoDB](https://www.mongodb.com/) - 强大的 NoSQL 数据库
- [Lucide](https://lucide.dev/) - 精美的图标库

---

<div align="center">

如果这个项目对你有帮助，请给个 ⭐️ Star 支持一下！

Made with ❤️ by [unilei](https://github.com/unilei)

</div>
