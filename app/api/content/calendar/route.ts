import { NextRequest, NextResponse } from "next/server";
import {
  createProfileInvocation,
  getRequestPluginProfileId,
  invokeProfilePlugin,
  type ContentCalendarCandidate,
  type PluginPage,
} from "@/lib/plugins";
import { pluginFailureResponse } from "@/lib/plugins/http-error";
import type { CalendarResponse } from "@/types/content-calendar";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31;

function isIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function rangeDays(start: string, end: string): number {
  return Math.floor(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      (24 * 60 * 60 * 1000)
  ) + 1;
}

function preferredTitle(
  values: readonly { locale: string; value: string }[],
  locale: string
): string {
  const exact = values.find((item) => item.locale.toLowerCase() === locale.toLowerCase());
  return exact?.value || values[0]?.value || "";
}

function preferredOverview(
  values: readonly { locale: string; value: string }[] | undefined,
  locale: string
): string | undefined {
  if (!values) return undefined;
  return preferredTitle(values, locale) || undefined;
}

function showIdFromEventId(eventId: string): number {
  const value = Number(eventId.split(":", 1)[0]);
  return Number.isSafeInteger(value) ? value : 0;
}

function toLegacyEntry(
  candidate: ContentCalendarCandidate,
  locale: string
): CalendarResponse["days"][number]["entries"][number] | null {
  const title = preferredTitle(candidate.titles, locale);
  const calendar = candidate.calendar;
  if (!title || !calendar.airDate) return null;

  const external = candidate.externalRefs[0];
  const isDouban = external?.providerId === "kerkerker.douban-content";
  const rating = calendar.rating ?? Number(candidate.preview?.rating || 0);
  return {
    show_id: showIdFromEventId(calendar.eventId),
    event_id: calendar.eventId,
    show_name: title,
    show_name_cn: title,
    season_number: calendar.seasonNumber,
    episode_number: calendar.episodeNumber,
    episode_name: calendar.episodeName || "",
    air_date: calendar.airDate,
    poster: calendar.posterUrl || candidate.preview?.posterUrl || "",
    backdrop: calendar.backdropUrl,
    overview: preferredOverview(candidate.overview, locale),
    vote_average: Number.isFinite(rating) ? rating : 0,
    ...(external
      ? { provider_id: external.providerId, external_id: external.externalId }
      : {}),
    ...(isDouban && external?.externalId ? { douban_id: external.externalId } : {}),
    ...(isDouban && candidate.preview?.rating ? { douban_rating: candidate.preview.rating } : {}),
  };
}

/** Public host boundary for profile-selected, read-only content calendar data. */
export async function GET(request: NextRequest) {
  const today = new Date().toISOString().slice(0, 10);
  const defaultEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const start = request.nextUrl.searchParams.get("start_date")?.trim() || today;
  const end = request.nextUrl.searchParams.get("end_date")?.trim() || defaultEnd;
  const requestedRegion = request.nextUrl.searchParams.get("region")?.trim() || undefined;

  if (
    !isIsoDate(start) ||
    !isIsoDate(end) ||
    Date.parse(`${end}T00:00:00Z`) < Date.parse(`${start}T00:00:00Z`) ||
    rangeDays(start, end) > MAX_RANGE_DAYS ||
    (requestedRegion !== undefined && !/^[A-Z]{2}$/.test(requestedRegion))
  ) {
    return NextResponse.json(
      { code: 400, message: "日历查询参数无效", data: null },
      { status: 400 }
    );
  }

  let profileId = "unknown";
  try {
    profileId = getRequestPluginProfileId(request);
    const { context } = createProfileInvocation({
      profileId,
      capability: "content.calendar",
      signal: request.signal,
      timeoutMs: 15_000,
    });
    if (requestedRegion !== undefined && requestedRegion !== context.region) {
      return NextResponse.json(
        { code: 400, message: "region 必须与当前插件画像一致", data: null },
        { status: 400 }
      );
    }
    const page = await invokeProfilePlugin<PluginPage<ContentCalendarCandidate>>({
      profileId,
      capability: "content.calendar",
      operation: "calendar",
      context,
      request: { from: start, to: end, region: context.region },
    });

    const days = new Map<string, CalendarResponse["days"][number]["entries"]>();
    for (const candidate of page.items) {
      const entry = toLegacyEntry(candidate, context.locale);
      if (!entry) continue;
      const entries = days.get(entry.air_date) || [];
      entries.push(entry);
      days.set(entry.air_date, entries);
    }

    const data: CalendarResponse = {
      start_date: start,
      end_date: end,
      days: [...days.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, entries]) => ({ date, entries })),
      total: [...days.values()].reduce((count, entries) => count + entries.length, 0),
    };
    return NextResponse.json({ code: 200, message: "获取成功", data });
  } catch (error) {
    console.error("内容日历失败:", error);
    return pluginFailureResponse(error, profileId, "内容日历失败");
  }
}
