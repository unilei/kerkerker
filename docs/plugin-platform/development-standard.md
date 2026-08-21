# Kerkerker 插件开发标准

本文规定 Kerkerker 插件契约、实现、注册、运行和验收方式。架构背景见[插件平台架构基线](./README.md)。所有新插件和现有供应商适配改造都必须遵守本标准。

## 规范范围

本文中的“必须”是合并和发布的硬性条件；“应”表示默认做法，偏离时需要在评审中给出可验证理由；“可以”表示兼容实现选择。

### v1 信任模型

- 只运行经过代码评审、版本锁定并在部署时静态注册的可信插件。
- 进程内插件使用静态 `import`；禁止根据数据库值、URL 或管理员输入执行动态代码。
- Sidecar 地址来自部署配置和允许列表；管理后台不能把任意 URL 注册为插件。
- 不实现插件上传、脚本编辑、热加载、`eval`、`new Function` 或不可信插件沙箱。
- 启用、停用和配置插件是管理操作，必须认证并写审计事件。

### 能力命名

公共契约只接受以下稳定能力 ID：

```typescript
export type PluginCapability =
  | "content.catalog"
  | "content.calendar"
  | "content.detail"
  | "content.search"
  | "resource.playback"
  | "resource.cloud-drive"
  | "interaction.danmu"
  | "asset.image"
  | "recommendation";
```

这组 ID 实现架构基线中的七大类别：`content` 下包含目录、日历、详情和内容搜索；`danmu` 使用 `interaction.danmu`；`image` 使用 `asset.image`。新增能力必须先更新公共契约和架构基线，再实现插件。供应商名称只能出现在插件 ID、适配器和来源元数据中，不能成为新能力 ID。

## 项目与依赖规则

### 初期目录边界

公共契约尚未拆仓时，主仓库先使用扁平的 v1 过渡结构；这些文件已经可以被独立契约包直接复用：

```text
lib/plugins/
├── types.ts             # 零框架依赖的类型、DTO 和版本规则
├── errors.ts            # 标准错误码与可序列化错误
├── validation.ts        # Manifest 和权限运行时校验
├── registry.ts          # 静态可信注册中心
├── index.ts             # 宿主的显式内置插件清单
└── adapters/            # 现有来源的薄适配器
    ├── douban-content.ts
    └── kkpan-cloud-drive.ts
```

当前契约类型、校验入口和错误词汇分别见 [`lib/plugins/types.ts`](../../lib/plugins/types.ts)、[`lib/plugins/validation.ts`](../../lib/plugins/validation.ts) 和 [`lib/plugins/errors.ts`](../../lib/plugins/errors.ts)。新增字段先进入契约类型和校验，再进入适配器。

契约稳定并准备拆仓时，再将上述文件按职责重导出到 `contract/`、`runtime/`、`identity/` 和 `adapters/` 子目录；拆分只允许改变模块路径，不得改变 DTO、错误码或注册语义。

目录名可以随实现细化，但依赖方向固定：

```text
app / components -> plugin runtime -> plugin contract
                                   -> trusted adapters -> plugin contract
identity / scheduler / persistence -> plugin contract
plugin contract -> TypeScript 标准类型
```

`contract/` 不得导入 Next.js、React、MongoDB、宿主认证、页面组件、具体供应商客户端或 Node.js 进程全局状态。适配器不得导入 `app/` 和 `components/`，也不得直接写宿主集合。

契约稳定后，`contract/` 和兼容性测试发布为独立的 `kerkerker-plugin-contract` SemVer 包。具体插件使用独立 `kerkerker-plugin-*` 仓库；宿主只依赖契约和部署批准的插件版本。

### 公开与私有插件

| 形式 | 适用场景 | 必须满足 |
| --- | --- | --- |
| 公开进程内包 | 通用、可审计且许可允许公开的适配器 | 固定依赖版本、静态导入、随宿主测试和构建 |
| 私有进程内包 | 实现可随最终镜像交付，但源码不公开 | 私有包仓库、私有构建缓存和私有最终镜像 |
| 私有 Sidecar | 需要隔离实现、跨语言、单独扩容或不能进入宿主镜像 | 固定镜像摘要、服务认证、网络隔离、版本化 HTTP 契约 |

插件仓库不得保存宿主部署密钥。公开宿主仓库也不得包含私有插件源码、私有包 Token 或 Sidecar 服务凭证。

## 契约设计

### Manifest

Manifest 是插件可加载性的唯一声明来源。下面的现有 Douban Service 适配示例展示完整结构；值是公开元数据，不包含密钥：

```typescript
export const doubanContentManifest = {
  id: "kerkerker.douban-content",
  name: "Kerkerker Douban Content",
  version: "1.0.0",
  contractVersion: "1.0.0",
  // 当前宿主使用内置适配器调用独立 Douban Service；Sidecar 版本才使用 remote。
  runtime: { mode: "built-in", entry: "@/lib/plugins/adapters/douban-content" },
  capabilities: [
    { id: "content.catalog", version: "1.0.0" },
    { id: "content.detail", version: "1.0.0" },
    { id: "content.search", version: "1.0.0" },
    { id: "asset.image", version: "1.0.0" },
    { id: "recommendation", version: "1.0.0" },
  ],
  locales: ["zh-CN"],
  config: {
    version: "1.0",
    fields: [
      { key: "baseUrl", type: "url", required: true, secret: false },
      { key: "serviceToken", type: "secret", required: false, secret: true },
    ],
  },
  compliance: {
    legalBasis: "operator-reviewed",
    contentScope: "movie-and-series-metadata",
    regions: ["CN"],
    dataClassification: "licensed",
  },
  permissions: {
    networkHosts: ["iamyourfather.link0.me"],
    secrets: ["serviceToken"],
    storage: "none",
  },
} as const;
```

Manifest 规则：

- `id` 使用小写字母、数字、点和连字符，长度 3 至 100；发布后不可变且不可转让。
- `version` 必须是完整 SemVer；构建和日志记录精确版本，不记录 `latest`。
- `contractVersion` 使用 `major.minor` 或 `major.minor.patch`；宿主拒绝不支持的契约主版本，内部记录时使用规范化版本。
- `capabilities` 不得重复，且每项必须有对应实现和契约测试。
- `locales` 使用 BCP 47；`compliance.regions` 使用 ISO 3166-1 alpha-2 大写码或经过审核的部署区域标签。
- `config.version` 使用 `major.minor` 或 `major.minor.patch`；`config.fields` 的 key 在插件内唯一，`secret: true` 的值不得通过读取配置 API 返回。
- `networkHosts` 是精确主机名，不接受 `*`；确需子域时由宿主支持受审的后缀规则。
- `runtime.mode=remote` 可以声明 `protocolVersions`、`health` 和 `auth`：健康路径必须是同一 HTTPS origin 下的绝对路径；协议响应必须返回宿主支持的 v1 兼容版本；`auth.secret` 只能引用 `permissions.secrets` 中的密钥名，认证值由宿主运行时注入，禁止写入 Manifest、日志或请求体。
- `compliance` 必须能让运营方定位法律依据、内容范围、地区和数据分类；许可证与维护入口写入插件发布元数据。

### 能力实现接口

插件模块只暴露 Manifest 已声明的能力。下面是契约包中的最小形状；具体 DTO 和可选操作按能力版本扩展，宿主不能调用未声明的方法：

```typescript
export interface Plugin {
  manifest: PluginManifest;
  capabilities: PluginCapabilities;
}

export interface PluginCapabilities {
  "content.catalog"?: ContentCatalogCapability;
  "content.calendar"?: ContentCalendarCapability;
  "content.detail"?: ContentDetailCapability;
  "content.search"?: ContentSearchCapability;
  "resource.playback"?: PlaybackCapability;
  "resource.cloud-drive"?: CloudDriveCapability;
  "interaction.danmu"?: DanmuCapability;
  "asset.image"?: ImageCapability;
  recommendation?: RecommendationCapability;
}
```

各能力接口遵循同样的上下文、分页、来源和错误契约；输入类型由对应能力版本定义，不能包含宿主数据库连接或 React/Next.js 对象。

### 调用上下文

所有能力方法的第一个参数都是宿主创建的调用上下文：

```typescript
export interface PluginLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface PluginContext {
  runtime: "server";
  requestId: string;
  runId?: string;
  profile: string;
  locale: string;
  region: string;
  deadline: string;
  signal: AbortSignal;
  config: Readonly<Record<string, unknown>>;
  secrets: PluginSecretReader;
  storage: PluginStorage;
  logger: PluginLogger;
}
```

- `profile`、`locale`、`region` 进入缓存键、幂等键、日志和审计，不能只在页面层使用。
- `config` 只包含当前插件声明并获准读取的配置；对象不可变。
- 密钥可以在运行时以受控句柄或仅服务器可见值提供，但 logger 必须预先注册脱敏规则。
- 插件必须监听 `signal`，不得在取消或截止时间之后继续写入或回传结果。
- 插件不能读取系统默认语言、客户端未授权 Header 或全局环境变量来覆盖上下文。

### 内容与外部引用

内容目录、日历和搜索插件返回 `ContentCandidate`；详情插件返回带有受控扩展字段的 `ContentDetailCandidate`。两者都不自行创建平台 `content_id`：

```typescript
export interface ResultProvenance {
  source: { providerId: string; sourceId?: string; sourceUrl?: string };
  pluginVersion: string;
  fetchedAt: string;
  sourceUrl?: string;
}

export interface ExternalReference {
  providerId: string;
  externalId: string;
  canonicalUrl?: string;
}

export interface LocalizedText {
  locale: string;
  value: string;
}

export interface ContentCandidate {
  type: "movie" | "series" | "season" | "episode" | "person";
  externalRefs: ExternalReference[];
  titles: LocalizedText[];
  preview?: {
    posterUrl?: string;
    backdropUrl?: string;
    rating?: string;
    url?: string;
    episodeInfo?: string;
    genres?: string[];
  };
  releaseDate?: string;
  region?: string;
  parentRefs?: ExternalReference[];
  provenance: ResultProvenance;
}

export interface ContentDetailCandidate extends ContentCandidate {
  details: {
    rating?: string;
    genres?: string[];
    directors?: string[];
    actors?: string[];
    duration?: string;
    episodeCount?: string;
    shortComment?: { id: string; content: string; author: string };
    photos?: Array<{ id: string; url: string; thumbUrl?: string }>;
    comments?: Array<{ id: string; content: string; author: string }>;
    recommendations?: Array<{
      externalRefs: ExternalReference[];
      titles: LocalizedText[];
      posterUrl?: string;
      rating?: string;
    }>;
  };
}
```

目录能力使用宿主声明的 `category`、`featured`、`new-releases`、`sections`、`latest` view；`key` 只表达供应商无关的目录选择，例如业务分类键或 `movies | series`。`latest` 的 `filters` 只允许宿主声明的 `contentType/genre/year/region/sort`，其中排序使用 `recommended/release-date/rating` 意图，插件私有的 `time/rank` 等 token 只能留在适配器内部。适配器可以把 view 映射到自己的精选或新内容接口，但不能把供应商 URL、方法名或原始响应字段加入 `ContentCatalogRequest`。分组目录通过可选的 `ContentCatalogCandidate.catalog.section` 返回稳定 section key 和本地化标题；Hero 的横图、竖图、简介和类型分别复用 `preview.backdropUrl`、`preview.posterUrl`、`overview` 和 `preview.genres`。宿主 API 再统一映射为 `items + sections + pagination`，浏览器不能收到 `providerId` 或插件私有元数据。

内容搜索请求可以声明 `intent: interactive | resource-match`。交互搜索可以按插件约定合并高级结果与建议结果；资源匹配必须保持建议顺序并服从宿主候选上限，插件只返回候选，不能决定内容身份合并。标题严格匹配、年份容差和旧字段兼容校验属于宿主策略。后台代码必须通过 `content-host` 进入运行时，不得直接导入供应商客户端，也不得通过本机 HTTP 调用公共 API。

详情插件的 `detail` 操作遵循以下边界：

- 只读查询可以使用 `externalRef`，也可以使用宿主已经解析出的 `content`；二者都必须是精确的稳定外部引用，不能用标题、列表序号或临时 URL。
- 详情 DTO 只允许返回宿主声明的字段。评论作者、剧照和推荐必须使用稳定 ID；推荐只返回外部引用和受控预览字段，不返回完整供应商对象。
- 详情路由可以把 DTO 映射为前台兼容格式，但不得把供应商字段原样透传，也不得在读取过程中写入 `content_identities`。
- 详情请求找不到对象时返回 `NOT_FOUND`；上游超时、限流、协议错误分别映射为标准错误码，空数组不能伪装成上游失败。
- 资源等持久化能力仍必须先解析 `content_id`。详情查询成功不代表内容已获授权，也不代表可以自动创建网盘、播放或其他关联记录。

日历插件在 `ContentCandidate` 之外返回排播元数据，事件键不能冒充内容身份：

```typescript
export interface ContentCalendarCandidate extends ContentCandidate {
  calendar: {
    eventId: string;
    airDate: string;
    seasonNumber: number;
    episodeNumber: number;
    episodeName?: string;
    posterUrl?: string;
    backdropUrl?: string;
    rating?: number;
  };
}
```

- `eventId` 必须来自上游稳定事件字段或其稳定组合，不能使用翻页位置；它只用于日历事件去重和 UI key。
- 日历路由可为旧页面映射 `show_id` 等兼容字段，但页面去重和 UI key 必须优先使用不透明的 `event_id`；只有明确匹配的外部引用才能映射为对应供应商 ID。
- 缺少内容外部引用的事件仍可以展示和按标题搜索，但不得写入 `content_identities` 或生成伪造引用。

宿主身份解析器负责：

1. 用唯一键 `(provider_id, external_id)` 查找现有 `content_id`。
2. 对无法精确命中的候选执行可解释的匹配；弱匹配进入人工确认，不自动合并。
3. 为确定的新内容生成 UUID `content_id`，并原子写入内容和外部引用；`content_identities` 对 `content_id` 和 `(provider_id, external_id)` 建唯一索引。
4. 记录合并、拆分和外部引用变更的证据与审计事件。

`externalId` 必须使用上游稳定 ID，不得使用标题、列表序号、临时 URL、翻页位置或散列后的敏感信息。插件重放同一外部对象必须返回相同引用。

### 资源与其他能力

所有资源共享平台归属和来源字段：

```typescript
export interface CanonicalResourceCandidate {
  contentId?: string;
  providerId: string;
  externalId: string;
  title: string;
  availability: "available" | "unavailable" | "unknown";
  expiresAt?: string;
  provenance: ResultProvenance;
}

export interface CloudDriveResourceCandidate extends CanonicalResourceCandidate {
  kind: "cloud-drive";
  platform: ResourcePlatformRef;
  url: string;
  accessCode?: string;
}
```

- `resource.playback` 的 payload 描述播放 URL、协议、清晰度、音轨、字幕和时效，不包含网盘提取码。
- `resource.cloud-drive` 的 payload 描述网盘品牌、分享 URL、提取码、格式和容量，不宣称链接对应内容已获授权。全局增量发现返回的候选可以暂时没有 `content_id`，但宿主完成身份解析前不得公开或持久化为正式资源。
- `providerId`/`sourceId` 表示数据提供方，`platform.platformId`/`brand` 表示资源的目标平台或品牌；两组字段必须分开，不能把网盘品牌当作插件身份。
- `danmu` 使用毫秒时间戳、规范颜色/模式和稳定媒体或集引用；不得依赖播放器组件私有结构。
- `image` 返回用途、尺寸、MIME、原始来源和镜像来源；宿主决定代理、缓存和公开 URL。
- `search` 返回候选引用和匹配分数，不直接写内容库；宿主完成身份解析后再公开。
- 内容搜索可以携带受控的 `preview` 卡片字段（海报、评分、详情链接和集数提示）；这些字段不是供应商原始响应，不能借此绕过宿主 DTO 或泄露未声明数据。
- `recommendation` 返回内容引用、排序分数和可解释原因；不能直接返回供应商完整详情对象。

人工录入也必须经过相同的校验、身份解析、来源和审计流程，使用明确的宿主来源插件 ID 与管理员 actor，不能以 `source` 为空的方式绕过插件模型。

### 结果与分页

```typescript
export interface PluginWarning {
  code: string;
  message: string;
}

export interface PluginPage<T> {
  items: T[];
  nextCursor?: string;
  hasMore?: boolean;
  total?: number;
}
```

- 游标对宿主是不透明字符串，但必须按 `plugin_id + capability + operation + profile` 命名空间保存。
- 空结果与上游失败必须区分；协议错误不能伪装成 `items: []`。
- `total` 只有上游明确提供时才能填写；宿主不得把估算值当作精确总数。
- 所有列表必须有宿主设置的单页、总页数、响应体大小和运行时间上限。
- `complete` 只在插件确认扫描边界稳定时为 `true`；上游分页发生变化时返回可重试错误。
- 每条结果必须携带来源；字段级合并后，宿主保留字段来源而不是只保留最后写入插件。

### 标准错误

插件只能向宿主返回标准错误码，内部错误原因保留在脱敏日志中：

| 错误码 | 默认重试 | 含义 |
| --- | --- | --- |
| `INVALID_CONFIG` | 否 | 必需配置缺失或格式错误，插件应拒绝启动 |
| `UNAUTHORIZED` | 否 | 上游或 Sidecar 凭证无效，需要运维处理 |
| `NOT_FOUND` | 否 | 指定外部对象不存在，不等同于整个请求失败 |
| `UNSUPPORTED_LOCALE` | 否 | 插件不支持请求语言 |
| `UNSUPPORTED_REGION` | 否 | 插件不支持请求地区 |
| `CAPABILITY_UNAVAILABLE` | 否 | 画像或插件未提供请求的能力 |
| `UPSTREAM_TIMEOUT` | 是 | 上游在截止时间内未响应 |
| `UPSTREAM_RATE_LIMITED` | 是 | 上游限流，遵守合法的重试时间 |
| `UPSTREAM_UNAVAILABLE` | 是 | 上游暂时不可用 |
| `PROTOCOL_ERROR` | 受限 | 上游结构与契约不符，避免无限重试 |
| `POLICY_REJECTED` | 否 | 数据被权限、地区或内容策略拒绝 |
| `CANCELLED` | 否 | 宿主或管理员取消运行 |
| `INTERNAL` | 受限 | 未分类插件错误，必须产生告警和追踪 ID |

错误对象必须包含 `code`、安全消息、`retryable`、`requestId`，可选包含受限的 `retryAfterMs`。禁止把上游响应体、请求 Header、Token、数据库 URI 或堆栈直接返回浏览器。

## 注册与编排

### 静态注册

注册中心接收显式构造的插件实例，不扫描目录、不从字符串导入模块：

以下代码位于宿主注册模块；`doubanContentPlugin` 和 `kkpanCloudDrivePlugin` 由静态 `import` 提供。

```typescript
const registry = createPluginRegistry([
  doubanContentPlugin,
  kkpanCloudDrivePlugin,
]);
```

`createPluginRegistry()` 在返回封存的注册中心前完成以下检查：

- 插件 ID 和能力声明唯一且格式正确；
- 插件、契约和能力版本兼容；
- 声明能力都有实现，未声明能力不能被调用；
- 必需配置和密钥已经注入；
- locale、region、任务和网络权限声明有效；
- 注册完成后集合不可变，运行时启停只改变策略状态，不替换代码。

发布画像使用 `PluginProfile` 固定 `id`、`locale`、`region` 和能力到插件 ID 的有序绑定。画像注册必须在插件注册之后完成；每个绑定都要通过能力声明、locale、region 和重复 ID 校验。请求只能选择部署配置中存在的画像，不能提交任意插件 ID 或 Sidecar 地址。

能力绑定数组是明确的优先级和故障回退顺序。宿主只允许在插件返回标准 `UPSTREAM_ERROR` 时尝试下一个已注册且已批准的插件；`CONFIGURATION_ERROR`、合规拒绝、取消、输入错误和执行错误必须立即返回，不能借回退隐藏权限或数据问题。每次回退都应记录插件 ID、画像、版本和请求 ID。远程 Sidecar 的连续上游失败必须进入进程内熔断，冷却期间不得继续压测上游，半开状态只允许一个探测请求；熔断状态不能被请求输入或管理端直接篡改。

[`app/`](../../app/) 和 [`components/`](../../components/) 只能调用宿主编排服务，不得导入具体适配器。任何 `if (pluginId === "...")`、供应商专用路由或供应商字段分支都必须留在迁移兼容层，并有移除阶段。

### 画像与选择策略

发布画像由宿主维护，例如：

```typescript
export const cnProfile = {
  id: "cn-default",
  locale: "zh-CN",
  region: "CN",
  capabilities: {
    "content.catalog": ["kerkerker.douban-content"],
    "content.detail": ["kerkerker.douban-content"],
    "content.search": ["kerkerker.douban-content"],
    "resource.cloud-drive": ["kerkerker.kkpan-cloud-drive"],
    "asset.image": ["kerkerker.douban-content"],
  },
} as const;
```

- 数组顺序表示宿主优先级，不代表插件可以互相调用。
- 回退仅在能力方法标记为只读且错误可回退时执行；写入和同步操作不得向第二插件重复发送。
- 多插件结果合并使用稳定去重键和显式字段优先级，不使用“最后响应覆盖全部字段”。
- 未配置能力时返回明确的 `CAPABILITY_UNAVAILABLE`，不静默选择任意已安装插件。
- 修改画像必须生成配置版本和审计事件，运行中的任务继续使用启动时快照。

### Sidecar 协议

Sidecar v1 至少暴露以下受保护端点：

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/plugin/v1/manifest` | `GET` | 返回与部署制品一致的公开 Manifest |
| `/plugin/v1/health` | `GET` | 就绪、依赖和契约版本健康检查 |
| `/plugin/v1/invoke` | `POST` | 执行一个已声明的能力与操作 |

调用包包含 `contractVersion`、能力、操作、上下文、输入和幂等键。响应包只能是标准结果或标准错误。服务间认证通过独立 Header 或 mTLS 完成，凭证不放进 JSON。

宿主必须限制 Sidecar DNS/目标地址、连接和总超时、重定向、请求/响应大小、并发数和熔断状态。Manifest 声明的插件版本必须与健康检查和每次响应版本一致；不一致时立即摘除实例并告警。

## 配置与秘密

### 配置生命周期

1. 宿主读取 Manifest 配置声明并生成管理表单或部署校验。
2. 普通配置按 `plugin_id` 命名空间保存，形成不可变配置版本。
3. 密钥存入部署环境或密钥服务，宿主只记录引用和配置状态。
4. 插件启用前执行类型、范围、URL 和必需项校验，再运行健康检查。
5. 配置更新写审计事件；新调用使用新版本，已开始的任务继续使用旧快照。
6. 插件停用时撤销任务与访问权限；密钥按运维策略轮换或删除。

环境变量使用统一前缀 `KERKERKER_PLUGIN_`，插件 ID 和 key 转换为大写下划线，例如 `kerkerker.douban-content/serviceToken` 对应 `KERKERKER_PLUGIN_KERKERKER_DOUBAN_CONTENT_SERVICE_TOKEN`。环境变量名可以记录，值不得记录。

### 密钥处理

- 客户端组件、`NEXT_PUBLIC_*`、公共 API、Manifest 和 Git 历史不得包含插件密钥。
- `JSON.stringify(config)`、全量环境打印和原始请求 Header 日志属于禁止行为。
- 密钥比较、签名和服务认证使用成熟库与恒定时间比较，不能自定义密码学协议。
- Sidecar 的上游密钥优先只存在 Sidecar 环境中；宿主只持有调用 Sidecar 的服务身份。
- CI 使用最小权限的环境级 Secret；私有插件包和镜像访问凭证只授权给需要的工作流。

## 调度、日志与审计

### 任务声明与执行

插件可实现 Manifest 已批准的任务 ID，但触发器、租约和状态机归宿主所有。任务定义至少声明能力、默认超时、是否支持增量、并发策略和预计批量上限。

任务必须满足：

- 以 `plugin_id + job_id + profile + logical_window` 生成幂等键；
- 用宿主持久化租约防止多实例并发，租约有 owner、过期时间和心跳；
- 每批提交水位和统计，进程重启后从最后已提交水位继续；
- 重试只处理标准可重试错误，并使用有抖动的指数退避；
- 取消后停止领取新批次，当前批次在截止时间内安全结束；
- “立即运行”和定时运行走同一执行路径，只改变触发来源；
- 插件停用、版本不兼容或画像移除时拒绝创建新运行。

现有 [`lib/pan/scheduler.ts`](../../lib/pan/scheduler.ts) 的持久运行、事件、租约、停止和恢复行为是通用化的迁移基础；[`lib/plugins/job-runner.ts`](../../lib/plugins/job-runner.ts) 提供供应商无关的状态、CAS 版本、租约、进度、取消、重试退避和幂等边界，持久化适配器必须实现 `PluginJobStore` 的原子更新；不得为每个插件复制同类状态机。

### 结构化日志

在线调用日志至少包含：`timestamp`、`level`、`request_id`、`plugin_id`、插件版本、能力、操作、profile、locale、region、duration_ms、status 和标准错误码。

任务日志另包含：`run_id`、`job_id`、触发方式、配置版本、批次、游标摘要、处理/新增/更新/跳过/失败数量和最终状态。日志不得记录完整资源链接中的敏感查询参数、提取码、Token、Cookie、原始上游响应或个人信息。

### 审计事件

以下行为必须生成不可静默覆盖的审计事件：

- 插件安装登记、启用、停用、版本切换和回滚；
- 配置或画像变更、密钥轮换状态变化；
- 手动运行、取消、重试和调度修改；
- 内容身份合并、拆分和外部引用变更；
- 资源创建、禁用、恢复、下架和批量删除；
- 网络权限、地区策略或保留策略变更。

审计事件记录 actor、动作、目标、原因、时间、请求/运行 ID 和脱敏前后摘要。后台展示可以分页，但不能成为唯一存储。

## 安全与合规

### 技术控制

- 所有插件输入和输出必须经过运行时 schema 校验；TypeScript 类型不能代替运行时验证。
- 所有外部 URL 使用 [`lib/url-security.ts`](../../lib/url-security.ts) 同等级别的协议、DNS、私网地址和重定向检查。
- 插件网络访问遵守 Manifest 白名单；禁止访问云元数据地址、Unix Socket、宿主回环管理端口和未声明目标。
- API 请求有速率、并发、响应体和分页上限；上游异常不能拖垮宿主线程池或数据库连接池。
- 管理操作复用 [`lib/auth.ts`](../../lib/auth.ts) 的认证边界；公开读取和管理写入必须分路由授权。
- 插件依赖执行锁文件、许可证和漏洞检查；Sidecar 镜像锁定 digest 并生成可追踪构建记录。
- 插件不得直接使用 MongoDB 凭证；确需独立存储时使用自己的数据库身份、集合和最小权限。
- 缓存键必须包含插件 ID、插件版本或数据格式版本、能力、profile、locale、region 和规范化输入摘要。

### 来源与运营控制

上线前必须记录插件负责人、上游来源、授权或许可证依据、服务条款审核、适用地区、数据保留、纠错与下架联系人。不能确认授权的数据源默认禁用。

每条公开结果保留来源和获取时间；资源失效检测只能改变可用状态，不能抹去审计证据。按插件或地区执行紧急停用后，宿主必须停止新回源、停止任务，并按策略隐藏或撤下缓存和持久数据。

合规评审不应被“插件是私有的”替代。私有实现只改变代码可见性，不改变数据来源、版权、隐私、网络安全和地区义务。

## 测试与发布

### 必需测试

每个插件至少包含：

- Manifest schema、版本兼容、缺失配置和重复能力测试；
- 每项能力的成功、空结果、非法输入、上游非 2xx、协议变化、超时和取消测试；
- locale、region 和不支持画像测试；
- 稳定外部 ID、分页游标、重放幂等和去重测试；
- 日志及错误脱敏测试；
- 网络白名单、重定向和私网地址拒绝测试；
- 调度任务的租约、重试、恢复、取消和重复触发测试；
- Sidecar 的 Manifest、健康检查、认证、契约版本和响应大小测试；
- 宿主契约测试包，证明插件对声明的每个能力均兼容。

单元测试默认使用经过脱敏的固定夹具，不访问真实上游。真实上游烟测只能在受控 CI 环境手动或低频执行，使用最小权限密钥，并将不稳定性与合并门禁隔离。

### 主仓验证

在 `kerkerker` 主仓内修改插件契约、运行时或适配器后，至少执行：

```bash
npm run lint
npx tsc --noEmit
npx tsx tests/plugin-contract.test.ts
npm run build
```

当测试文件尚未拆分到上述名称时，执行所有受影响的 `tests/*.test.ts`，并在迁移提交中补齐统一的契约测试入口。构建必须继续保留 [`next.config.ts`](../../next.config.ts) 的 `output: 'standalone'`，以符合 Docker 部署链路。

### 发布与回滚

- 插件制品使用不可变 SemVer 标签和包完整性或镜像 digest；禁止生产部署浮动 `latest`。
- 发布说明列出契约版本、能力变化、配置迁移、数据迁移和回滚兼容范围。
- 宿主升级前在 CI 运行所有已批准插件的契约矩阵；插件升级前运行其支持的宿主版本矩阵。
- 部署使用小流量或单画像启用，观察错误率、延迟、结果量和去重差异后再扩大。
- 回滚恢复插件版本与配置快照，不删除已经写入的身份映射；数据格式不向后兼容时必须先提供可逆迁移。

## 迁移与评审规则

### 现有代码迁移

- [`lib/douban-service.ts`](../../lib/douban-service.ts) 保留为适配器内部客户端；页面、Hook、API 编排和后台任务不得再直接导入它。
- [`lib/kkpan.ts`](../../lib/kkpan.ts) 保留上游协议解析，迁到 `resource.cloud-drive` 适配器内部；[`lib/plugins/resource-host.ts`](../../lib/plugins/resource-host.ts) 是宿主调用边界，[`lib/pan/cloud-drive-task.ts`](../../lib/pan/cloud-drive-task.ts) 只负责迁移期页证据与旧 KKPAN 形状转换；[`lib/pan/sync.ts`](../../lib/pan/sync.ts) 中匹配、写库和失效策略逐步移回宿主。
- [`types/pan-resource.ts`](../../types/pan-resource.ts) 先增加 `content_id`、`provider_id`、`provider_resource_id` 并双写，完成回填和对账后才移除 `douban_id`、`source`、`kkpan_id` 专用语义。
- [`app/api/pan-resources/route.ts`](../../app/api/pan-resources/route.ts) 和页面组件先通过兼容 API 读取，再迁到按能力和 `content_id` 的通用接口。
- 已入库来源对象的 `(provider_id, provider_resource_id)` 与旧 `kkpan_id` 是稳定身份；普通编辑只能修改展示字段，改绑必须走有审计、可回滚的显式迁移流程。
- [`lib/pan/scheduler.ts`](../../lib/pan/scheduler.ts) 的状态机提取为插件任务运行器；旧任务 ID 作为兼容别名保留到运行历史和调度配置迁移完成。
- 内容目录后台扫描必须跟随插件返回的不透明 `nextCursor`，检测缺失或重复游标并保留部分结果；不能假设页码格式。调度任务将 `runId` 与继续执行检查传入宿主门面，取消后不得再发起新的内容插件调用。

数据库迁移必须由显式、可重复运行的脚本完成，记录扫描、变更、冲突和跳过数量。应用启动初始化只能创建缺失的安全索引，不能自动删除旧索引或在未对账时重写大量数据；现有 [`lib/db.ts`](../../lib/db.ts) 对专用唯一索引的谨慎做法继续适用。

### 评审拒绝项

出现以下任一情况，变更不得合并：

- 在通用路由、页面或数据库模型新增供应商名称分支；
- 用豆瓣 ID、TMDB ID、标题或 URL 代替 `content_id` 作为新内部主键；
- 插件直接写宿主集合或绕过身份、策略、审计服务；
- Manifest 与实际能力、网络访问、任务或配置不一致；
- 使用动态代码执行、运行时任意模块加载或管理员输入的 Sidecar URL；
- 把密钥放入仓库、`NEXT_PUBLIC_*`、日志、响应或测试夹具；
- 把上游失败当作空结果，或无限重试不可重试错误；
- 缺少 locale/region/profile 传播、来源元数据、超时、取消或大小限制；
- 数据迁移不可重复运行、没有对账，或清理旧字段前没有回滚路径；
- 仅凭标题模糊匹配自动合并跨供应商内容。

对本标准的例外必须与代码同时修改架构文档，说明范围、风险、替代控制、验证证据和退出条件。口头约定不能覆盖本文。

## Definition of Done

一个插件只有全部满足以下条件，才可以标记为完成并启用到生产画像：

- [ ] Manifest 完整、机器校验通过，ID、实现版本、契约版本和能力版本均已锁定。
- [ ] 插件只实现已声明能力，所有输入输出使用公共 DTO 和运行时 schema。
- [ ] `locale`、`region`、`profile`、追踪 ID、超时和取消信号贯穿所有操作。
- [ ] 外部对象使用稳定 `provider_id/external_id`，宿主身份解析生成并持久化 `content_id`。
- [ ] 插件不直接访问宿主数据库、页面组件、认证状态或供应商无关的业务策略。
- [ ] 普通配置通过 Manifest 校验，密钥只由服务器端安全注入且脱敏测试通过。
- [ ] 出站网络目标、重定向、超时、并发、速率、分页和响应体限制已经实施并测试。
- [ ] 标准错误码、重试建议、空结果语义和回退行为明确且通过测试。
- [ ] 后台任务具备租约、幂等、水位恢复、重试、取消、进度和再次同步能力。
- [ ] 在线日志、任务日志和审计事件包含规定字段，且不包含密钥或敏感载荷。
- [ ] 来源、许可或授权依据、适用地区、保留、纠错、下架和负责人已经记录并获运营批准。
- [ ] 单元、契约、故障、画像、安全和 Sidecar 测试通过，固定夹具已脱敏。
- [ ] 主仓 lint、TypeScript、受影响测试和生产构建通过，Docker 交付链路未回归。
- [ ] 插件制品和依赖可追踪且不可变，部署、配置迁移、观测指标和回滚步骤已经验证。
- [ ] 关闭插件后不会再回源或启动任务，已有数据可按来源和地区安全隐藏、下架或恢复。
- [ ] 新插件接入没有要求通用路由、核心数据模型或 UI 增加供应商专用判断。
### Legacy job read adapters

When a provider-specific scheduler is being migrated, a read-only adapter may expose its records as the provider-neutral `PluginJobRun` DTO. The adapter must not claim a durable CAS revision or retry capability that the source scheduler does not have: use `revision: 0`, a truthful `maxAttempts` value, and keep the legacy status vocabulary unchanged. Write-side migration requires an explicit dual-write/reconciliation design and must not point the generic store at a legacy collection by type assertion alone.
