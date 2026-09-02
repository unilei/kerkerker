# 爱盼短剧（kerkerker）SEO 方案

> 2026-09-02 基于 short-drama 分支代码现状设计。目标市场：中文搜索引擎
> （百度为主、Google 次之、Bing 兜底）。站点定位：短剧信息展示 + 网盘
> 资源导航，无在线播放（cn-compliance 分支口径）。

## 一、现状盘点（已做对的）

| 项 | 状态 |
| --- | --- |
| SSR 直出 | 首页 `/` 与详情页 `/drama/[id]` 均为服务端组件 `force-dynamic`，剧名/简介/标签进 HTML 源码 |
| Metadata | `lib/seo.ts` 的 `createPageMetadata` 统一 title/description/canonical/OG/Twitter |
| Sitemap | `app/sitemap.ts` 动态生成（首页 + 全部 done 且有 `own_share_url` 的详情页，上限 5 万条） |
| robots | `/admin/`、`/api/`、`/login` 已屏蔽 |
| 404 | 详情页数据不合格走 `notFound()` 真 404，无软 404 |
| 结构化数据 | 全站 Organization + WebSite(SearchAction)；详情页 TVSeries + BreadcrumbList |
| PWA/分享 | manifest.ts、OG/Twitter 卡片齐备 |
| 图片 | 海报墙前 8 张 eager、其余 lazy，alt 用剧名 |

## 二、核心缺口（按影响排序）

1. **标签不是真实页面**：导航菜单、标签胶囊、详情页标签全部指向
   `/?tag=xx`，canonical 统一指回 `/` —— 品类词（霸总短剧、复仇短剧、
   战神短剧……）是短剧站最大的长尾流量来源，当前等于整个放弃。
2. **列表仅第一页可被收录**：首页翻页是客户端 `loadMore`，蜘蛛看不到
   第 2 页以后的任何剧，也没有分页内链。
3. **详情页内链单薄**：只有「首页 + 标签」，没有相关推荐，蜘蛛纵深与
   权重流转弱。
4. **无主动收录管道**：新剧发布只靠蜘蛛自然发现，没有百度 API 推送 /
   IndexNow。
5. **薄内容与重复文案风险**：intro 缺失时详情页 description 落到全站
   同一句模板（`《X》短剧全集资源导航…`），批量化后是百度清风算法重点
   打击形态；scraped intro 直接搬运是采集风险。
6. **性能**：全站 `force-dynamic`，TTFB 随 Mongo 波动；sitemap 每次请求
   全量查库；封面 `<img>` 无 width/height（CLS 风险）。
7. **lighthouserc.cjs 失效**：routes 还是旧 douban 站的
   `/browse/movies` 等，CI 监控的是不存在路由。
8. **多语言半做**：metadata 声明 `alternateLocale: en_US`，但无英文路由
   与内容；`<html lang>` 跟 cookie 走（爬虫恒拿 zh-CN，这没问题）。

## 三、关键词与内容策略

三层关键词矩阵，对应三类落地页：

| 层 | 词形 | 落地页 | 示例 |
| --- | --- | --- | --- |
| 品牌 | 站名 | `/` | 爱盼短剧、爱盼短剧官网 |
| 品类（最大机会） | 标签+短剧 | **标签落地页（待建）** | 霸总短剧、复仇短剧、逆袭短剧、甜宠短剧、短剧推荐 |
| 剧名长尾（量最大） | 剧名+全集/资源/怎么看的 | `/drama/[id]` | 「XX」短剧全集哪里看 |

剧名词量大但单词条流量小、几乎必然被收（剧名独占性强）；品类词
竞争高但稳定。内容策略上：

- 详情页 title/description 优先用 scraped intro 与 metadata 字段
  （演员/年份/地区/类型）拼装，**避免全站同一模板句**；
- 标签落地页需配 1–2 句人工/模板化的品类引导文案 + 剧量，避免纯列表
  doorway 形态；
- 剧量少于阈值（建议 5）的标签不做索引页（见下）。

## 四、P0：信息架构改造

### 4.1 标签落地页 `/tags/[slug]`（本方案最大单项）

- 新路由 `app/tags/[slug]/page.tsx`：SSR 直出该标签下短剧列表
  （复用 `listShortDramas({ tag })`）；`generateMetadata` 产出独立
  title/canonical（`/tags/xxx`），不再 canonical 回首页；
- 标签目录页 `app/tags/page.tsx`：按现有分组（女性/男性/场景职业/爽设）
  展示全部标签入口（数据来自 `/api/short-dramas/tags` 同源的
  `listShortDramaTagCounts`）；
- slug 约定：标签中文名直接 encodeURIComponent 进 URL（百度对中文
  URL 友好），如 `/tags/霸总`；保持与 `?tag=` 参数同名，服务端同一取数
  函数；
- **索引门槛**：count < 5 的标签页 `noindex, follow`（title 照常给），
  防止批量薄页面触发清风/飓风算法；目录页只内链 count ≥ 5 的标签；
- sitemap 加入 count ≥ 5 的标签页；
- 面包屑升级为三级：首页 > 标签 > 剧名（详情页 JSON-LD 与可见面包屑
  同步）；
- 首页/导航/详情页所有标签内链从 `/?tag=` 切到 `/tags/[slug]`
  （`Navbar.tsx:67` 的 `TAGS_HREF`、`HomePageClient.tsx:191` 的
  `TagChipPill`、`DramaDetailView.tsx:133`）。
- `/?tag=` 旧入口保留：301 到对应 `/tags/` 页（或保持 canonical 指向
  `/tags/`，二选一，301 更干净）。

### 4.2 列表分页 SSR 化

- 标签页分页：`/tags/[slug]?page=n`，第 1 页 canonical 指自身、后续页
  canonical 指自身（self-canonical 即可），并输出
  `<link rel="prev/next">`（Next `alternates.previous/next`）；
- 首页长尾补一个「全部短剧」SSR 分页索引 `/all/page/[n]`（每页 50，
  纯静态链接网格），让蜘蛛两三跳内可达全部详情页；首页继续保留
  客户端 loadMore 的浏览体验不变。

### 4.3 详情页「相关短剧」

- 详情页服务端取同标签 6–8 部（排除自身），SSR 直出卡片 + 站内链接；
- 即补内链又稀释薄内容占比。

## 五、P0：收录与提交管道

1. **站长平台**（一次性）：
   - Google Search Console：验证 aipan.me + 提交 `/sitemap.xml`；
   - 百度搜索资源平台：验证站点、提交 sitemap、申请普通收录 API；
   - Bing Webmaster：可直接从 GSC 导入。
2. **发布时主动推送钩子**：在后台转存完成/发布成功的 API
   （`app/api/admin/short-dramas` 任务流，状态变 done 处）加推送：
   - 百度普通收录 API（POST token 接口）；
   - IndexNow（Bing/Yandex）：站点放 `{key}.txt` 验证文件，发布时 POST
     单条 URL；
   - 失败只记日志不阻塞任务；单次批量发布限速（百度 API 日配额）。
3. **sitemap 增强**：
   - `lastModified` 兜底：`updated_at` 缺失时用 `publish_date`；
   - 给 sitemap 查询加缓存（`revalidate = 3600` 或内存缓存），防每次
     爬取打库；量超 5 万再上 `generateSitemaps` 分片；
   - 下架剧自动从 sitemap 消失（查询条件已保证 done + own_share_url）✓。
4. **robots 微调**：现有 disallow `/search` 是无效路径（搜索是
   `/?search=`）；`?search=` 变体靠 canonical → `/` 已够，再加一层
   保险：`generateMetadata` 里 search 词存在时 `robots: noindex,
   follow`。`host` 指令是 Yandex 的，无害可留。

## 六、P1：On-page 与结构化数据

- **JSON-LD 增强**：详情页 TVSeries 补 `actor`/`datePublished`/
  `countryOfOrigin`（metadata 有则填）；首页加 `CollectionPage` +
  `ItemList`（首屏 20 部，position + url）。**不加** AggregateRating
  （无真实评分，属虚假标记）、**不加** VideoObject（无播放）。
- **标题模板**（差异化，勿堆「网盘」词）：
  - 标签页：`{标签}短剧大全｜{N}部推荐 - 爱盼短剧`
  - 详情页：`{剧名}（全{N}集）｜剧情简介与全集资源 - 爱盼短剧`
- **正文独特性**：详情页把 metadata 字段（演员/年份/地区/类型）渲染成
  信息表，description 优先 intro 截断（现状 120 字符，可到 160），
  intro 缺失才落到模板句；
- **图片 SEO**：封面 `<img>` 补 `width/height`（或外层 aspect-ratio
  容器）消 CLS；R2 镜像路径与文件名尽量可读（`/{剧名拼音}.webp`）。
  robots 确认封面代理路径未被 disallow（当前 `/api/` 下需确认封面走
  哪条路径——若在 `/api/` 下则百度抓不了图，需挪到公开路径）。
- **OG 品牌图**：当前 OG image 用 `/logo.png`，做一张 1200×630 品牌图
  替换，提升分享与搜索缩略图观感。

## 七、P1：性能与 CWV

- **公开页缓存化**：详情页改 ISR（`revalidate = 600`）或
  `unstable_cache` 包 `getShortDramaById` + 发布/编辑时
  `revalidatePath`；首页列表 ISR 60–300 秒。目标 TTFB < 600ms；
- sitemap 与 tags API 加同样缓存；
- **修正 lighthouserc.cjs**：routes 改为 `/`、`/?tag=霸总`、抽样
  `/drama/{id}`（构建后注入一个真实 id），CI 才能盯住真实页面；
- 加 `web-vitals` → GA4 事件上报，用 field data 盯 LCP/CLS/INP；
- `<html lang>` 跟 cookie 走可接受（爬虫恒 zh-CN），保持现状。

## 八、P2：多语言与站外

- **多语言决策**：删掉 `alternateLocale: ["en_US"]` 声明（现状是半做，
  声明了却无英文页面）；真做英文版时再上 `/en/` 路由 + hreflang
  一套完整方案，不要中间态。
- **search.aipan.me** 子域与主站的内容边界要想清楚：若内容同源，避免
  互相镜像造成重复内容；独立产品则互链即可。
- **站外**：品牌词保护（百度/Google 各验证域名）；短剧类导航站/聚合站
  互换收录；TG/小红书等社媒引流（导流落地页用首页或标签页，不要用
  详情页直链网盘）。

## 九、合规与风险（百度算法视角）

1. **采集风险**：全站内容来自 duanjugou 抓取。飓风算法打击纯采集，
   缓解：description/正文用字段拼装差异化、发布节奏限速（新站先小
   批量让蜘蛛建立信任，勿一次性灌全量）、详情页保持「资源状态 + 元
   数据」信息增量；
2. **网盘词堆砌**：title/描述不要每条都堆「夸克网盘」「百度网盘」，
   资源信息放在正文结构化区块里自然呈现；
3. **门页/跳转形态**：详情页保持信息密度（简介、元数据、相关推荐、
   标签），不要做成「标题 + 跳转按钮」的空壳；
4. **sitemap/robots 与封面代理路径**：上线前核对封面图 URL 路径未被
   robots 误封，图片搜索是短剧封面的可观增量入口。

## 十、里程碑与度量

### 里程碑

| 阶段 | 内容 |
| --- | --- |
| P0（1–2 周） | 标签落地页 + 目录页、详情页相关推荐、站长平台接入 + 推送钩子、sitemap 缓存与 lastModified 兜底 |
| P1（2–4 周） | 分页 SSR 化、公开页缓存化（CWV）、JSON-LD 增强、文案差异化、图片 CLS、lighthouse 修正 |
| P2（长期） | 多语言决策、站外与品牌、内容丰富度迭代 |

### 实施状态（2026-09-02）

P0 已全部落地（本地 dev 冒烟 + `tsc` + `eslint` 通过）：

- ✅ 标签落地页 `/tags/[tag]`（`app/tags/[tag]/page.tsx`，count ≥ 5 可收录、
  低于门槛 noindex follow、SSR 分页 self-canonical + prev/next）+ 目录页
  `/tags`（只内链达标标签）；未收录标签词真 404
- ✅ 内链全量切换：Navbar/HomePageClient/DramaDetailView 均走
  `tagPath()`；`/?tag=` 经 `proxy.ts` 301 到 `/tags/[tag]`（search 词
  优先保留在首页）
- ✅ 详情页「相关短剧」（`listRelatedShortDramas`，同标签 8 部 SSR）+
  BreadcrumbList 三级（首页 > 标签 > 剧名）
- ✅ sitemap：`/tags` + 达标标签页入图；robots：查询串变体
  （`?tag=`/`?search=`）disallow；首页带筛选词变体 noindex
- ✅ 推送钩子：`lib/seo-push.ts`（百度普通收录 API + IndexNow，任务级
  缓冲批量、失败不影响流水线）挂 `transferOne` 成功落库处；校验文件
  `/indexnow-key.txt`；env 见 `.env.example`（`BAIDU_PUSH_TOKEN` /
  `INDEXNOW_KEY`）
- ✅ lighthouserc routes 修正为真实页面；详情 description 放宽到 160 字

P1 已全部落地（本地 dev 冒烟 + 浏览器 GUI 交互验证 + `tsc` + `eslint` 通过）：

- ✅ 公开页缓存化：`lib/cache.ts` 进程内 TTL 缓存（ISR 被根布局
  `cookies()` 阻塞，生产单容器下进程内缓存等价生效）。`lib/short-drama-db.ts`
  四个公开读（详情/标签聚合/相关推荐/sitemap 条目）走 `cachedRead`
  （详情/标签/相关 5 分钟，sitemap 30 分钟），四个写路径
  （upsert/追加标签/删除/转存回写）`bumpShortDramaCache()` 即时失效；
  带惊群合并与容量逐出。后台口径 `listShortDramaTagCounts` 不缓存
- ✅ 全部短剧 SSR 分页索引：`/all` 308 → `/all/page/1`；每页 50
  （`ALL_PAGE_SIZE`），公开口径 `hasOwnShareUrl` 与 sitemap 同源，
  总页数一致；self-canonical + pagination prev/next（Next 16 需顶层
  `pagination` 键，`alternates.previous/next` 已不输出 link）；超页真 404
- ✅ sitemap 增补 `/all/page/1..N`（priority 0.8 daily）；详情 lastModified
  兜底 `publish_date`
- ✅ 首页 CollectionPage + ItemList JSON-LD（仅默认可索引变体、无错误时）；
  详情页 TVSeries `actor`（`parseDramaInfo` metadata/简介兜底，
  源站「A / B / C」同行多人按 / 拆分，截断 10 人）
- ✅ P2 顺手：`app/layout.tsx` 删除 `alternateLocale: ["en_US"]`
- ✅ 修复存量 bug：`app/page.tsx` 从 `"use client"` 模块导入 `PAGE_SIZE`
  运行时值，RSC 下拿到 client-reference 代理 → 算术 NaN → SSR 无限拉全量
  （270 条）且 `limit: NaN`。常量迁至 `lib/seo.ts` 的 `HOME_PAGE_SIZE`
- ✅ 首页标题品牌前置（用户确认）：`爱盼短剧｜精选短剧合集`。发现根路由
  不吃根布局 `title.template`（Next 跳过同层 leaf layout/page 的模板收集，
  /all、/tags、/drama 均正常带后缀，唯独 `/` 没有）→ `createPageMetadata`
  新增 `absoluteTitle` 开关，首页默认/搜索/标签兜底三变体全部品牌前置；
  首页 sr-only h1 与 CollectionPage JSON-LD name 同步
- ✅ 首页分页改版（用户指定交互）：底部「加载更多 ∨」+ 数字分页选择器
  （`components/home/PaginationNav`，1 … N 上一页/下一页，跳页替换列表
  并回顶部）+「滚动到底部时自动加载更多」开关（localStorage 持久化，
  默认关；开启后滚动近底部 800px 内自动追加）。`/all` 与 `/tags/[tag]`
  分页换用同组件的链接形态（SSR 可爬，第 2 页折叠回基础路径）

- ❌ **未做（P2 起）**：OG 品牌图 1200×630（需设计产出，注意 CJK 字体）、
  多语言决策、站外与品牌
- ⚠️ 站长平台账号验证（GSC/百度/Bing）与推送 token 配置需要人工操作；
  部署后需确认 `NEXT_PUBLIC_SITE_URL` 与线上域名一致

### 度量基线

- **GSC**：已提交 vs 已收录页面数、剧名词/标签词/品牌词曝光点击占比、
  详情页收录率（核心北极星）；
- **百度资源平台**：索引量曲线、抓取频次、异常页面数；
- **CWV**：CrUX field data + CI Lighthouse（修正后的 routes）；
- **GA4**：自然搜索会话占比、落地页分布（详情页 vs 标签页）。
