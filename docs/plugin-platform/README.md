# Kerkerker 插件平台架构基线

本文是 Kerkerker 插件化改造的架构基线。后续涉及内容数据、播放资源、网盘资源、弹幕、图片、搜索和推荐的设计与代码评审，均以本文和[插件开发标准](./development-standard.md)为准。产品阶段、依赖和发布闸门见[产品开发总计划](../product-development-plan.md)。

> 当前代码尚未完全实现本文的目标架构。现有系统仍以 `douban_id`、`kkpan` 专用字段和专用路由为主；迁移期间必须保持现有业务可用，并通过兼容层逐步切换，不能把目标设计描述成已经上线的行为。

## 目标与原则

Kerkerker 的长期定位是一个可组合的影视内容宿主，而不是绑定某个数据源或资源来源的聚合站。核心原则是“万物皆插件”：任何外部能力都通过公开契约接入，宿主只保留稳定且与供应商无关的平台能力。

### 架构决策

| 决策 | 基线要求 | 原因 |
| --- | --- | --- |
| 宿主、契约、插件分离 | 主应用、公共契约/SDK、具体插件分别维护和发布 | 保持开源宿主干净，允许插件独立授权、私有化和升级 |
| 能力而非供应商建模 | 核心代码只认识 `content`、`resource.playback` 等能力 | 新增或替换供应商时无需修改核心业务 |
| v1 可信静态注册 | 插件随构建或部署配置注册，不支持后台上传和执行代码 | 限制远程代码执行、供应链和审计风险 |
| 宿主拥有数据 | 插件返回标准 DTO，不直接访问宿主 MongoDB | 保证迁移、去重、审计和权限规则一致 |
| 平台主键独立 | 所有下游数据关联宿主生成的 `content_id` | 避免被豆瓣、TMDB 或任一外部 ID 锁定 |
| 运行画像显式化 | 每次调用带 `locale`、`region` 和 `profile` | 支持中文站、英文站及地区合规差异 |
| 调度与审计集中 | 同步、重试、进度、日志和审计由宿主统一执行 | 插件可替换，运行记录仍连续可追溯 |
| 合规默认拒绝 | 未声明来源、权限、网络目标或数据用途的插件不得启用 | 让可追溯与最小权限成为默认行为 |

### 平台不负责的事项

- 插件体系不能证明某个外部数据源或资源本身合法；运营方仍需核验授权、许可、服务条款和适用地区。
- v1 不提供插件市场、运行时下载、热加载、用户上传脚本或不可信代码沙箱。
- 插件不得绕过宿主直接向页面写入供应商私有数据结构，也不得把数据库集合当作插件 API。
- 插件私有仓库不等于秘密安全。密钥必须由部署环境注入；打入公开镜像或发送到浏览器的代码仍可能被分析。

## 系统边界

### 总体架构

```mermaid
flowchart LR
  subgraph clients["使用端"]
    web["前台 Web"]
    admin["管理后台"]
    api_client["外部 API 客户端"]
  end

  subgraph host["Kerkerker Host"]
    routes["通用 API 与页面"]
    orchestrator["能力编排器"]
    registry["可信插件注册中心"]
    identity["内容身份与外部 ID 映射"]
    policy["权限与合规策略"]
    runtime["配置、缓存与运行画像"]
    scheduler["调度、租约与重试"]
    observability["日志、指标与审计"]
    store[("宿主持久化")]
  end

  contract["公共 Contract / SDK"]

  subgraph plugins["具体插件"]
    inproc["可信进程内插件"]
    sidecar["私有远程 Sidecar"]
  end

  upstream["获授权的外部服务"]

  web --> routes
  admin --> routes
  api_client --> routes
  routes --> orchestrator
  orchestrator --> registry
  orchestrator --> identity
  orchestrator --> policy
  orchestrator --> runtime
  scheduler --> orchestrator
  orchestrator --> store
  orchestrator --> observability
  registry --> inproc
  registry --> sidecar
  contract -. "约束" .-> host
  contract -. "约束" .-> plugins
  inproc --> upstream
  sidecar --> upstream
```

宿主是唯一面向页面和公共 API 的系统边界。调用方选择的是业务能力和运行画像，不直接依赖具体插件；插件优先级、回退和合并策略由宿主配置。

### 项目与发布边界

| 单元 | 目标职责 | 公开策略 | 发布方式 |
| --- | --- | --- | --- |
| `kerkerker` | Next.js 宿主、统一模型、API、后台、调度和审计 | 可公开 | 主应用镜像 |
| `kerkerker-plugin-contract` | Manifest、能力接口、DTO、错误码、兼容性测试包 | 应公开 | 独立 SemVer 包 |
| `kerkerker-plugin-*` | 某一供应商或业务能力的适配实现 | 按授权选择公开或私有 | 独立包或 Sidecar 镜像 |
| `kerkerker-douban-service` | 当前豆瓣内容服务和缓存实现 | 现有独立项目 | 作为 `content` 插件的上游服务 |

当前宿主兼容导出仍位于 [`lib/plugins/types.ts`](../../lib/plugins/types.ts)、[`lib/plugins/validation.ts`](../../lib/plugins/validation.ts) 和 [`lib/plugins/errors.ts`](../../lib/plugins/errors.ts)；可发布的 v1 契约包已位于 [`packages/kerkerker-plugin-contract/`](../../packages/kerkerker-plugin-contract/)，并由 CI 执行独立类型检查和契约测试。参考适配器可以暂时放在 [`lib/plugins/`](../../lib/plugins/) 内，以降低契约频繁调整的跨仓成本，但模块边界必须按未来可拆包设计：不能反向导入 `app/`、`components/` 或具体 MongoDB 集合。

当前分支已经落地第一批可运行地基：[`lib/plugins/registry.ts`](../../lib/plugins/registry.ts) 提供封存式静态注册，[`lib/plugins/runtime.ts`](../../lib/plugins/runtime.ts) 提供按能力和操作的统一服务端调用边界，Douban、TMDB 与 KKPAN 适配器分别位于 [`lib/plugins/adapters/douban-content.ts`](../../lib/plugins/adapters/douban-content.ts)、[`lib/plugins/adapters/tmdb-content.ts`](../../lib/plugins/adapters/tmdb-content.ts) 和 [`lib/plugins/adapters/kkpan-cloud-drive.ts`](../../lib/plugins/adapters/kkpan-cloud-drive.ts)。管理端只能通过受保护的 [`GET /api/plugins`](../../app/api/plugins/route.ts) 查看已注册的非秘密 Manifest 元数据；该接口不支持上传、动态加载或任意插件执行。

静态注册不等于默认可用。宿主在 [`plugin_installations`](../../lib/constants/db.ts) 中为每个注册插件保存独立的安装生命周期：`available -> installed -> enabled`，也支持 `disabled`、`failed` 和卸载回到 `available`。管理员通过受保护的 [`/api/plugins/installations`](../../app/api/plugins/installations/route.ts) 在后台插件中心手动安装、启用、停用或卸载；安装记录只引用已经锁定的静态插件版本，不保存代码、模块路径或管理员提供的可执行内容。生产运行时统一调用 [`requireUsable`](../../lib/plugins/installation.ts)，未安装或未启用的插件不能被 API、任务、回源或公开资源读取使用。

卸载或停用插件不会删除影片、网盘资源、图片镜像、同步记录和审计记录；这些数据保留用于审计、迁移和重新安装。来源插件不可用时，公开资源读取会隐藏对应来源，管理员仍可以查看历史记录并处理恢复。没有 MongoDB 的本地测试进程可以使用内存状态仓库；生产配置 MongoDB 但连接失败时必须 fail-closed。首次部署不会自动安装任何插件，管理员需要先安装并启用所需的 Douban、KKPAN 或 TMDB 插件。

兼容的 [`GET /api/kkpan/search`](../../app/api/kkpan/search/route.ts) 已经改为通过 `cn-default` 画像调用 `resource.cloud-drive.search`，旧响应字段保留，后台无需一次性改版。宿主会创建带超时和取消信号的 `PluginContext`，并在返回前校验来源插件、资源 ID 和网盘品牌。需要原始页指纹、跨页唯一 ID 和漂移校验的全量增量/失效任务仍暂留在同步兼容层；只有当插件契约提供等价的快照或稳定游标保证后，才允许迁移到通用分页调用。

第二阶段已加入 [`lib/plugins/profiles.ts`](../../lib/plugins/profiles.ts) 的静态发布画像注册：画像固定 `locale`、`region` 和按能力排列的插件优先级，启动时校验插件是否声明该能力并支持该语言/地区；`cn-default` 绑定 Douban 内容与 KKPAN 网盘，`en-default` 的 catalog、calendar、detail、search 和 image 已绑定 TMDB，不复制页面代码，也不会回退到 Douban。运行时通过 `invokeProfilePlugin` 解析画像后再调用插件，未配置能力会返回 `CAPABILITY_UNAVAILABLE`，不会静默选择其他供应商。

宿主运行配置由 [`lib/plugins/invocation.ts`](../../lib/plugins/invocation.ts) 集中注入并按 Manifest 的必填字段、URL 类型和精确网络主机权限校验；API 路由和后台任务不得自行读取供应商环境变量。服务端页面之外的目录发现、搜索和日历任务统一通过 [`lib/plugins/content-host.ts`](../../lib/plugins/content-host.ts) 调用活动画像，`run_id`、超时和取消信号沿同一上下文传播，不通过内部 HTTP 绕回 API 路由。

生产部署通过 `KERKERKER_PLUGIN_PROFILE` 选择活动画像（默认 `cn-default`），通过 `KERKERKER_PLUGIN_REGION` 选择策略区域（默认 `CN`）。前台语言切换将 allowlist 内的 `kk_locale` Cookie 映射为 `zh-CN -> cn-default` 或 `en-US -> en-default`，不会接受任意 profile 查询参数；没有 Cookie 时仍使用部署默认画像。合规门禁由 `KERKERKER_COMPLIANCE_MODE` 控制：迁移期使用 `audit` 记录缺失审批但保持兼容调用，完成策略登记后切换为 `enforce`；下架记录在两种模式下都立即阻断公开读取和插件回源。画像、区域和合规模式都不是公开请求参数；同一镜像在中文部署和英文部署中只需改变部署环境与画像配置，页面和宿主 DTO 保持不变。

### 多语言 URL 与 SEO 基线

Cookie 只用于记住用户偏好，不是可索引的语言标识。长期 SEO 方案必须为每个可索引页面提供稳定的语言路径，例如 `/zh-cn/` 与 `/en-us/`，并保留页面内容、标题、结构化数据和链接的完整翻译；不能仅通过 Cookie、`Accept-Language` 或客户端状态改变同一个 URL 的正文。Google 的[多语言站点指南](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)明确推荐为不同语言使用不同 URL，并用 `hreflang` 互相声明版本。

路径迁移按以下规则执行：

1. 先让 `/zh-cn/<path>` 和 `/en-us/<path>` 同时可访问，旧的无前缀 URL 保持兼容并返回 308 到默认中文版本；API 路径不加语言前缀，语言通过受信任的路径上下文注入请求画像。
2. 每个语言页面使用自指 `canonical`，并输出指向自身、其它语言版本和 `x-default` 的完整双向 `hreflang` 集合；语言切换使用普通链接，不根据 IP 或浏览器语言自动重定向。
3. 更新站点地图、内部链接、分享链接和详情页稳定 ID 后，再逐步收紧旧 URL 的重定向与索引策略。迁移完成前，Cookie 语言切换只改变当前会话，不声称已经提供可索引的英文 URL。

这套路径规范是后续路由迁移和 SEO 验收标准；本阶段先修复插件不可用时的前台错误提示，避免在未完成全部页面迁移时产生半套语言 URL。

宿主身份层位于 [`lib/content-identity-db.ts`](../../lib/content-identity-db.ts)，集合为 `content_identities`。它只接受精确的 `(provider_id, external_id)` 引用，以宿主 UUID 生成不可变 `content_id`；同一请求发现引用指向多个身份时会报冲突，禁止标题模糊合并。网盘资源和影片同步台账在迁移期双写 `content_id` 与旧 `douban_id`，旧 API 仍保持兼容。

通用作业的管理员查询入口为 `GET /api/plugins/jobs`。它只查询已写入 `plugin_jobs` 的通用作业，支持 `status`、`run_id` 和 `limit`，响应明确标记 `writable=false`；单次运行的持久事件时间线通过 `GET /api/plugins/jobs/events?run_id=<run_id>` 查询，支持 `after_sequence` 和 `limit` 正向分页，即使当前已到末尾也返回可继续轮询的序号。通用宿主任务的生命周期操作使用受保护的 `POST /api/plugins/jobs/<run_id>`，请求体只接受 `{ "action": "cancel" | "retry", "reason"? }`：取消仅允许排队/运行/退避中的 host 任务，重试仅允许未取消的 `failed`/`partial` 任务；每次成功变更都会写入 `plugin.job.cancel` 或 `plugin.job.retry` 审计事件。影子投影、`external-report` 和 `metadata.source=pan-scheduler` 的迁移任务会被拒绝，必须走各自的 fencing/迁移控制路径。所有入口都使用显式管理员 DTO，不返回幂等键、执行 cursor、自由 metadata、事件内容摘要、内部 outbox 或 TTL 字段。旧 Pan 调度的 `runs`/`plugin_runs` 仍由 `/api/pan-resources/scheduler` 提供，不能通过通用生命周期入口修改。

通用宿主执行器位于 [`lib/plugins/job-executor.ts`](../../lib/plugins/job-executor.ts)。它只接受构建期静态注册的 `job_id`，使用 `PluginJobRunner` 的原子领取、租约心跳、取消检查和 fencing 写入；心跳、进度、游标与终态更新在单次执行内串行化，租约失效会中止回调且不使用旧 token 写终态。执行器默认不启动，也不会领取未注册任务。

KKPAN 目录同步的统一任务身份已经固定为 `resource.cloud-drive.catalog-sync`。当前迁移开关 `PAN_SYNC_CATALOG_JOB_MODE` 默认是 `off`：`shadow` 会把通用任务的 `job_id`、派生 `run_id`、幂等键和调度窗口双写到旧 Pan 运行记录与 `plugin_jobs`，但影子记录带有 `host_claimable=false`，永远不会进入宿主领取队列；旧 Pan 仍是唯一执行真源。投影状态（`pending/succeeded/failed`、尝试次数和脱敏错误）持久化在旧运行记录，scheduler 会补偿进程崩溃或 Mongo 短暂失败造成的缺口。KKPAN handler 位于 [`lib/pan/host-job-handler.ts`](../../lib/pan/host-job-handler.ts)，目标 owner 使用 `generic_run_id:lease_fence`，并将进度游标和终态回写旧兼容投影；默认注册不启动 Mongo 回写，生产注册必须显式启用。

`cutover` 只有在旧 scheduler 已通过 `PAN_SYNC_SCHEDULER_DISABLED=true` 关闭后，才能由显式晋级函数校验旧任务仍为未开始的 queued shadow，并 CAS 晋级 generic 任务；普通重复入队不会隐式改变 `host_claimable`。Node instrumentation 仅在两个闸门同时满足时启动 [`lib/pan/host-executor-bootstrap.ts`](../../lib/pan/host-executor-bootstrap.ts)，否则继续使用旧 scheduler 或保持关闭，避免双执行源。

受控跨进程 worker 可通过 `POST /api/plugins/jobs/report` 写入 `kerkerker.plugin-job.v1` 事件。该入口使用独立、默认关闭的 `KERKERKER_JOB_REPORT_TOKEN`，并在新任务开始时校验插件已注册、版本精确匹配、画像存在且绑定该插件；已开始任务继续按持久化身份快照验收，避免宿主先升级时截断旧 worker 的终态。每个运行必须先发送 `sequence=0` 的 `started`，后续事件使用单调序号及确定性 `event_id=<run_id>:<sequence>`；宿主持久化最后序号和当前事件摘要，当前序号的精确重复返回相同快照，内容不同的当前序号、身份漂移、进度倒退和终态后的新事件均被拒绝。更旧序号在身份校验后作为无状态变化的 stale no-op 返回，不借迟到事件补写未曾确认的历史。事件顺序只由 `sequence` 决定，来源时间与宿主接收时间分别留存，因此 worker 时钟回拨不会阻塞后续事件。Mongo 写入使用 `revision` CAS，并发的相同事件会重新读取胜出快照，不能借共享 `run_id` 覆盖其他任务。

每条成功应用的事件还会以追加式收据写入 `plugin_job_events`，唯一键为 `event_id` 和 `(run_id, sequence)`，默认与运行快照一样保留 30 天。为兼容不支持事务的单机 Mongo，同一次 CAS 先把脱敏事件作为 `pending_event_receipt` outbox 与最新快照一起保存，再追加收据并清除 outbox；追加失败返回 `500`，outbox 会阻止下一序号越过缺口，精确重放或下一事件会先排空它。终态 worker 不再重试时，管理员时间线也会合并仍在快照中的 pending 收据，因此保留期内事件不会静默消失。自由错误文本在落库前会清理嵌入 URL/DSN 的 userinfo 和敏感参数、Bearer/Basic、JWT 及常见密钥赋值；错误码不符合标准标识符时只保存 `UNCLASSIFIED_ERROR`。时间线不主动回填本能力上线前的旧运行。

当前写入协议用于把 Go 刷新进度纳入统一可见性，不等于 worker 已由宿主租约驱动：宿主尚不能通过该入口取消 Go 进程或恢复其中断水位。worker 可选用本地 0600 JSONL 持久 spool，HTTP 失败事件会在重启后按序重放。生产只有在 Web 与 worker 配置同一独立密钥并显式设置 worker 上报模式后才启用；在引入第三方插件前，共享服务密钥必须升级为按插件作用域的凭据。

身份迁移前先运行 `npm run content-identity:audit -- --json`。该命令只读取 `content_identities`、`pan_resources` 和 `pan_sync_targets`，不创建索引、不生成 UUID、不写入数据；退出码 2 表示发现必须人工处理的身份或来源冲突。缺失 `content_id` 且能由唯一 Douban 引用推断的记录只计入待回填，不会被审计命令自动修复；写入仍须使用 `scripts/content-identity-backfill.ts --apply --maintenance` 的停写流程。

管理员也可以通过受保护的 `GET /api/plugins/identity-audit` 查看同一份只读快照。接口支持 `limit`（默认 100，最多 200）和 `conflicts_only=true`，只返回受限的冲突明细，同时保留完整计数、待回填数量和截断标记；鉴权失败或数据库读取失败不会返回身份数据。该接口与 CLI 共用 `skipInitialization` 的读取层，不会因为查看审计而创建索引或修改记录。

私有插件有两种受支持的交付形式：

1. 私有仓库构建受控插件包，并在私有部署流水线中与宿主组合成最终镜像。最终镜像也必须保持私有。
2. 私有仓库部署独立 Sidecar，宿主只通过版本化 HTTP 契约访问。Sidecar 使用服务间认证、出站白名单和独立密钥，适合需要隐藏实现、跨语言或独立扩缩容的插件。

两种形式都属于可信静态注册：插件 ID、版本、端点和启用状态在部署时确定；管理后台只能修改经过 Manifest 声明的配置，不能上传代码或任意指定可执行文件。

当前宿主已实现 Sidecar v1 的受控调用：仅允许 HTTPS 入口，入口主机必须同时出现在 Manifest 的精确 `permissions.networkHosts` 白名单中；请求带有受控上下文、请求 ID、取消信号和契约版本，响应有 1 MiB 默认大小上限。Manifest 可声明健康检查、协议版本协商和宿主注入的服务认证密钥。画像回退只允许在明确的上游错误时发生，合规、配置、取消和执行错误不会被回退吞掉。宿主还会在进程内对连续上游失败熔断，冷却后只放行一个恢复探测；跨实例的健康状态仍由部署层和外部监控负责。

### 宿主与插件职责

| 宿主负责 | 插件负责 |
| --- | --- |
| `content_id` 分配、外部 ID 映射、去重和合并 | 调用获授权的上游并返回标准候选数据 |
| 认证、授权、配置解密和密钥注入 | 声明所需配置、密钥和网络权限 |
| 路由、缓存、持久化、限流、超时和取消 | 遵守超时信号，转换上游错误和分页游标 |
| 插件选择、优先级、回退和结果合并 | 实现声明的能力，不伪报未实现能力 |
| 调度、租约、幂等、重试、进度和运行日志 | 提供可重复执行的任务入口和稳定外部 ID |
| 来源追踪、内容策略、下架和审计 | 返回来源、抓取时间、许可元数据和可验证依据 |
| 面向前台的稳定 DTO | 不泄露上游私有响应、密钥或内部异常堆栈 |

### 插件配置与密钥边界

插件 Manifest 只声明配置 schema 和所需 secret 名称，不保存任何密钥值。配置的责任边界必须按插件划分：

| 配置内容 | 归属 | 宿主行为 |
| --- | --- | --- |
| 上游地址、区域、分页和功能开关 | 插件配置 | 按 Manifest 校验后注入插件上下文 |
| API Key、Bearer Token、服务账号 | 插件运行时或插件 Sidecar | 只在服务端注入，禁止进入浏览器、日志、Mongo 普通 DTO 和公开 API |
| 插件版本、安装/启用状态、配置版本 | 宿主控制面 | 持久化、审计、轮换和回滚，不读取或展示 secret 明文 |
| 业务页面、宿主 `content_id`、资源和审计数据 | 宿主 | 插件不能直接写宿主集合 |

因此，插件的“配置跟着插件走”不等于插件可以把密钥写进公开仓库或前端；它表示插件声明自己需要什么，插件运行环境拥有这些值，宿主只负责安全编排和门禁。新增插件不得在 `app/`、页面 Hook 或部署脚本中再增加供应商专用环境变量。

#### TMDB 迁移说明

`kerkerker-douban-service` 当前确实读取服务器侧的 `TMDB_API_KEY`，并用于 Go 服务内部的 Hero、日历和图片同步。该环境变量属于 Go 服务进程，Web Docker 容器无法直接读取；把它误写成 Web 的 `DEPLOY_TMDB_API_KEY` 会产生第二份密钥配置，也不是插件边界。

当前 Web 内置 `kerkerker.tmdb-content` 直接访问 `api.themoviedb.org` 的实现属于迁移态兼容层，不能作为最终架构。正式实现必须二选一：

1. **独立 TMDB 插件/Sidecar（推荐）**：TMDB Key 只注入 TMDB 插件或 Sidecar；Web 宿主只保存插件版本、启用状态和经过校验的 Sidecar 地址/服务凭据。
2. **服务承载插件**：由 `kerkerker-douban-service` 暴露版本化、非通用代理的 TMDB 能力接口，Web 的 TMDB 适配器只调用该接口；TMDB Key 仍只存在 Go 服务，Web 只配置服务地址和独立的服务间认证。

迁移完成前，不得通过读取另一个容器的 `.env`、共享宿主文件或把 TMDB Key 返回给 Web 来“自动发现”配置。部署验收必须同时检查：插件 Manifest 配置字段、配置版本、密钥注入位置、安装/启用状态和轮换回滚记录。

## 公共契约

### 能力分类

能力类别是稳定的业务边界，不使用供应商名称。v1 可以在类别下细分协议 ID；一个插件可以声明多个能力，但实现和测试必须按能力隔离。

| 能力类别 | v1 协议 ID | 责任 | 标准输出 |
| --- | --- | --- | --- |
| `content` | `content.catalog`、`content.calendar`、`content.detail` | 影片、剧集、季、集、人物、分类和详情元数据 | 内容候选、详情、分页列表 |
| `resource.playback` | `resource.playback` | 可播放媒体、清晰度、字幕和时效信息 | 规范化播放资源列表 |
| `resource.cloud-drive` | `resource.cloud-drive` | 网盘分享、提取码、格式、容量和可用状态 | 规范化网盘资源列表 |
| `danmu` | `interaction.danmu` | 弹幕检索、拉取和时间轴映射 | 规范化弹幕事件 |
| `image` | `asset.image` | 海报、背景、剧照、头像和镜像 | 带来源和尺寸的图片候选 |
| `search` | `content.search` | 内容或资源查询和建议 | 带类型和来源的搜索结果 |
| `recommendation` | `recommendation` | 相似内容、榜单和个性化候选 | 可解释的内容引用列表 |

`resource.playback` 与 `resource.cloud-drive` 共享资源基础字段，但不能合并成模糊的 `resource` 实现。两者的权限、可用性检测、展示方式和合规策略不同，必须独立声明和调度。
v1 的 `content.search` 是第一种搜索协议；以后增加跨域资源搜索时，必须新增兼容的分层 ID，而不是把供应商名称塞进 `search`。

### Manifest 与版本

每个插件必须提供机器可读 Manifest，至少声明：

下面的 TypeScript 片段使用公共契约包提供的 `PluginConfigFieldSummary` 类型；字段是 v1 的最小集合。

```typescript
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  contractVersion: string;
  runtime: { mode: "built-in" | "package" | "remote"; entry: string };
  capabilities: Array<{ id: string; version: string; features?: string[] }>;
  locales: string[];
  config: { version: string; fields: PluginConfigFieldSummary[] };
  compliance: {
    legalBasis: string;
    termsUrl?: string;
    contentScope: string | string[];
    regions: string[];
    dataClassification: string;
  };
  permissions: {
    networkHosts: string[];
    secrets: string[];
    storage: "none" | "ephemeral" | "namespaced" | "persistent";
  };
}
```

- `id` 是全局稳定的小写反向域名或命名空间 ID，发布后不得复用给另一实现。
- `version` 遵循完整 SemVer，描述插件实现版本；`contractVersion` 使用 `major.minor` 或 `major.minor.patch`，描述公共契约版本。
- 能力版本独立声明，使宿主可以逐项检查兼容性。
- Manifest 只描述配置结构，不包含配置值或密钥。
- `runtime.mode` 只允许可信内置、受控包或远程 Sidecar；`entry` 由部署制品提供，不能来自管理员输入。
- `compliance` 描述法律依据、内容范围、地区和数据分类；宿主启动时校验 ID 唯一性、版本范围、能力实现、配置完整性和权限声明，任一关键检查失败即拒绝启用。

详细字段、错误语义和评审规则见[插件开发标准](./development-standard.md)。

### 内容身份模型

`content_id` 是宿主生成的不可变字符串 ID，v1 使用 UUID。任何供应商 ID 都只能作为外部引用，不能作为表关联键或路由层的永久主键。内容目录和资源增量发现阶段可以暂时没有 `content_id`；候选进入宿主身份解析后，必须在落库前完成归属，不能用供应商 ID 代替。当前 KKPAN 自动入库和管理员资源写入都会先解析豆瓣外部引用并补齐 `content_id`。

公共 TypeScript DTO 使用 camelCase（`contentId`、`providerId`、`externalId`）；MongoDB 等持久层可以在 repository 边界映射为 snake_case（`content_id`、`provider_id`、`external_id`），两者不能在同一契约层混用。

```typescript
interface ExternalReference {
  providerId: string;
  externalId: string;
  canonicalUrl?: string;
  verifiedAt?: string;
}

interface ContentIdentity {
  contentId: string;
  contentType: "movie" | "series" | "season" | "episode" | "person";
  externalRefs: ExternalReference[];
  createdAt: string;
  updatedAt: string;
}
```

身份解析遵循以下规则：

1. `(provider_id, external_id)` 在平台内唯一，先通过精确外部引用查找 `content_id`。
2. 同一插件重放数据必须命中原 `content_id`，不得生成重复内容。
3. 跨供应商的自动合并只能使用可解释的强证据；标题相似只能产生待审候选，不能直接合并。
4. 合并必须保留别名、原外部引用、操作者、证据和时间，且支持审计回滚。
5. 网盘、播放、弹幕、图片和推荐记录只持久化 `content_id` 与自身 `provider_id/external_id`；`douban_id` 仅作为迁移期兼容字段。

跨来源的人工精确映射使用管理员接口
[`POST /api/plugins/identity-links`](../../app/api/plugins/identity-links/route.ts)：请求必须
携带已经存在的 `content_id`、已注册内容插件的 `provider_id/external_id`、操作理由和
`evidence_ref`。接口在 `enforce` 策略下执行来源审批，底层只做条件追加，不会因为
TMDB ID、标题或年份不匹配而创建新身份；外部引用已经属于其他 `content_id` 时返回
409 并保留冲突身份列表。重复提交同一引用是幂等读取，成功变更写入不可覆盖的
`content.identity.link` 审计事件。管理员可用
[`GET /api/plugins/identity-links?content_id=...`](../../app/api/plugins/identity-links/route.ts)
查看当前精确引用集合。

当前 [`types/pan-resource.ts`](../../types/pan-resource.ts) 仍保留必需的 `douban_id` 兼容字段，并将来源固定为 `manual | kkpan`；资源 API 已支持优先按 `content_id` 读取，详情页和旧查询仍以豆瓣 ID 兼容。来源插件的 `provider_id/provider_resource_id` 与旧 `kkpan_id` 一旦入库不可由普通编辑改绑，避免后续同步重新导入旧来源对象。以上均属于迁移对象。豆瓣服务已有的 `internal_id` 可作为 `provider_id=kerkerker.douban-service` 的外部引用或迁移映射依据，但不能成为全平台最终主键。

### 详情读取与身份写入边界

内容详情页通过宿主的 [`/api/content/detail/:externalId`](../../app/api/content/detail/[id]/route.ts) 调用当前发布画像绑定的 `content.detail` 插件。这个接口是公开的只读查询：它可以只携带精确的 `ExternalReference`，因为用户可能正在查看一个尚未写入宿主身份表的外部对象；它不得因此创建或猜测 `content_id`。插件返回的海报、评分、演职员、剧照、评论和推荐会被映射为宿主稳定 DTO，供应商原始响应、密钥和内部错误不会直接下发。

详情查询与持久化是两条不同的边界：

1. 只读详情可以使用 `(provider_id, external_id)` 查询，未找到时返回标准 `NOT_FOUND`，不写入内容库。
2. 任何资源、播放、弹幕、图片、推荐或后台同步写入，都必须先通过身份解析器把精确外部引用解析为宿主 `content_id`，再进入 repository。
3. 详情页、旧豆瓣路由和兼容 API 可以暂时接受外部 ID；它们只能把该 ID 传给选定画像的插件，不能把外部 ID 当作新的内部主键。
4. 当中文版切换为 TMDB 等其他画像时，页面和 DTO 不变，只替换画像绑定与插件来源；跨来源关联必须通过显式外部引用和身份审计完成，禁止标题模糊合并。

日历页通过宿主的 [`/api/content/calendar`](../../app/api/content/calendar/route.ts) 使用 `content.calendar` 能力。日历事件的 `eventId`、播出日期、季集数、海报和评分属于排播元数据，不等同于内容身份；只有插件明确返回精确的豆瓣外部引用时，兼容 DTO 才填充 `douban_id`，否则页面保留标题搜索回退，不能把 `show_id` 猜成豆瓣 ID。

普通分类、首页和浏览页通过 [`/api/content/catalog`](../../app/api/content/catalog/route.ts) 使用 `content.catalog` 能力。宿主声明 `category`、`featured`、`new-releases`、`sections`、`latest` 五种受控 view；`sections` 只接受 `movies | series`，`latest` 只接受宿主定义的内容类型、类型、年份、地区和排序意图。候选统一映射为供应商无关的 `items + sections + pagination`；迁移中的分类页暂时保留 `subjects` 兼容字段。插件负责把 view、key 和排序意图映射到自己的上游接口，页面不得导入具体内容服务，也不得把 `/hero`、`/new`、`sort=time` 等供应商协议写进公共契约。如果某个来源没有 Top 250 或其他分类，插件必须返回标准能力/上游错误，不能用另一分类静默替代。

`content.search` 使用可选 `intent` 区分交互搜索和后台资源匹配。`interactive` 可以合并插件声明的搜索结果；`resource-match` 必须保持来源建议顺序和宿主限定的候选数量，严格片名、年份容差与是否允许写入旧 `douban_id` 的策略仍由宿主管理，不能下沉给插件。兼容数据库尚未迁移完时，非 Douban 外部引用必须明确拒绝，不能静默写入旧命名空间。

### 运行画像

每次插件调用都携带不可变调用上下文：

- `locale`：BCP 47 语言标签，例如 `zh-CN`、`en-US`。
- `region`：ISO 3166-1 alpha-2 地区码，例如 `CN`、`US`。
- `profile`：宿主定义的发布画像 ID，绑定启用插件、优先级、回退、内容策略和缓存策略。
- `request_id` 或 `run_id`：贯穿在线请求或后台任务的追踪 ID。
- `AbortSignal`、截止时间和最小化日志接口。

插件不得根据服务器 IP、系统语言或未声明环境变量静默推断地区。插件不支持请求画像时必须返回标准的 `UNSUPPORTED_LOCALE` 或 `UNSUPPORTED_REGION`，由宿主决定回退，不得在插件内部偷换数据源。

中文站可以选择 Douban 内容插件和中国区资源策略，英文站可以选择 TMDB 内容插件及不同图片、搜索和播放插件。当前 `en-default` 已完成服务端读路径；详情图片在身份已解析且 R2 配置完整时通过宿主镜像台账持久化到 R2，正式启用前仍需完成 TMDB 授权材料、运营审批和英文 UI smoke。页面与路由不需要为两套站点复制业务代码。

## 运行与数据流

### 在线请求数据流

```mermaid
sequenceDiagram
  actor caller as 调用方
  participant host as 宿主 API
  participant policy as 画像与策略
  participant registry as 插件注册中心
  participant plugin as 能力插件
  participant identity as 身份解析器
  participant store as 宿主持久化/缓存

  caller->>host: 请求能力 + locale/region/profile
  host->>policy: 鉴权并解析插件优先级
  policy-->>host: 允许的执行计划
  host->>registry: 解析能力和兼容版本
  registry-->>host: 已启用的可信插件
  host->>plugin: 标准上下文 + DTO + 超时信号
  plugin-->>host: 标准结果 + 来源 + 游标/错误
  host->>identity: 解析 external_refs
  identity-->>host: content_id
  host->>policy: 校验、去重、合并和内容策略
  host->>store: 持久化结果、缓存和审计事件
  host-->>caller: 与供应商无关的公共响应
```

在线请求不得直接把插件响应透传给浏览器。宿主必须完成结构校验、身份解析、URL 安全检查、来源记录和字段裁剪后才可返回。

### 调度、日志与审计

后台任务由宿主注册和运行。插件只声明任务及其执行入口，不自行创建常驻定时器或写宿主任务表。

每次运行至少记录：`run_id`、`plugin_id`、插件版本、能力、任务 ID、画像、触发方式、配置版本、开始/结束时间、游标、处理/新增/更新/跳过/失败数量、脱敏错误和最终状态。资源变化另写审计事件，记录 `content_id`、来源、变更前后摘要和操作者或任务 ID。

调度器必须提供：

- MongoDB 或等价持久层中的租约，防止多实例重复执行；
- 幂等键、分页游标和可恢复水位；
- 超时、取消、指数退避和明确的可重试错误；
- 进度与日志查询、手动执行、再次同步和停止入口；
- 日志保留期、敏感字段脱敏和审计记录不可静默覆盖。

现有 [`lib/pan/scheduler.ts`](../../lib/pan/scheduler.ts)、[`app/api/pan-resources/scheduler/route.ts`](../../app/api/pan-resources/scheduler/route.ts) 和 [`instrumentation.ts`](../../instrumentation.ts) 已提供持久化运行、租约和进程启动基础。迁移时应提取为通用插件任务运行器，而不是为新插件复制一套调度器。

### 配置与密钥

- 普通配置由宿主按 `plugin_id` 命名空间保存，写入前按 Manifest 校验类型、范围和枚举。
- 密钥只通过部署环境或受控密钥服务注入；数据库和管理 API 只保存密钥引用或“已配置”状态。
- 日志、错误、指标、浏览器响应和 Manifest 均不得出现密钥值。
- Sidecar 使用独立服务身份；不得复用管理员登录密码或公共 API Token。
- 配置变更必须记录操作者、配置版本和生效时间；密钥轮换不要求修改插件代码。

## 安全与合规基线

每个启用插件必须有明确负责人、来源说明、许可证或授权依据、数据用途、支持地区、保留策略和下架方式。平台提供技术控制和证据链，但最终合规判断由项目运营方及适用法律决定。

最低控制要求如下：

- 只加载部署时批准并锁定版本的插件；依赖和容器镜像应锁定摘要并经过 CI 检查。
- 插件出站请求仅允许 Manifest 声明的 HTTPS 主机；重定向后重新校验，复用 [`lib/url-security.ts`](../../lib/url-security.ts) 的 URL 安全规则。
- 插件输入、上游响应、分页游标和返回 DTO 均在宿主边界做运行时校验，并设置大小、页数、速率和超时上限。
- 管理配置、立即同步、停用和下架操作沿用 [`lib/auth.ts`](../../lib/auth.ts) 的管理权限边界，并写审计日志。
- 所有资源记录保留 `plugin_id`、外部 ID、来源时间和可用状态，支持按插件、内容、地区批量禁用和重新同步。
- 对用户可见的数据必须支持纠错、下架和来源追踪；删除和禁用不能只清理缓存而遗漏持久层。
- 测试夹具、日志和错误报告必须去除真实密钥、个人信息和未授权内容。
- 插件停用后不得再启动任务或回源；历史数据按策略标记、隐藏或删除，并保留必要审计记录。
- 插件首次使用必须经过管理员安装和启用；运行时不能把静态注册、合规审批或历史数据存在误认为可用资格。

## 迁移路线

迁移采用兼容层和双写/回填方式，不进行一次性重写。

| 阶段 | 交付结果 | 兼容要求 |
| --- | --- | --- |
| 1. 建立契约内核 | `lib/plugins/` 提供 Manifest、能力类型、注册中心、调用上下文和标准错误；加入参考插件测试 | 不改变现有页面和 API 行为 |
| 2. 包装现有来源 | 将 [`lib/douban-service.ts`](../../lib/douban-service.ts) 包装为内置 `content` 适配器（其上游仍是独立服务），将 [`lib/kkpan.ts`](../../lib/kkpan.ts) 与 [`lib/pan/sync.ts`](../../lib/pan/sync.ts) 包装为 `resource.cloud-drive` 适配器 | 旧入口仍通过适配层工作，核心新增代码不得出现供应商分支 |
| 3. 引入统一身份 | `content_identities` 提供精确外部引用解析与唯一索引，影片台账和资源开始双写 `content_id` | 读取先用 `content_id`，未回填记录才回退旧字段；迁移可重复执行 |
| 4. 通用化宿主 | API、后台、调度、日志和前台组件改为按能力工作；现有网盘同步器提取为通用任务运行器 | 指标验证新旧结果一致后才移除专用入口 |
| 5. 拆分与扩展 | 公共契约独立发布；私有插件迁到私有仓库或 Sidecar；接入 TMDB、播放、弹幕、图片、搜索和推荐插件 | 每个插件独立版本、权限、配置、测试和回滚 |
| 6. 清理兼容层 | 删除供应商专用数据库字段、路由和 UI 分支，文档与迁移脚本归档 | 仅在零旧读写、备份和回滚演练完成后执行 |

当前迁移状态与剩余兼容点包括：

- [`lib/douban-service.ts`](../../lib/douban-service.ts) 只由 Douban 内容适配器调用；页面、Hook、公共 API 和后台内容发现均已改走画像与宿主门面。
- [`lib/kkpan.ts`](../../lib/kkpan.ts) 仍实现供应商协议；兼容搜索路由已通过 `resource.cloud-drive.search`，同步任务通过 [`lib/plugins/resource-host.ts`](../../lib/plugins/resource-host.ts) 和 [`lib/pan/cloud-drive-task.ts`](../../lib/pan/cloud-drive-task.ts) 进入中性宿主边界。需要页指纹和漂移证明的全量增量/失效任务暂留兼容层，旧 KKPAN 页形状只能在该桥内使用。
- [`lib/pan/catalog-sync.ts`](../../lib/pan/catalog-sync.ts) 和 [`lib/pan/sync.ts`](../../lib/pan/sync.ts) 的内容目录与内容搜索已经改走 `content-host`；匹配、旧字段写入、KKPAN 稳定分页和失效策略仍由宿主兼容层负责。
- [`types/pan-resource.ts`](../../types/pan-resource.ts) 与 [`lib/db.ts`](../../lib/db.ts) 包含 `douban_id`、`kkpan_id` 和供应商专用索引。
- 管理端和资源组件仍消费旧网盘字段及兼容 API；新的内容详情、目录、搜索和日历读取不再直接依赖供应商客户端。
- [`kerkerker-douban-service`](../../../kerkerker-douban-service/README.md) 已经是独立 Go 服务，适合作为首个远程 `content` 插件适配对象。

## 架构完成定义

插件平台地基只有同时满足以下条件，才视为完成：

- 公共契约不依赖 Next.js 页面、MongoDB 驱动或任何供应商 SDK，并通过独立类型检查与契约测试。
- 宿主通过静态注册中心按能力发现插件，启动时能拒绝重复 ID、不兼容版本、缺失配置和未声明能力。
- `content_id` 成为所有资源、弹幕、图片和推荐的唯一内部关联键，外部 ID 使用唯一映射表管理。
- `locale`、`region` 和 `profile` 贯穿在线请求、后台任务、缓存键、日志和审计。
- 当前 Douban 内容来源和 kkpans 网盘来源均通过插件适配器运行，现有用户功能和自动同步没有回归。
- 新增第二个同类测试插件无需修改核心路由、数据库模型和页面中的供应商判断。
- 调度、重试、停止、进度、日志和审计可按 `plugin_id` 查询，重启及多实例情况下不会重复写入。
- 密钥不进入仓库、Manifest、日志或客户端；Sidecar 具有独立身份、超时和网络白名单。
- 插件可被单独禁用、回滚和下架，宿主在插件失败时按画像执行明确降级且不返回未校验数据。
- 迁移脚本可重复运行，旧字段清理前有备份、数据对账、回滚演练和零旧读写证据。

单个插件的交付检查见[插件开发标准中的 Definition of Done](./development-standard.md#definition-of-done)。
