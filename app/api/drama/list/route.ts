import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse, DramaListData, VodSource } from '@/types/drama';

interface DramaListItem {
  vod_id: number;
  vod_name: string;
  vod_pic?: string;
  vod_remarks?: string;
  type_name?: string;
  vod_time?: string;
  vod_play_from?: string;
  vod_sub?: string;
  vod_actor?: string;
  vod_director?: string;
  vod_area?: string;
  vod_year?: string;
  vod_score?: string;
  vod_total?: number;
  vod_blurb?: string;
  vod_class?: string;
}

interface DramaListResponse {
  code: number;
  msg: string;
  page: number;
  pagecount: number;
  limit: number;
  total: number;
  list: DramaListItem[];
}

interface ProxySearchResponse {
  success: boolean;
  message: string;
  data: DramaListItem[];
}

function isProxyResponse(data: unknown): data is ProxySearchResponse {
  return typeof data === 'object' && data !== null && 'success' in data && 'data' in data;
}

function isStandardResponse(data: unknown): data is DramaListResponse {
  return typeof data === 'object' && data !== null && 'code' in data && 'list' in data;
}

function formatDramaList(list: DramaListItem[]) {
  return list.map((item) => ({
    id: item.vod_id,
    name: item.vod_name,
    subName: item.vod_sub || '',
    pic: item.vod_pic || '',
    remarks: item.vod_remarks || '',
    type: item.type_name || '影视',
    time: item.vod_time || '',
    playFrom: item.vod_play_from || '',
    actor: item.vod_actor || '',
    director: item.vod_director || '',
    area: item.vod_area || '',
    year: item.vod_year || '',
    score: item.vod_score || '0.0',
    total: item.vod_total || 0,
    blurb: item.vod_blurb || '',
    tags: item.vod_class ? item.vod_class.split(',').map((tag) => tag.trim()) : [],
    vod_class: item.vod_class || '',
  }));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const source: VodSource = body.source;
    
    let response: Response;
    
    // 如果有搜索代理且有关键词，使用 POST 请求
    if (source.searchProxy && body.keyword) {
      response = await fetch(source.searchProxy, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({
          api: source.api,
          keyword: body.keyword,
          page: parseInt(body.page || '1'),
        }),
        signal: AbortSignal.timeout(15000),
      });
    } else {
      // 标准 GET 请求
      const apiParams: Record<string, string> = {
        ac: 'detail',
        pg: body.page || '1',
      };

      if (body.type_id) {
        apiParams.t = body.type_id;
      }

      if (body.keyword) {
        apiParams.wd = body.keyword;
      }

      const queryString = new URLSearchParams(apiParams).toString();
      const apiUrl = `${source.api}?${queryString}`;

      response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(15000),
      });
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const responseText = await response.text();
    
    // 如果是XML或HTML响应，直接返回空结果
    if (responseText.startsWith('<?xml') || responseText.startsWith('<!DOCTYPE') || responseText.startsWith('<html')) {
      return NextResponse.json({
        code: 200,
        msg: 'success',
        data: { list: [], page: 1, pagecount: 0, limit: 24, total: 0 },
      });
    }

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(responseText);
    } catch {
      return NextResponse.json({
        code: 200,
        msg: 'success',
        data: { list: [], page: 1, pagecount: 0, limit: 24, total: 0 },
      });
    }

    let formattedList;
    let pagecount = 1;
    let total = 0;

    // 处理代理 API 响应格式
    if (source.searchProxy && body.keyword && isProxyResponse(parsedData)) {
      if (!parsedData.success) {
        return NextResponse.json({
          code: 200,
          msg: 'success',
          data: { list: [], page: 1, pagecount: 0, limit: 24, total: 0 },
        });
      }
      formattedList = formatDramaList(parsedData.data || []);
      total = parsedData.data?.length || 0;
    } else if (isStandardResponse(parsedData)) {
      // 处理标准 API 响应格式
      if (parsedData.code !== 1) {
        return NextResponse.json({
          code: 200,
          msg: 'success',
          data: { list: [], page: 1, pagecount: 0, limit: 24, total: 0 },
        });
      }
      formattedList = formatDramaList(parsedData.list || []);
      pagecount = parsedData.pagecount || 1;
      total = parsedData.total || 0;
    } else {
      return NextResponse.json({
        code: 200,
        msg: 'success',
        data: { list: [], page: 1, pagecount: 0, limit: 24, total: 0 },
      });
    }

    const result: ApiResponse<DramaListData> = {
      code: 200,
      msg: 'success',
      data: {
        list: formattedList,
        page: parseInt(body.page || '1'),
        pagecount: pagecount,
        limit: parseInt(body.limit || '24'),
        total: total,
      },
    };

    return NextResponse.json(result);
  } catch (error) {
    // 简短错误日志，避免输出冗长堆栈
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[Drama API] 请求失败: ${errMsg}`);

    const errorResult: ApiResponse<DramaListData> = {
      code: 500,
      msg: '获取影视列表失败',
      data: {
        list: [],
        page: 1,
        pagecount: 1,
        limit: 24,
        total: 0,
      },
    };

    return NextResponse.json(errorResult, { status: 500 });
  }
}
