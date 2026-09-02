"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { useScrollState } from "@/hooks/useScrollState";
import { Navbar } from "@/components/home/Navbar";
import { EmptyState } from "@/components/home/EmptyState";
import { ErrorState } from "@/components/home/ErrorState";
import { PaginationNav } from "@/components/home/PaginationNav";
import ShortDramaCard from "@/components/short-drama/ShortDramaCard";
import { SearchModal } from "@/components/short-drama/SearchModal";
import { HOME_PAGE_SIZE, SITE_NAME, tagPath } from "@/lib/seo";

/** 下拉自动加载开关的 localStorage 键（1=开，0/缺失=关） */
const AUTO_LOAD_KEY = "home-auto-load";

/**
 * 「加载更多」写入 history.state 的标记：页码（1..N 累计到第 N 页）+
 * 滚动位置。Next 只按自己的路由导航记录历史条目，replaceState 改地址栏
 * 不改变其缓存；返回时靠这些标记识别 load-more 条目，从 sessionStorage
 * 快照还原累计列表并还原滚动（数字跳页的 push 条目没有标记，由 Next
 * 缓存原样恢复）。
 */
const LOAD_MORE_PAGE_FLAG = "__homeLoadMorePage";
const LOAD_MORE_SCROLL_FLAG = "__homeLoadMoreScroll";

/** 返回恢复快照的 sessionStorage 键前缀（按 tag/search 分作用域） */
const SNAPSHOT_KEY_PREFIX = "home-list-snapshot|";
/** 快照条数上限：sessionStorage 配额有限，超长不写（返回时退回第 1 页） */
const SNAPSHOT_MAX_ITEMS = 2000;

interface HomeListSnapshot {
  dramas: HomePageDramaItem[];
  total: number;
  page: number;
  cursor: string | null;
  hasMore: boolean;
}

function snapshotKey(tag?: string, search?: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${tag ?? ""}|${search ?? ""}`;
}

function readSnapshot(tag?: string, search?: string): HomeListSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(snapshotKey(tag, search));
    if (!raw) return null;
    const snap = JSON.parse(raw) as HomeListSnapshot;
    if (!Array.isArray(snap.dramas) || snap.dramas.length === 0) return null;
    return snap;
  } catch {
    return null;
  }
}

function writeSnapshot(snap: HomeListSnapshot, tag?: string, search?: string): void {
  if (snap.dramas.length > SNAPSHOT_MAX_ITEMS) return;
  try {
    window.sessionStorage.setItem(snapshotKey(tag, search), JSON.stringify(snap));
  } catch {
    // 配额/隐私模式写失败：只影响返回恢复（退回第 1 页）
  }
}

export interface HomePageDramaItem {
  id: string;
  title: string;
  episode_count?: number;
  tags: string[];
  cover_url?: string;
  publish_date?: string;
}

export interface HomePageInitialData {
  dramas: HomePageDramaItem[];
  total: number;
  page: number;
  limit: number;
  /** 是否还有下一页（服务端按 offset 口径判定，仅首屏用） */
  has_more: boolean;
  /** 「加载更多」续页游标（keyset，锚定末条；null 表示列表为空） */
  next_cursor: string | null;
}

interface HomePageClientProps {
  /** 服务端取好的首屏数据（含筛选词）；null 表示服务端取数失败 */
  initialData: HomePageInitialData | null;
  initialError: string | null;
  activeTag?: string;
  initialSearch?: string;
}

interface ListResponse {
  code: number;
  data?: {
    dramas: HomePageDramaItem[];
    total: number;
    page: number;
    limit: number;
    has_more: boolean;
    next_cursor: string | null;
  };
}

/**
 * 首页客户端壳：首屏与筛选（tag/search）由服务端组件取数直出。
 * 页码即 URL（?page=N）：数字跳页走 router.push（服务端直出目标页，
 * 返回/前进/刷新由 Next 按页码还原）；「加载更多」走客户端 keyset 游标
 * 追加（以上一页末条为锚点，后台持续写入也不重不漏），成功后 replaceState
 * 把页码同步进地址栏、打历史标记并把累计列表快照存进 sessionStorage，
 * 返回时挂载逻辑按快照原样还原。客户端只负责追加与搜索弹层等交互。
 */
export function HomePageClient({
  initialData,
  initialError,
  activeTag,
  initialSearch,
}: HomePageClientProps) {
  const router = useRouter();
  const [showSearch, setShowSearch] = useState(false);
  const scrolled = useScrollState(50);
  // router.push 跳页过渡期间挂起（isPending），分页器据此禁用交互
  const [isNavigating, startNavigation] = useTransition();

  const [dramas, setDramas] = useState<HomePageDramaItem[]>(initialData?.dramas ?? []);
  const [total, setTotal] = useState(initialData?.total ?? 0);
  const [page, setPage] = useState(initialData?.page ?? 1);
  // keyset 游标链：始终锚定已渲染末条，「加载更多」据此续页
  const [cursor, setCursor] = useState<string | null>(initialData?.next_cursor ?? null);
  const [hasMore, setHasMore] = useState(initialData?.has_more ?? false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // 下拉自动加载开关（localStorage 持久化，默认关）：开启后滚动近底部自动追加
  const [autoLoad, setAutoLoad] = useState(false);
  const [autoLoadReady, setAutoLoadReady] = useState(false);

  const activeRequest = useRef(0);
  const loadingRef = useRef(false);
  // 已渲染列表镜像：loadMore 组装合并结果与快照时读取最新值
  // （函数式 setState 拿不到组装结果，不能用副作用写在 updater 里）
  const dramasRef = useRef(dramas);
  dramasRef.current = dramas;
  const pageSize = initialData?.limit ?? HOME_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /** 当前累计列表写快照（返回恢复用）；游标/页码随快照一起存 */
  const saveSnapshot = useCallback(
    (next: HomeListSnapshot) => writeSnapshot(next, activeTag, initialSearch),
    [activeTag, initialSearch]
  );

  /** 把当前页码写进地址栏；skip 时页码回 1，查询串原样保留 */
  const syncPageToUrl = useCallback(
    (targetPage: number, method: "replace" | "push") => {
      const params = new URLSearchParams(window.location.search);
      if (targetPage > 1) params.set("page", String(targetPage));
      else params.delete("page");
      const query = params.toString();
      const url = query ? `/?${query}` : "/";
      if (method === "replace") {
        // 保留 Next 路由的 history.state 并叠加 load-more 标记（页码 +
        // 滚动位置）：返回时据此识别该条目需重建累计列表（见挂载恢复 effect）
        window.history.replaceState(
          {
            ...(window.history.state ?? {}),
            [LOAD_MORE_PAGE_FLAG]: targetPage,
            [LOAD_MORE_SCROLL_FLAG]: Math.round(window.scrollY),
          },
          "",
          url
        );
      } else {
        router.push(url, { scroll: true });
      }
    },
    [router]
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loadingRef.current) return;
    loadingRef.current = true;
    const requestId = ++activeRequest.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const params = new URLSearchParams({
        after: cursor,
        limit: String(pageSize),
      });
      if (activeTag) params.set("tag", activeTag);
      if (initialSearch) params.set("search", initialSearch);
      const response = await fetch(`/api/short-dramas?${params.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as ListResponse;
      if (requestId !== activeRequest.current) return;
      if (payload.code === 200 && payload.data) {
        // 追加前按 id 去重兜底（keyset 已保证不重不漏，防异常数据触发
        // React 重复 key）；页码按实际新增递增，空页不虚增
        const prev = dramasRef.current;
        const seen = new Set(prev.map((d) => d.id));
        const merged = [...prev, ...payload.data.dramas.filter((d) => !seen.has(d.id))];
        const nextPage = merged.length > prev.length ? page + 1 : page;
        setDramas(merged);
        setTotal(payload.data.total);
        setPage(nextPage);
        setCursor(payload.data.next_cursor);
        setHasMore(payload.data.has_more);
        saveSnapshot({
          dramas: merged,
          total: payload.data.total,
          page: nextPage,
          cursor: payload.data.next_cursor,
          hasMore: payload.data.has_more,
        });
        // 追加成功后地址栏同步为最新页码（替换不新增历史）
        if (nextPage !== page) syncPageToUrl(nextPage, "replace");
      } else {
        setLoadMoreError("加载失败，请稍后重试");
      }
    } catch (fetchError) {
      if (requestId !== activeRequest.current) return;
      console.warn("短剧列表加载失败:", fetchError);
      setLoadMoreError("网络异常，请稍后重试");
    } finally {
      if (requestId === activeRequest.current) setLoadingMore(false);
      loadingRef.current = false;
    }
  }, [cursor, page, pageSize, activeTag, initialSearch, syncPageToUrl, saveSnapshot]);

  // 读取/持久化自动加载开关；水合后再启用，避免 SSR/CSR 不一致
  useEffect(() => {
    try {
      setAutoLoad(window.localStorage.getItem(AUTO_LOAD_KEY) === "1");
    } catch {
      // 隐私模式等 localStorage 不可用：保持默认关
    }
    setAutoLoadReady(true);
  }, []);

  // load-more 历史条目的返回恢复：从详情页 back 回来时，Next 会复用
  // 进入前的路由缓存（第 1 页首屏数据），但地址栏页码被 replaceState
  // 更新过。history.state 里的标记说明当时累计到了第 N 页，这里从
  // sessionStorage 快照原样还原累计列表（与离开时所見完全一致，也避免
  // 重拉 1..N 在数据持续写入下再次漂移），并还原滚动位置。仅水合后跑
  // 一次，不拦截数字跳页（push 条目无标记，走 Next 自身缓存恢复）。
  useEffect(() => {
    const state = (window.history.state ?? {}) as Record<string, unknown>;
    const flaggedPage = Number(state[LOAD_MORE_PAGE_FLAG]);
    if (!Number.isInteger(flaggedPage) || flaggedPage <= 1) return;
    const snap = readSnapshot(activeTag, initialSearch);
    if (snap) {
      setDramas(snap.dramas);
      setTotal(snap.total);
      setPage(snap.page);
      setCursor(snap.cursor);
      setHasMore(snap.hasMore);
      const savedScroll = Number(state[LOAD_MORE_SCROLL_FLAG]);
      if (Number.isFinite(savedScroll) && savedScroll > 0) {
        // rAF 等 DOM 提交后再滚
        requestAnimationFrame(() => window.scrollTo(0, savedScroll));
      }
      return;
    }
    // 快照缺失（新开标签页/被清理/超上限未写）：状态只有第 1 页，
    // 把地址栏页码与列表对齐回 1，并清掉 load-more 标记
    const params = new URLSearchParams(window.location.search);
    params.delete("page");
    const query = params.toString();
    const nextState = { ...state };
    delete nextState[LOAD_MORE_PAGE_FLAG];
    delete nextState[LOAD_MORE_SCROLL_FLAG];
    window.history.replaceState(nextState, "", query ? `/?${query}` : "/");
    // 水合后仅执行一次：依赖数组故意留空
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleAutoLoad = useCallback(() => {
    setAutoLoad((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(AUTO_LOAD_KEY, next ? "1" : "0");
      } catch {
        // 写不进去就只影响本次会话
      }
      return next;
    });
  }, []);

  // 自动加载：滚动近底部时自动追加下一页（开关开启且还有更多时）
  useEffect(() => {
    if (!autoLoad || !hasMore) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (
          window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 800
        ) {
          loadMore();
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [autoLoad, hasMore, loadMore]);

  // 数字分页跳页：页码写进 URL 并 router.push，服务端直出目标页
  // （URL 即状态，返回/前进/刷新都能还原当前页）
  const handlePageNavigate = useCallback(
    (targetPage: number) => {
      if (targetPage === page || isNavigating) return;
      activeRequest.current += 1; // 使进行中的「加载更多」请求失效
      setLoadMoreError(null);
      startNavigation(() => {
        syncPageToUrl(targetPage, "push");
      });
    },
    [page, isNavigating, syncPageToUrl]
  );

  const handleTagSelect = useCallback(
    (tag: string | null) => {
      // 标签筛选跳独立落地页（SEO 内链主体）；清除回首页
      router.push(tag ? tagPath(tag) : "/");
    },
    [router]
  );

  const handleSearch = useCallback(
    (keyword: string) => {
      setShowSearch(false);
      // 搜索语义是全局找剧：清掉标签筛选，否则 search+tag 组合几乎必然空结果
      router.push(`/?search=${encodeURIComponent(keyword)}`);
    },
    [router]
  );

  const clearSearch = useCallback(() => router.push("/"), [router]);
  const retry = useCallback(() => router.refresh(), [router]);

  return (
    <div className="min-h-screen bg-black">
      <Navbar scrolled={scrolled} onSearchOpen={() => setShowSearch(true)} />

      {showSearch && (
        <SearchModal onClose={() => setShowSearch(false)} onSearch={handleSearch} />
      )}

      <main className="relative z-10 pt-24 px-4 md:px-12 pb-8">
        {/*
          页面主标题视觉隐藏（SEO/无障碍保留 h1）：
          头部不再展示大标语，筛选状态由标签行高亮 + 下方小字承担
        */}
        <h1 className="sr-only">
          {activeTag
            ? `${SITE_NAME}｜「${activeTag}」标签短剧`
            : initialSearch
              ? `${SITE_NAME}｜「${initialSearch}」搜索结果`
              : `${SITE_NAME}｜精选短剧合集`}
        </h1>

        {/* 筛选状态提示：仅在有筛选词时显示（标签行默认无提示，靠高亮表达） */}
        {(activeTag || initialSearch) && (
          <div className="mb-4 flex items-center gap-2 text-sm text-gray-400">
            {activeTag ? (
              <>
                <span>
                  标签：<span className="text-red-500">{activeTag}</span>
                </span>
                <button
                  onClick={() => handleTagSelect(null)}
                  className="text-gray-500 hover:text-white transition-colors"
                >
                  清除
                </button>
              </>
            ) : (
              <>
                <span>
                  搜索：<span className="text-red-500">{initialSearch}</span>
                </span>
                <button
                  onClick={clearSearch}
                  className="text-gray-500 hover:text-white transition-colors"
                >
                  清除
                </button>
              </>
            )}
          </div>
        )}

        {initialError ? (
          <ErrorState error={initialError} onRetry={retry} />
        ) : total === 0 ? (
          <EmptyState onRetry={retry} />
        ) : (
          <>
            {/* 海报墙 */}
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 gap-3 md:gap-4">
              {dramas.map((drama, index) => (
                <ShortDramaCard key={drama.id} drama={drama} priority={index < 8} />
              ))}
            </div>

            {/* 底部分页区：加载更多 / 自动加载开关 / 数字分页选择器 */}
            {total > 0 && (
              <div className="mt-10 flex flex-col items-center gap-4">
                {loadMoreError && (
                  <p className="text-sm text-red-400">{loadMoreError}</p>
                )}
                {hasMore && (
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300 hover:text-white disabled:opacity-50 transition-colors"
                  >
                    {loadingMore ? "加载中…" : "加载更多"}
                    <svg
                      aria-hidden
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                <PaginationNav
                  current={page}
                  total={totalPages}
                  onNavigate={handlePageNavigate}
                  disabled={loadingMore || isNavigating}
                />
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                  <input
                    type="checkbox"
                    checked={autoLoadReady ? autoLoad : false}
                    onChange={toggleAutoLoad}
                    className="h-3.5 w-3.5 accent-red-600"
                  />
                  滚动到底部时自动加载更多
                </label>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
