const QUARK_DRIVE_HOST = 'https://drive-pc.quark.cn';
const QUARK_SHARE_HOST = 'https://drive-h.quark.cn';
const QUARK_REFERER = 'https://pan.quark.cn/';
const QUARK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUARK_SHARE_PAGE_SIZE = 50;
const QUARK_SHARE_MAX_TREE_ITEMS = 20_000;
const QUARK_SHARE_MAX_TREE_DIRECTORIES = 4_000;
const QUARK_SHARE_MAX_TREE_PAGES = 200;
// 自有目录 file/sort 列表的单轮翻页上限（50/页 × 100 页 = 5000 项）
const QUARK_OWN_DIR_MAX_PAGES = 100;
const QUARK_API_REQUEST_TIMEOUT_MS = 20_000;
const QUARK_DELETE_TASK_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

type QuarkApiClientOptions = {
  cookie: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onStage?: (event: QuarkApiStageEvent) => void;
};

export class QuarkApiError extends Error {
  readonly code: string | number | null;
  readonly httpStatus: number | null;
  readonly endpoint: string;
  readonly retryable: boolean;
  readonly shareTreeRequestScope: 'root' | 'child' | null;

  constructor(
    message: string,
    options: {
      code?: string | number | null;
      httpStatus?: number | null;
      endpoint?: string;
      retryable?: boolean;
      shareTreeRequestScope?: 'root' | 'child';
    } = {},
  ) {
    super(message);
    this.name = 'QuarkApiError';
    this.code = options.code ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.endpoint = options.endpoint || '';
    this.retryable = options.retryable === true;
    this.shareTreeRequestScope = options.shareTreeRequestScope ?? null;
  }
}

export type QuarkApiStageEvent = {
  stage: 'share_token' | 'share_detail' | 'save_folder' | 'save_shared_files' | 'create_share_link';
  status: 'started' | 'completed' | 'failed';
  durationMs?: number;
  error?: string;
};

type QuarkShareToken = {
  pwdId: string;
  passcode: string;
  stoken: string;
  title?: string;
};

type QuarkShareItem = {
  fid: string;
  fidToken: string;
  parentFid?: string;
  name?: string;
  size?: number | null;
};

type QuarkDeleteOwnedFilesResult = {
  deletedFileIds: string[];
};

export type QuarkShareTreeItem = {
  fid: string;
  fidToken?: string;
  parentFid?: string;
  name: string;
  path: string;
  parentPath: string;
  size: number | null;
  dir: boolean;
};

export type QuarkShareTreeInspection = {
  items: QuarkShareTreeItem[];
  filteredMessage: string | null;
  filteredFileCount?: number | null;
  reportedSize?: number | null;
  completeness?: 'complete' | 'partial';
  exactSizeBytes?: number | null;
  sizeExact?: boolean;
};

export type QuarkShareTreeDetailedInspection = QuarkShareTreeInspection & {
  completeness: 'complete' | 'partial';
  exactSizeBytes: number | null;
  sizeExact: boolean;
};

type QuarkSharePaginationEvidence = {
  total: number | null;
  hasMore: boolean | null;
  page: number | null;
  pageSize: number | null;
};

type QuarkShareTreeTraversalState = {
  visitedDirectories: Set<string>;
  visitedPages: Set<string>;
  seenItemFids: Set<string>;
  itemCount: number;
};

export class QuarkApiTransferError extends Error {
  savedFids: string[];
  warning: string | null;
  filteredFileCount: number | null;

  constructor(
    message: string,
    savedFids: string[] = [],
    warning: string | null = null,
    filteredFileCount: number | null = null
  ) {
    super(message);
    this.name = 'QuarkApiTransferError';
    this.savedFids = savedFids;
    this.warning = warning;
    this.filteredFileCount = filteredFileCount;
  }
}

export function parseQuarkSizeText(text: string | number | null | undefined) {
  if (typeof text === 'number') {
    return normalizeQuarkByteCount(text);
  }

  const value = String(text || '').trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return normalizeQuarkByteCount(Number(value));
  }

  const match = value.match(/(\d+(?:\.\d+)?)\s*([KMGT]?B)/i);
  if (!match) return null;

  const units: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (!Number.isFinite(amount) || !units[unit]) return null;

  return normalizeQuarkByteCount(amount * units[unit]);
}

function normalizeQuarkByteCount(value: number) {
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getArrayAtAnyPath(payload: unknown, keys: string[]) {
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      return value;
    }
    if (!isObject(value)) continue;

    for (const key of keys) {
      const child = value[key];
      if (Array.isArray(child)) return child;
    }

    for (const child of Object.values(value)) {
      if (isObject(child)) queue.push(child);
    }
  }

  return [];
}

function extractString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractPositiveString(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(Math.round(value));
  return extractString(value);
}

function extractFirstStringByKeys(payload: unknown, keys: string[]) {
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!isObject(value)) continue;

    for (const key of keys) {
      const found = extractPositiveString(value[key]);
      if (found) return found;
    }

    queue.push(...Object.values(value));
  }

  return null;
}

export function extractQuarkPwdId(shareUrl: string) {
  try {
    const url = new URL(shareUrl);
    return url.pathname.match(/\/s\/([^/?#]+)/)?.[1] || null;
  } catch {
    return shareUrl.match(/pan\.quark\.cn\/s\/([^/?#]+)/)?.[1] || null;
  }
}

export function extractQuarkPasscode(shareUrl: string) {
  try {
    const url = new URL(shareUrl);
    return url.searchParams.get('pwd') || url.searchParams.get('passcode') || url.searchParams.get('code') || '';
  } catch {
    return shareUrl.match(/[?&](?:pwd|passcode|code)=([^&#]+)/)?.[1] || '';
  }
}

export type QuarkFilteredFileInfo = {
  message: string;
  count: number | null;
};

export function findQuarkFilteredFileInfo(payload: unknown): QuarkFilteredFileInfo | null {
  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const value = queue.shift();
    if (value && typeof value === 'object') {
      if (seen.has(value)) continue;
      seen.add(value);
    }

    if (isObject(value) && isQuarkPartialViolationPayload(value)) {
      const count = getQuarkViolationCount(value);
      return {
        message: count ? `该链接中有 ${count} 个文件被过滤` : '该链接中有文件被过滤',
        count,
      };
    }

    if (typeof value === 'string') {
      const message = value.trim().replace(/\s+/g, ' ');
      const counted = message.match(/(?:该链接中)?有\s*(\d+)\s*个文件被过滤/i);
      if (counted) {
        return {
          message: counted[0].replace(/\s+/g, ' '),
          count: parsePositiveIntegerValue(counted[1]),
        };
      }
      if (/文件(?:已)?被过滤/i.test(message)) {
        return { message: '该链接中有文件被过滤', count: null };
      }
      continue;
    }

    if (Array.isArray(value)) {
      queue.push(...value);
    } else if (isObject(value)) {
      queue.push(...Object.values(value));
    }
  }

  return null;
}

export function findQuarkFilteredFileMessage(payload: unknown) {
  return findQuarkFilteredFileInfo(payload)?.message || null;
}

function isQuarkPartialViolationPayload(value: Record<string, unknown>) {
  return isTruthyQuarkFlag(value.partial_violation)
    || isTruthyQuarkFlag(value.partialViolation)
    || isTruthyQuarkFlag(value.has_violation)
    || isTruthyQuarkFlag(value.hasViolation);
}

function isTruthyQuarkFlag(value: unknown) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function getQuarkViolationCount(value: Record<string, unknown>) {
  const candidates = [
    value.violation_cnt,
    value.violation_count,
    value.violationCount,
    value.filtered_count,
    value.filteredCount,
  ];

  for (const candidate of candidates) {
    const count = parsePositiveIntegerValue(candidate);
    if (count) return count;
  }

  return null;
}

function parsePositiveIntegerValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== 'string') return null;

  const match = value.trim().match(/^\d+$/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractQuarkList(payload: unknown) {
  if (isObject(payload)) {
    if (Array.isArray(payload.list)) return payload.list;
    if (isObject(payload.data) && Array.isArray(payload.data.list)) return payload.data.list;
    if (isObject(payload.data) && Array.isArray(payload.data.file_list)) return payload.data.file_list;
  }

  return getArrayAtAnyPath(payload, ['list', 'file_list']);
}

function parseNonNegativeSafeInteger(value: unknown) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseQuarkBoolean(value: unknown) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function getQuarkPaginationSources(payload: unknown) {
  if (!isObject(payload)) return [];
  const data = isObject(payload.data) ? payload.data : null;
  return [
    isObject(payload.metadata) ? payload.metadata : null,
    data && isObject(data.metadata) ? data.metadata : null,
    data && isObject(data.pagination) ? data.pagination : null,
    isObject(payload.pagination) ? payload.pagination : null,
    data,
  ].filter((value): value is Record<string, unknown> => !!value);
}

function readConsistentPaginationValue<T>(
  sources: Record<string, unknown>[],
  keys: string[],
  parser: (value: unknown) => T | null,
  label: string,
) {
  const values: T[] = [];
  for (const source of sources) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const raw = source[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const parsed = parser(raw);
      if (parsed === null) {
        throw new Error(`夸克分享目录返回了无效的${label}，无法确认目录完整性`);
      }
      values.push(parsed);
    }
  }
  if (values.length === 0) return null;
  if (values.some((value) => value !== values[0])) {
    throw new Error(`夸克分享目录返回了矛盾的${label}，无法确认目录完整性`);
  }
  return values[0];
}

function extractQuarkPaginationEvidence(payload: unknown): QuarkSharePaginationEvidence {
  const sources = getQuarkPaginationSources(payload);
  return {
    total: readConsistentPaginationValue(
      sources,
      ['_total', 'total', 'total_count', 'totalCount'],
      parseNonNegativeSafeInteger,
      '总数',
    ),
    hasMore: readConsistentPaginationValue(
      sources,
      ['_has_more', 'has_more', 'hasMore'],
      parseQuarkBoolean,
      '分页状态',
    ),
    page: readConsistentPaginationValue(
      sources,
      ['_page', 'page', 'page_no', 'pageNo'],
      parseNonNegativeSafeInteger,
      '页码',
    ),
    pageSize: readConsistentPaginationValue(
      sources,
      ['_size', 'page_size', 'pageSize'],
      parseNonNegativeSafeInteger,
      '分页大小',
    ),
  };
}

function getQuarkExactTreeSize(
  items: QuarkShareTreeItem[],
  completeness: QuarkShareTreeDetailedInspection['completeness'],
  filteredMessage: string | null,
) {
  if (completeness !== 'complete' || filteredMessage) return null;

  let total = 0;
  for (const item of items) {
    if (item.dir) continue;
    if (item.size === null || !Number.isSafeInteger(item.size) || item.size < 0) return null;
    if (total > Number.MAX_SAFE_INTEGER - item.size) return null;
    total += item.size;
  }
  return total;
}

export function extractQuarkSavedFids(payload: unknown) {
  const ids = new Set<string>();
  const preferredArrays = getArrayAtAnyPath(payload, [
    'save_as_top_fids',
    'save_as_fids',
    'saved_fids',
    'to_fid_list',
  ]);

  for (const item of preferredArrays) {
    const fid = extractPositiveString(item);
    if (fid) ids.add(fid);
  }

  // A completed save response can contain the original source request under
  // `fid`/`file_id`. Those fields are not provider-owned IDs by themselves.
  // Only walk explicitly named destination/save result containers; this keeps
  // source-share IDs out of cleanup after a malformed or echoed response.
  const trustedContainerKeys = new Set([
    'save_as', 'save_as_result', 'save_result', 'saved', 'saved_files',
    'saved_items', 'target', 'target_file', 'target_files', 'destination',
    'destination_file', 'destination_files', 'restore_result', 'task_result',
    'file_result', 'result_files',
  ]);
  const directDestinationKeys = new Set([
    'save_as_top_fids', 'save_as_fids', 'saved_fids', 'to_fid_list', 'to_fid',
  ]);
  const nestedDestinationKeys = new Set(['fid', 'file_id', 'fid_list', 'fids']);
  const visited = new Set<object>();

  const collect = (value: unknown, trusted: boolean) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item, trusted);
      return;
    }
    if (!isObject(value)) return;
    if (visited.has(value)) return;
    visited.add(value);

    for (const [key, childValue] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (directDestinationKeys.has(normalizedKey)) {
        if (Array.isArray(childValue)) {
          for (const item of childValue) {
            const fid = extractPositiveString(item);
            if (fid) ids.add(fid);
          }
        } else {
          const fid = extractPositiveString(childValue);
          if (fid) ids.add(fid);
        }
        continue;
      }
      if (trusted && nestedDestinationKeys.has(normalizedKey)) {
        if (Array.isArray(childValue)) {
          for (const item of childValue) {
            const fid = extractPositiveString(item);
            if (fid) ids.add(fid);
          }
        } else {
          const fid = extractPositiveString(childValue);
          if (fid) ids.add(fid);
        }
        continue;
      }
      if (trustedContainerKeys.has(normalizedKey)) {
        collect(childValue, true);
      }
    }
  };

  collect(payload, false);

  return [...ids];
}

function buildUrl(host: string, path: string, params: Record<string, string | number | boolean | undefined | null> = {}) {
  const url = new URL(path, host);
  url.searchParams.set('pr', 'ucpro');
  url.searchParams.set('fr', 'pc');
  url.searchParams.set('uc_param_str', '');

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function getApiMessage(payload: unknown) {
  if (!isObject(payload)) return null;

  const data = isObject(payload.data) ? payload.data : {};
  const candidates = [
    data.fail_message,
    data.error_msg,
    data.err_msg,
    data.message,
    payload.message,
    payload.msg,
    payload.error,
    payload.err_msg,
  ];

  for (const candidate of candidates) {
    const message = extractString(candidate);
    if (message && !['ok', 'success'].includes(message.toLowerCase())) return message;
  }

  return null;
}

function taskStatus(payload: unknown) {
  if (isObject(payload) && isObject(payload.data)) {
    const status = extractPositiveString(payload.data.status ?? payload.data.task_status);
    if (status) return Number(status);
  }

  const status = extractFirstStringByKeys(payload, ['task_status']);
  return status ? Number(status) : null;
}

function taskIdFrom(payload: unknown) {
  return extractFirstStringByKeys(payload, ['task_id', 'taskid']);
}




function isTruthyApiStatus(value: unknown) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function isDeleteAccepted(payload: unknown) {
  if (!isObject(payload)) return false;
  if (isTruthyApiStatus(payload.status) || isTruthyApiStatus(payload.success)) return true;

  const data = isObject(payload.data) ? payload.data : {};
  return isTruthyApiStatus(data.status) || isTruthyApiStatus(data.success);
}

export function collectShareItems(payload: unknown): QuarkShareItem[] {
  const list = extractQuarkList(payload);
  return list
    .map((item) => {
      if (!isObject(item)) return null;
      const fid = extractPositiveString(item.fid || item.file_id);
      const fidToken = extractString(item.share_fid_token)
        || extractString(item.fid_token)
        || extractString(item.share_token);
      if (!fid || !fidToken) return null;

      const name = extractString(item.file_name) || extractString(item.name) || undefined;
      const shareItem: QuarkShareItem = {
        fid,
        fidToken,
        size: parseQuarkSizeText(item.size as string | number | undefined),
      };
      if (name) shareItem.name = name;

      return {
        ...shareItem,
      };
    })
    .filter((item): item is QuarkShareItem => !!item);
}

function isQuarkDirectoryItem(item: Record<string, unknown>) {
  return item.dir === true || item.file_type === 0 || item.type === 'folder';
}

function joinSharePath(parentPath: string, name: string) {
  const cleanName = name.replace(/\//g, '／').trim();
  return parentPath ? `${parentPath}/${cleanName}` : cleanName;
}

function collectShareTreeItems(payload: unknown, parentPath: string, parentFid: string): QuarkShareTreeItem[] {
  const list = extractQuarkList(payload);
  return list
    .map((item) => {
      if (!isObject(item)) return null;
      const fid = extractPositiveString(item.fid || item.file_id);
      if (!fid) return null;

      const name = extractString(item.file_name)
        || extractString(item.name)
        || extractString(item.title)
        || fid;
      const path = joinSharePath(parentPath, name);
      const fidToken = extractString(item.share_fid_token)
        || extractString(item.fid_token)
        || extractString(item.share_token);
      const dir = isQuarkDirectoryItem(item);
      const treeItem: QuarkShareTreeItem = {
        fid,
        name,
        path,
        parentPath,
        parentFid,
        size: dir ? null : parseQuarkSizeText(item.size as string | number | undefined),
        dir,
      };
      if (fidToken) treeItem.fidToken = fidToken;
      return treeItem;
    })
    .filter((item): item is QuarkShareTreeItem => !!item);
}

export class QuarkApiClient {
  private readonly cookie: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStage?: (event: QuarkApiStageEvent) => void;

  constructor(options: QuarkApiClientOptions) {
    this.cookie = options.cookie;
    this.fetchImpl = options.fetchImpl || fetch;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onStage = options.onStage;
  }

  /**
   * 只转存不建分享：把分享顶层可转存条目存进访客网盘目录（用户自助
   * 「转存到我的网盘」用）。缺省目标为夸克官方默认转存目录（来自：分享）。
   * 个别违规文件被源站过滤时不阻塞（allowPartialFiltered 语义），
   * 仅在一条都存不进时抛错。
   */
  async transferOnly(
    sourceShareUrl: string,
    options: { toPdirFid?: string } = {}
  ): Promise<{ savedFids: string[]; title?: string; filteredMessage: string | null }> {
    const token = await this.runStage('share_token', () => this.getShareToken(sourceShareUrl));
    const detail = await this.runStage('share_detail', () => this.collectShareTree(token.pwdId, token.stoken));
    const items = this.selectShareTreeSaveFrontier(detail.items);
    if (items.length === 0) {
      throw new Error(detail.filteredMessage || '夸克分享链接中未找到可转存文件');
    }
    const toPdirFid = options.toPdirFid ?? await this.runStage('save_folder', () => this.getSaveAsFolderFid());
    const savedFids = await this.runStage('save_shared_files', () => (
      this.saveShareTreeItemsWithToken(token, items, toPdirFid, false)
    ));
    if (savedFids.length === 0) {
      throw new Error('夸克转存任务完成但未返回文件 ID');
    }
    return { savedFids, title: token.title, filteredMessage: detail.filteredMessage };
  }

  async getShareToken(sourceShareUrl: string): Promise<QuarkShareToken> {
    const pwdId = extractQuarkPwdId(sourceShareUrl);
    if (!pwdId) {
      throw new Error(`不是有效的夸克网盘分享链接: ${sourceShareUrl}`);
    }

    const passcode = extractQuarkPasscode(sourceShareUrl);
    const payload = await this.post(QUARK_SHARE_HOST, '/1/clouddrive/share/sharepage/token', {
      pwd_id: pwdId,
      passcode,
      support_visit_limit_private_share: true,
    });
    const data = isObject(payload) && isObject(payload.data) ? payload.data : {};
    const stoken = extractString(data.stoken) || extractString(data.token);
    if (!stoken) {
      throw new Error('夸克分享链接 token 获取失败');
    }

    return {
      pwdId,
      passcode,
      stoken,
      title: extractString(data.title) || extractString(data.share_title) || undefined,
    };
  }

  async getShareDetail(pwdId: string, stoken: string, pdirFid = '0', page = 1) {
    return this.get(QUARK_SHARE_HOST, '/1/clouddrive/share/sharepage/detail', {
      ver: 2,
      pwd_id: pwdId,
      stoken,
      pdir_fid: pdirFid,
      force: 0,
      _page: page,
      _size: QUARK_SHARE_PAGE_SIZE,
      _fetch_banner: pdirFid === '0' && page === 1 ? 1 : 0,
      _fetch_share: pdirFid === '0' && page === 1 ? 1 : 0,
      fetch_relate_conversation: pdirFid === '0' && page === 1 ? 1 : 0,
      _fetch_total: 1,
      _sort: 'file_type:asc,updated_at:desc',
    });
  }

  async getSaveAsFolderFid() {
    try {
      const payload = await this.get(QUARK_DRIVE_HOST, '/1/clouddrive/share/sharepage/dir', { aver: 1 });
      const fid = extractFirstStringByKeys(payload, ['fid', 'dir_fid']);
      return fid || '0';
    } catch {
      return '0';
    }
  }

  async saveSharedFiles(input: {
    pwdId: string;
    stoken: string;
    items: QuarkShareItem[];
    toPdirFid: string;
    sourcePdirFid?: string;
  }) {
    const payload = await this.post(QUARK_SHARE_HOST, '/1/clouddrive/share/sharepage/save', {
      fid_list: input.items.map((item) => item.fid),
      fid_token_list: input.items.map((item) => item.fidToken),
      to_pdir_fid: input.toPdirFid,
      pwd_id: input.pwdId,
      stoken: input.stoken,
      pdir_fid: input.sourcePdirFid || '0',
      scene: 'link',
    });
    const taskId = taskIdFrom(payload);
    if (!taskId) {
      return extractQuarkSavedFids(payload);
    }

    const interval = this.taskInterval(payload);
    const taskPayload = await this.pollTask(taskId, interval);
    return extractQuarkSavedFids(taskPayload);
  }

  async deleteOwnedFilesByShareLink(shareLink: string): Promise<QuarkDeleteOwnedFilesResult> {
    const token = await this.getShareToken(shareLink);
    const detail = await this.collectShareTree(token.pwdId, token.stoken);
    const fids = [
      ...new Set(detail.items.map((item) => item.fid).filter(Boolean)),
    ];

    if (fids.length === 0) {
      throw new Error('未能从夸克分享链接中找到可删除的网盘文件');
    }

    return this.deleteOwnedFilesByFids(fids);
  }

  async inspectShareFids(shareLink: string) {
    const token = await this.getShareToken(shareLink);
    const detail = await this.collectShareTree(token.pwdId, token.stoken);
    if (detail.filteredMessage) throw new Error(detail.filteredMessage);
    return [
      ...new Set(detail.items.map((item) => item.fid).filter(Boolean)),
    ];
  }

  async inspectShareTree(shareLink: string): Promise<QuarkShareTreeItem[]> {
    const inspection = await this.inspectShareTreeDetailed(shareLink);
    return inspection.items;
  }

  async inspectShareTreeDetailed(shareLink: string): Promise<QuarkShareTreeDetailedInspection> {
    const token = await this.getShareToken(shareLink);
    const inspection = await this.collectShareTree(token.pwdId, token.stoken);
    if (inspection.filteredMessage && inspection.items.length === 0) {
      throw new Error(inspection.filteredMessage);
    }
    return inspection;
  }

  async saveShareTreeItems(
    sourceShareUrl: string,
    items: QuarkShareTreeItem[],
    toPdirFid: string
  ) {
    const token = await this.getShareToken(sourceShareUrl);
    return this.saveShareTreeItemsWithToken(token, items, toPdirFid);
  }

  private async saveShareTreeItemsWithToken(
    token: QuarkShareToken,
    items: QuarkShareTreeItem[],
    toPdirFid: string,
    refreshItems = true,
  ) {
    const freshItems = refreshItems
      ? await this.refreshShareTreeItemsForSave(token.pwdId, token.stoken, items)
      : items;
    const groups = new Map<string, QuarkShareItem[]>();
    for (const item of freshItems) {
      if (!item.fidToken) {
        throw new Error(`源分享文件缺少 fid token，无法转存: ${item.path || item.fid}`);
      }
      const sourcePdirFid = item.parentFid || '0';
      groups.set(sourcePdirFid, [
        ...(groups.get(sourcePdirFid) || []),
        {
          fid: item.fid,
          fidToken: item.fidToken,
          parentFid: sourcePdirFid,
          name: item.name,
          size: item.size,
        },
      ]);
    }
    if (groups.size === 0) return [];

    const savedFids: string[] = [];
    for (const [sourcePdirFid, saveItems] of groups) {
      try {
        savedFids.push(...await this.saveSharedFiles({
          pwdId: token.pwdId,
          stoken: token.stoken,
          items: saveItems,
          toPdirFid,
          sourcePdirFid,
        }));
      } catch (error) {
        const nestedSavedFids = error instanceof QuarkApiTransferError ? error.savedFids : [];
        const accumulatedSavedFids = [...new Set([...savedFids, ...nestedSavedFids])];
        if (accumulatedSavedFids.length === 0) throw error;
        throw new QuarkApiTransferError(
          error instanceof Error ? error.message : String(error),
          accumulatedSavedFids,
          error instanceof QuarkApiTransferError ? error.warning : null,
          error instanceof QuarkApiTransferError ? error.filteredFileCount : null,
        );
      }
    }
    return savedFids;
  }

  private selectShareTreeSaveFrontier(items: QuarkShareTreeItem[]) {
    const itemByFid = new Map(items.map((item) => [item.fid, item]));
    const saveableDirectoryFids = new Set(
      items.filter((item) => item.dir && item.fidToken).map((item) => item.fid),
    );
    const selected: QuarkShareTreeItem[] = [];
    const selectedFids = new Set<string>();

    for (const item of items) {
      if (!item.fidToken || selectedFids.has(item.fid)) continue;
      let parentFid = item.parentFid;
      const visited = new Set<string>();
      let coveredByDirectory = false;
      while (parentFid && parentFid !== '0' && !visited.has(parentFid)) {
        visited.add(parentFid);
        if (saveableDirectoryFids.has(parentFid)) {
          coveredByDirectory = true;
          break;
        }
        parentFid = itemByFid.get(parentFid)?.parentFid;
      }
      if (coveredByDirectory) continue;
      selectedFids.add(item.fid);
      selected.push(item);
    }

    return selected;
  }

  private async refreshShareTreeItemsForSave(
    pwdId: string,
    stoken: string,
    items: QuarkShareTreeItem[]
  ) {
    const groups = new Map<string, { parentPath: string; items: QuarkShareTreeItem[] }>();
    for (const item of items) {
      const sourcePdirFid = item.parentFid || '0';
      const group = groups.get(sourcePdirFid) || { parentPath: item.parentPath || '', items: [] };
      group.items.push(item);
      groups.set(sourcePdirFid, group);
    }

    const refreshed: QuarkShareTreeItem[] = [];
    for (const [sourcePdirFid, group] of groups) {
      const freshByFid = new Map<string, QuarkShareTreeItem>();
      for (let page = 1; ; page += 1) {
        const detail = await this.getShareDetail(pwdId, stoken, sourcePdirFid, page);
        this.assertShareDetailNotFiltered(detail);
        const pageItems = collectShareTreeItems(detail, group.parentPath, sourcePdirFid);
        for (const pageItem of pageItems) {
          freshByFid.set(pageItem.fid, pageItem);
        }
        if (pageItems.length < QUARK_SHARE_PAGE_SIZE) break;
      }

      for (const item of group.items) {
        const fresh = freshByFid.get(item.fid);
        if (!fresh?.fidToken) {
          throw new Error(`无法刷新源分享文件 token，无法转存: ${item.path || item.fid}`);
        }
        refreshed.push({
          ...item,
          fidToken: fresh.fidToken,
          parentFid: fresh.parentFid || sourcePdirFid,
          name: fresh.name || item.name,
          size: fresh.size ?? item.size,
          dir: fresh.dir,
        });
      }
    }

    return refreshed;
  }

  async deleteOwnedFilesByFids(fids: Array<string | number>): Promise<QuarkDeleteOwnedFilesResult> {
    const fidList = [...new Set(fids.map(String).map((fid) => fid.trim()).filter(Boolean))];
    if (fidList.length === 0) {
      throw new Error('缺少夸克我方文件 ID，无法删除网盘资源');
    }

    const payload = await this.post(QUARK_DRIVE_HOST, '/1/clouddrive/file/delete', {
      action_type: 2,
      filelist: fidList,
      exclude_fids: [],
    });
    const taskId = taskIdFrom(payload);
    if (taskId) {
      await this.pollTask(
        taskId,
        Math.min(this.taskInterval(payload), 2_000),
        120,
        QUARK_DELETE_TASK_TIMEOUT_MS,
      );
    } else if (!isDeleteAccepted(payload)) {
      throw new Error(getApiMessage(payload) || '夸克删除接口未确认删除任务');
    }

    return { deletedFileIds: fidList };
  }

  private async pollTask(taskId: string, intervalMs: number, maxAttempts = 120, maxDurationMs?: number) {
    let lastPayload: unknown = null;
    const deadline = maxDurationMs ? Date.now() + maxDurationMs : null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (deadline !== null && Date.now() >= deadline) break;
      if (attempt > 0 && intervalMs > 0) {
        const delay = deadline === null ? intervalMs : Math.min(intervalMs, Math.max(0, deadline - Date.now()));
        if (delay > 0) await this.sleep(delay);
      }
      if (deadline !== null && Date.now() >= deadline) break;
      const payload = await this.get(QUARK_DRIVE_HOST, '/1/clouddrive/task', {
        task_id: taskId,
        retry_index: attempt,
      });
      lastPayload = payload;

      const status = taskStatus(payload);
      if (status === 2) return payload;
      if (status === 3 || status === 4) {
        throw new Error(getApiMessage(payload) || '夸克任务执行失败');
      }
    }

    throw new Error(getApiMessage(lastPayload) || '夸克任务轮询超时');
  }

  private taskInterval(payload: unknown) {
    if (!isObject(payload) || !isObject(payload.metadata)) return 1000;
    const gap = Number(payload.metadata.tq_gap);
    if (!Number.isFinite(gap) || gap < 0) return 1000;
    return gap > 100 ? gap : gap * 1000;
  }

  private async collectShareTree(
    pwdId: string,
    stoken: string,
    pdirFid = '0',
    parentPath = '',
    traversal: QuarkShareTreeTraversalState = {
      visitedDirectories: new Set<string>(),
      visitedPages: new Set<string>(),
      seenItemFids: new Set<string>(),
      itemCount: 0,
    },
  ): Promise<QuarkShareTreeDetailedInspection> {
    // A provider can echo a directory node (or even a cyclic parent) in a
    // malformed response. FIDs are the stable identity; do not let a changing
    // derived path turn that cycle into unbounded recursion.
    const directoryKey = pdirFid;
    if (traversal.visitedDirectories.has(directoryKey)) {
      throw new Error('夸克分享目录返回了重复目录或循环引用，无法确认目录完整性');
    }
    if (traversal.visitedDirectories.size >= QUARK_SHARE_MAX_TREE_DIRECTORIES) {
      throw new Error('夸克分享目录层级超过安全读取上限，无法完整比较');
    }
    traversal.visitedDirectories.add(directoryKey);

    const items: QuarkShareTreeItem[] = [];
    const seenItemFids = new Set<string>();
    const filteredMessages = new Set<string>();
    let filteredFileCount: number | null = null;
    let reportedSize: number | null = null;
    let expectedTotal: number | null = null;
    let directoryTerminated = false;
    let directoryComplete = false;
    let parsedEveryRawItem = true;
    for (let page = 1; page <= QUARK_SHARE_MAX_TREE_PAGES; page += 1) {
      const detail = await this.getShareDetail(pwdId, stoken, pdirFid, page);
      const pageKey = `${pdirFid}\u0000${page}`;
      if (traversal.visitedPages.has(pageKey)) {
        throw new Error('夸克分享目录返回了重复分页，无法确认目录完整性');
      }
      traversal.visitedPages.add(pageKey);
      const filteredMessage = findQuarkFilteredFileMessage(detail);
      if (filteredMessage) filteredMessages.add(filteredMessage);
      const filteredInfo = findQuarkFilteredFileInfo(detail);
      if (filteredInfo?.count !== null && filteredInfo?.count !== undefined) {
        filteredFileCount = Math.max(filteredFileCount || 0, filteredInfo.count);
      }
      const detailSize = this.extractReportedShareSize(detail);
      if (detailSize !== null) reportedSize = Math.max(reportedSize || 0, detailSize);
      const rawItems = extractQuarkList(detail);
      const pageItems = collectShareTreeItems(detail, parentPath, pdirFid);
      if (pageItems.length !== rawItems.length) parsedEveryRawItem = false;
      const pagination = extractQuarkPaginationEvidence(detail);
      if (pagination.page !== null && pagination.page !== page) {
        throw new Error('夸克分享目录返回了错误页码，无法确认目录完整性');
      }
      if (pagination.pageSize !== null && (
        pagination.pageSize <= 0 || pagination.pageSize > QUARK_SHARE_PAGE_SIZE
      )) {
        throw new Error('夸克分享目录返回了无效分页大小，无法确认目录完整性');
      }
      if (rawItems.length > (pagination.pageSize || QUARK_SHARE_PAGE_SIZE)) {
        throw new Error('夸克分享目录返回条目数超过分页大小，无法确认目录完整性');
      }
      if (pagination.total !== null) {
        if (
          expectedTotal === null
          && traversal.itemCount + pagination.total >= QUARK_SHARE_MAX_TREE_ITEMS
        ) {
          throw new Error('夸克分享目录超过安全读取上限，无法完整比较');
        }
        if (expectedTotal !== null && pagination.total !== expectedTotal) {
          throw new Error('夸克分享目录总数在分页过程中发生变化，无法确认目录完整性');
        }
        expectedTotal = pagination.total;
      }
      for (const pageItem of pageItems) {
        if (seenItemFids.has(pageItem.fid)) {
          throw new Error('夸克分享目录分页返回了重复条目，无法确认目录完整性');
        }
        if (traversal.seenItemFids.has(pageItem.fid)) {
          if (pageItem.dir && traversal.visitedDirectories.has(pageItem.fid)) {
            throw new Error('夸克分享目录返回了重复目录或循环引用，无法确认目录完整性');
          }
          throw new Error('夸克分享目录树返回了跨目录重复条目，无法确认目录完整性');
        }
        seenItemFids.add(pageItem.fid);
        traversal.seenItemFids.add(pageItem.fid);
      }
      items.push(...pageItems);
      traversal.itemCount += rawItems.length;
      if (traversal.itemCount >= QUARK_SHARE_MAX_TREE_ITEMS) {
        throw new Error('夸克分享目录超过安全读取上限，无法完整比较');
      }

      const listedCount = seenItemFids.size;
      if (expectedTotal !== null) {
        if (listedCount > expectedTotal) {
          throw new Error('夸克分享目录条目数超过提供方总数，无法确认目录完整性');
        }
        if (listedCount === expectedTotal) {
          if (pagination.hasMore === true) {
            throw new Error('夸克分享目录总数与分页状态矛盾，无法确认目录完整性');
          }
          directoryTerminated = true;
          directoryComplete = parsedEveryRawItem;
          break;
        }
        if (pagination.hasMore === false || rawItems.length === 0) {
          throw new Error('夸克分享目录提前结束，无法确认目录完整性');
        }
        continue;
      }

      if (pagination.hasMore !== null) {
        if (!pagination.hasMore) {
          directoryTerminated = true;
          directoryComplete = parsedEveryRawItem;
          break;
        }
        if (rawItems.length === 0) {
          throw new Error('夸克分享目录分页未取得进展，无法确认目录完整性');
        }
        continue;
      }

      if (rawItems.length < QUARK_SHARE_PAGE_SIZE) {
        // Preserve visible data for legacy responses, but a short page alone is
        // not proof that the provider has no more entries.
        directoryTerminated = true;
        directoryComplete = false;
        break;
      }
    }

    if (!directoryTerminated) {
      throw new Error('夸克分享目录分页超过安全读取上限，无法确认目录完整性');
    }

    const nested: QuarkShareTreeItem[] = [];

    for (const item of items) {
      if (!item.dir) continue;
      const child = await this.collectShareTree(
        pwdId,
        stoken,
        item.fid,
        item.path,
        traversal,
      );
      nested.push(...child.items);
      if (child.completeness !== 'complete') directoryComplete = false;
      if (child.filteredMessage) filteredMessages.add(child.filteredMessage);
      if (child.filteredFileCount !== null && child.filteredFileCount !== undefined) {
        filteredFileCount = Math.max(filteredFileCount || 0, child.filteredFileCount);
      }
      if (child.reportedSize !== null && child.reportedSize !== undefined) {
        reportedSize = Math.max(reportedSize || 0, child.reportedSize);
      }
    }

    const allItems = [...items, ...nested];
    const filteredMessage = filteredMessages.values().next().value || null;
    const completeness = directoryComplete ? 'complete' : 'partial';
    const exactSizeBytes = getQuarkExactTreeSize(allItems, completeness, filteredMessage);
    return {
      items: allItems,
      filteredMessage,
      filteredFileCount,
      reportedSize,
      completeness,
      exactSizeBytes,
      sizeExact: exactSizeBytes !== null,
    };
  }

  private extractReportedShareSize(payload: unknown) {
    if (!isObject(payload)) return null;
    const data = isObject(payload.data) ? payload.data : {};
    const share = isObject(data.share) ? data.share : {};
    const metadata = isObject(payload.metadata) ? payload.metadata : {};
    for (const value of [share.size, data.share_size, metadata.size]) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const parsed = parseQuarkSizeText(value);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  private assertShareDetailNotFiltered(detail: unknown) {
    const filteredMessage = findQuarkFilteredFileMessage(detail);
    if (filteredMessage) throw new Error(filteredMessage);
  }

  private async runStage<T>(stage: QuarkApiStageEvent['stage'], action: () => Promise<T>) {
    const startedAt = Date.now();
    this.onStage?.({ stage, status: 'started' });

    try {
      const result = await action();
      this.onStage?.({ stage, status: 'completed', durationMs: Date.now() - startedAt });
      return result;
    } catch (error: unknown) {
      this.onStage?.({
        stage,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async get(host: string, path: string, params?: Record<string, string | number | boolean | undefined | null>) {
    return this.request(buildUrl(host, path, params), { method: 'GET' });
  }

  private async post(host: string, path: string, body: unknown, params?: Record<string, string | number | boolean | undefined | null>) {
    return this.request(buildUrl(host, path, params), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json;charset=UTF-8',
      },
    });
  }

  private async request(url: string, init: RequestInit) {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(QUARK_API_REQUEST_TIMEOUT_MS),
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://pan.quark.cn',
        referer: QUARK_REFERER,
        'user-agent': QUARK_USER_AGENT,
        cookie: this.cookie,
        ...(init.headers || {}),
      },
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const parsedUrl = new URL(url);
    const rawCode = isObject(payload) ? payload.code : null;
    const code = typeof rawCode === 'number' || typeof rawCode === 'string'
      ? rawCode
      : null;
    const numericCode = typeof code === 'number'
      ? code
      : typeof code === 'string' && /^\d+$/.test(code.trim())
        ? Number(code)
        : null;
    const message = getApiMessage(payload);
    const retryable = [408, 425, 429].includes(response.status)
      || response.status >= 500
      || numericCode === 429
      || numericCode === 32003;
    const shareTreeRequestScope = parsedUrl.pathname.endsWith('/share/sharepage/token')
      ? 'root' as const
      : parsedUrl.pathname.endsWith('/share/sharepage/detail')
        ? parsedUrl.searchParams.get('pdir_fid') === '0'
          ? 'root' as const
          : 'child' as const
        : undefined;

    if (!response.ok) {
      // 凭证失效（HTTP 401 / 业务码 31001）单独分类：转存流水线据此
      // 中止整轮并标记凭证，而不是把每部剧都计入普通失败重试。
      if (isCredentialErrorPayload(payload, response.status)) {
        throw new QuarkCredentialInvalidError(
          message || `夸克凭证已失效 (HTTP ${response.status})`
        );
      }
      throw new QuarkApiError(
        message || `夸克接口请求失败: ${response.status} ${response.statusText}`,
        {
          code,
          httpStatus: response.status,
          endpoint: parsedUrl.pathname,
          retryable,
          shareTreeRequestScope,
        },
      );
    }
    if (code !== null && code !== 0 && code !== '0') {
      if (isCredentialErrorPayload(payload, response.status)) {
        throw new QuarkCredentialInvalidError(message || '夸克凭证已失效');
      }
      throw new QuarkApiError(message || `夸克接口返回错误码 ${code}`, {
        code,
        httpStatus: response.status,
        endpoint: parsedUrl.pathname,
        retryable,
        shareTreeRequestScope,
      });
    }

    return payload;
  }
}

// ---------------------------------------------------------------------------
// kerkerker 扩展：在 kkpan 移植版之上补充短剧流水线所需的能力。
// 其余实现与上游 quark-api.client.ts 保持一致，便于后续对照更新。
// ---------------------------------------------------------------------------

export type QuarkOwnFileItem = {
  fid: string;
  name: string;
  size: number | null;
  dir: boolean;
};

export type QuarkDownloadUrlResult = {
  downloadUrl: string;
  fileName?: string;
  expiresInMs?: number | null;
};

export class QuarkCredentialInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuarkCredentialInvalidError';
  }
}

function isCredentialErrorPayload(payload: unknown, httpStatus: number) {
  // 未登录 / cookie 失效：夸克业务码 31001（账号未登录）或 HTTP 401
  const code = isObject(payload) ? payload.code : null;
  if (httpStatus === 401) return true;
  return code === 31001 || code === '31001';
}

export async function fetchQuarkDownloadUrlForFile(
  cookie: string,
  fid: string,
  fetchImpl: FetchLike = fetch,
): Promise<QuarkDownloadUrlResult> {
  // POST /file/download 返回 302 跳转到签名下载直链，禁止跟随以便读取 Location。
  const url = buildUrl(QUARK_DRIVE_HOST, '/1/clouddrive/file/download', {
    fid,
  });
  const response = await fetchImpl(url, {
    method: 'POST',
    body: JSON.stringify({ fids: [fid] }),
    redirect: 'manual',
    signal: AbortSignal.timeout(QUARK_API_REQUEST_TIMEOUT_MS),
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      origin: 'https://pan.quark.cn',
      referer: QUARK_REFERER,
      'user-agent': QUARK_USER_AGENT,
      cookie,
    },
  });

  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) {
    return { downloadUrl: location };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (isCredentialErrorPayload(payload, response.status)) {
    throw new QuarkCredentialInvalidError(
      getApiMessage(payload) || `夸克凭证已失效 (HTTP ${response.status})`
    );
  }
  // 部分账号形态不 302，而是 JSON 返回 data.download_url
  const directUrl = extractFirstStringByKeys(payload, ['download_url', 'downloadUrl']);
  if (directUrl) {
    return { downloadUrl: directUrl };
  }
  throw new QuarkApiError(
    getApiMessage(payload) || `夸克下载直链获取失败: HTTP ${response.status}`,
    {
      code: isObject(payload) ? (payload.code as string | number | null) : null,
      httpStatus: response.status,
      endpoint: '/1/clouddrive/file/download',
    },
  );
}

/** 试播树遍历的最大目录深度（剧名/剧集一般两层以内，留一档余量） */
const QUARK_VIDEO_WALK_MAX_DEPTH = 3;
/** 试播文件清单上限（防超大盘剧把响应撑爆） */
const QUARK_VIDEO_FILE_LIMIT = 500;

const QUARK_VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm2ts', 'webm', 'm4v', 'mpg', 'mpeg',
]);

/** 按扩展名粗筛视频文件（目录恒为 false） */
export function isQuarkVideoFileItem(item: QuarkOwnFileItem): boolean {
  if (item.dir) return false;
  const dotIndex = item.name.lastIndexOf('.');
  if (dotIndex < 0) return false;
  return QUARK_VIDEO_EXTENSIONS.has(item.name.slice(dotIndex + 1).toLowerCase());
}

export type QuarkTranscodePlayResult = {
  playUrl: string;
  resolution: string;
};

/**
 * file/v2/play 转码播放直链（m3u8/fmp4）：只对已转存到自己网盘的文件有效。
 * 浏览器原生 <video> 播不了 m3u8（Chrome 需要 hls.js），这里只作为
 * 原画直链拿不到时的兜底。
 */
export async function fetchQuarkTranscodePlayUrlForFile(
  cookie: string,
  fid: string,
  fetchImpl: FetchLike = fetch,
): Promise<QuarkTranscodePlayResult> {
  const url = buildUrl(QUARK_DRIVE_HOST, '/1/clouddrive/file/v2/play', {
    pr: 'ucpro',
    fr: 'pc',
  });
  const response = await fetchImpl(url, {
    method: 'POST',
    body: JSON.stringify({
      fid,
      resolutions: 'normal,low,high,super,2k,4k',
      supports: 'fmp4',
    }),
    signal: AbortSignal.timeout(QUARK_API_REQUEST_TIMEOUT_MS),
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      origin: 'https://pan.quark.cn',
      referer: QUARK_REFERER,
      'user-agent': QUARK_USER_AGENT,
      cookie,
    },
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (isCredentialErrorPayload(payload, response.status)) {
    throw new QuarkCredentialInvalidError(
      getApiMessage(payload) || `夸克凭证已失效 (HTTP ${response.status})`
    );
  }
  if (!response.ok) {
    throw new QuarkApiError(
      getApiMessage(payload) || `夸克转码播放直链获取失败: HTTP ${response.status}`,
      {
        code: isObject(payload) ? (payload.code as string | number | null) : null,
        httpStatus: response.status,
        endpoint: '/1/clouddrive/file/v2/play',
        retryable: response.status >= 500 || response.status === 429,
      },
    );
  }

  const data = isObject(payload) && isObject(payload.data) ? payload.data : {};
  const videoList = Array.isArray(data.video_list) ? data.video_list : [];
  const resolutionRank: Record<string, number> = {
    low: 1, normal: 2, high: 3, super: 4, '2k': 5, '4k': 6,
  };
  let best: { url: string; resolution: string } | null = null;
  for (const entry of videoList) {
    if (!isObject(entry)) continue;
    const playUrl = extractString(entry.url) || extractString(entry.video_url);
    if (!playUrl) continue;
    const resolution = extractString(entry.resolution) || 'unknown';
    if (!best || (resolutionRank[resolution] ?? 0) > (resolutionRank[best.resolution] ?? 0)) {
      best = { url: playUrl, resolution };
    }
  }
  if (!best) {
    throw new QuarkApiError('夸克转码播放直链为空（可能未完成转码）', {
      endpoint: '/1/clouddrive/file/v2/play',
    });
  }
  return { playUrl: best.url, resolution: best.resolution };
}

export type QuarkPlayUrlResult = {
  playUrl: string;
  /** mp4=原画直链（<video> 可直接播）；m3u8=转码流（需 hls.js） */
  kind: 'mp4' | 'm3u8';
  resolution?: string;
  fileName?: string;
};

/**
 * 试播直链：优先原画下载直链（mp4 原生可播、无需等转码），
 * 拿不到再退 file/v2/play 转码流。直链由夸克 CDN 签发，浏览器裸播
 * 是否被 Referer/UA/IP 拦截由实测回答——这正是 PoC 要验证的问题。
 */
export async function fetchQuarkPlayUrlForFile(
  cookie: string,
  fid: string,
  fetchImpl: FetchLike = fetch,
): Promise<QuarkPlayUrlResult> {
  try {
    const download = await fetchQuarkDownloadUrlForFile(cookie, fid, fetchImpl);
    return {
      playUrl: download.downloadUrl,
      kind: 'mp4',
      ...(download.fileName ? { fileName: download.fileName } : {}),
    };
  } catch (error) {
    // 凭证失效必须上抛，其余错误降级走转码
    if (error instanceof QuarkCredentialInvalidError) throw error;
  }
  const transcode = await fetchQuarkTranscodePlayUrlForFile(cookie, fid, fetchImpl);
  return { playUrl: transcode.playUrl, kind: 'm3u8', resolution: transcode.resolution };
}

/**
 * 从转存根条目（transferOnly 返回的 savedFids，通常是剧名文件夹，
 * 也可能是散装剧集文件）收集全部视频文件。目录递归向下（限深），
 * 根层级非目录条目原样保留（转存根就是剧集文件本身的情况）。
 */
export async function collectQuarkVideoFiles(
  cookie: string,
  roots: QuarkOwnFileItem[],
  fetchImpl: FetchLike = fetch,
): Promise<QuarkOwnFileItem[]> {
  const files: QuarkOwnFileItem[] = [];
  const visited = new Set<string>();

  const walk = async (item: QuarkOwnFileItem, depth: number) => {
    if (visited.has(item.fid) || files.length >= QUARK_VIDEO_FILE_LIMIT) return;
    visited.add(item.fid);
    if (!item.dir) {
      // 根层级条目不按扩展名过滤（转存根即文件）；子层级只收视频
      if (depth === 0 || isQuarkVideoFileItem(item)) files.push(item);
      return;
    }
    if (depth >= QUARK_VIDEO_WALK_MAX_DEPTH) return;
    let children: QuarkOwnFileItem[] = [];
    try {
      children = await listQuarkOwnDirectory(cookie, item.fid, fetchImpl);
    } catch {
      children = [];
    }
    for (const child of children) await walk(child, depth + 1);
  };

  for (const root of roots) await walk(root, 0);
  return files;
}

/**
 * file/sort 分页证据的宽松版：字段矛盾或解析失败时全部按「未知」处理，
 * 由调用方回退到空页/重复页终止（分享树那边是强校验直接抛错，这里不能
 * 因为证据异常就丢掉已列到的目录内容）。
 */
function lenientPaginationEvidence(payload: unknown): QuarkSharePaginationEvidence {
  try {
    return extractQuarkPaginationEvidence(payload);
  } catch {
    return { total: null, hasMore: null, page: null, pageSize: null };
  }
}

export async function listQuarkOwnDirectory(
  cookie: string,
  pdirFid: string,
  fetchImpl: FetchLike = fetch,
): Promise<QuarkOwnFileItem[]> {
  const items: QuarkOwnFileItem[] = [];
  const seenFids = new Set<string>();
  for (let page = 1; page <= QUARK_OWN_DIR_MAX_PAGES; page += 1) {
    const url = buildUrl(QUARK_DRIVE_HOST, '/1/clouddrive/file/sort', {
      pdir_fid: pdirFid,
      _page: page,
      _size: QUARK_SHARE_PAGE_SIZE,
      _fetch_total: 1,
      _fetch_sub_dirs: 0,
      _sort: 'file_type:asc,file_name:asc',
    });
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(QUARK_API_REQUEST_TIMEOUT_MS),
      headers: {
        accept: 'application/json, text/plain, */*',
        referer: QUARK_REFERER,
        'user-agent': QUARK_USER_AGENT,
        cookie,
      },
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (isCredentialErrorPayload(payload, response.status)) {
      throw new QuarkCredentialInvalidError(
        getApiMessage(payload) || `夸克凭证已失效 (HTTP ${response.status})`
      );
    }
    if (!response.ok) {
      throw new QuarkApiError(
        getApiMessage(payload) || `夸克目录读取失败: HTTP ${response.status}`,
        {
          code: isObject(payload) ? (payload.code as string | number | null) : null,
          httpStatus: response.status,
          endpoint: '/1/clouddrive/file/sort',
          retryable: response.status >= 500 || response.status === 429,
        },
      );
    }

    const pageItems = (isObject(payload) ? extractQuarkList(payload.data ?? payload) : [])
      .map((item) => {
        if (!isObject(item)) return null;
        const fid = extractPositiveString(item.fid || item.file_id);
        if (!fid) return null;
        return {
          fid,
          name: extractString(item.file_name) || fid,
          size: parseQuarkSizeText(item.size as string | number | undefined),
          dir: isQuarkDirectoryItem(item),
        };
      })
      .filter((item): item is QuarkOwnFileItem => !!item);
    // 空页、或整页都是重复 fid（接口原地翻页）都说明没有更多数据
    if (pageItems.length === 0) break;
    let added = 0;
    for (const item of pageItems) {
      if (seenFids.has(item.fid)) continue;
      seenFids.add(item.fid);
      items.push(item);
      added += 1;
    }
    if (added === 0) break;

    // 优先用接口自带的分页证据判断是否还有下一页：夸克偶发「短页但后面
    // 还有数据」，条目数不足一页不能当作目录结束的依据——三件套按名称
    // 序排在剧集合集最末尾，提前停就会漏掉封面/简介/metadata。
    const evidence = lenientPaginationEvidence(payload);
    if (evidence.hasMore === false) break;
    if (evidence.hasMore === true) continue;
    if (evidence.total !== null && items.length >= evidence.total) break;
  }
  return items;
}

export async function validateQuarkCredential(
  cookie: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ memberId: string | null; nickname: string | null }> {
  const url = buildUrl(QUARK_DRIVE_HOST, '/1/clouddrive/member', {});
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(QUARK_API_REQUEST_TIMEOUT_MS),
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: QUARK_REFERER,
      'user-agent': QUARK_USER_AGENT,
      cookie,
    },
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (isCredentialErrorPayload(payload, response.status)) {
    throw new QuarkCredentialInvalidError(
      getApiMessage(payload) || '夸克凭证已失效，请重新粘贴 cookie'
    );
  }
  if (!response.ok) {
    throw new QuarkApiError(
      getApiMessage(payload) || `夸克凭证校验失败: HTTP ${response.status}`,
      { httpStatus: response.status, endpoint: '/1/clouddrive/member' }
    );
  }
  const data = isObject(payload) && isObject(payload.data) ? payload.data : {};
  return {
    memberId: extractString(data.member_id) ?? null,
    nickname: extractString(data.nickname) ?? null,
  };
}
