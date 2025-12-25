import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse, DramaDetail, Episode, VodSource } from '@/types/drama';

interface DetailItem {
  vod_id: number;
  vod_name: string;
  vod_pic?: string;
  vod_remarks?: string;
  type_name?: string;
  vod_play_url?: string;
  vod_play_from?: string;
  vod_actor?: string;
  vod_director?: string;
  vod_content?: string;
  vod_area?: string;
  vod_year?: string;
  vod_score?: string;
}

interface DetailResponse {
  code: number;
  msg?: string;
  list?: DetailItem[];
}

interface ProxySearchResponse {
  success: boolean;
  message: string;
  data: DetailItem[];
}

function isProxyResponse(data: unknown): data is ProxySearchResponse {
  return typeof data === 'object' && data !== null && 'success' in data && 'data' in data;
}

function isStandardResponse(data: unknown): data is DetailResponse {
  return typeof data === 'object' && data !== null && 'code' in data;
}

function formatDramaDetail(item: DetailItem): DramaDetail {
  const episodes = parseEpisodes(item.vod_play_url || '');
  return {
    id: item.vod_id,
    name: item.vod_name,
    pic: item.vod_pic || '',
    remarks: item.vod_remarks || '',
    type: item.type_name || '影视',
    actor: item.vod_actor || '',
    director: item.vod_director || '',
    blurb: item.vod_content || '',
    area: item.vod_area || '',
    year: item.vod_year || '',
    score: item.vod_score || '0.0',
    episodes,
  };
}

// 解析剧集列表
function parseEpisodes(playUrl: string): Episode[] {
  if (!playUrl) return [];

  try {
    // 解析剧集列表
    // 格式通常为: 播放源1$$$播放源2$$$...
    // 每个播放源内部: 第1集$url1#第2集$url2#...
    const sources = playUrl.split('$$$').filter(Boolean);
    
    // 优先使用包含m3u8的播放源
    const m3u8Source = sources.find(source => source.includes('.m3u8'));
    const targetSource = m3u8Source || sources[0];
    
    if (!targetSource) return [];
    
    const episodes: Episode[] = [];
    const episodeList = targetSource.split('#').filter(Boolean);

    for (const episode of episodeList) {
      const [name, url] = episode.split('$');
      if (name && url) {
        episodes.push({ name, url });
      }
    }

    return episodes;
  } catch (error) {
    console.warn('⚠️ 解析剧集失败:', error instanceof Error ? error.message : '未知错误');
    return [];
  }
}

// 返回错误响应的辅助函数
function errorResponse(msg: string, status: number = 500): NextResponse {
  const result: ApiResponse = { code: status, msg };
  return NextResponse.json(result, { status });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const source: VodSource = body.source;
    const vodName: string = body.vodName; // 用于代理搜索
    
    let response: Response;
    
    // 如果有搜索代理，使用代理搜索获取详情
    if (source.searchProxy && vodName) {
      response = await fetch(source.searchProxy, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({
          api: source.api,
          keyword: vodName,
          page: 1,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } else {
      // 标准 GET 请求
      const apiParams = new URLSearchParams({
        ac: 'detail',
        ids: body.ids,
      });
      const apiUrl = `${source.api}?${apiParams.toString()}`;
      
      response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(15000),
      });
    }

    if (!response.ok) {
      console.warn(`⚠️ API请求失败: HTTP ${response.status}`);
      return errorResponse('API请求失败');
    }

    const responseText = await response.text();
    
    // 检查是否是错误响应
    if (responseText.includes('域名未授权') || responseText.startsWith('<?xml') || responseText.startsWith('<!DOCTYPE')) {
      console.warn('⚠️ 源API访问被拒绝');
      return errorResponse('源API访问失败');
    }
    
    let parsedData: unknown;
    try {
      parsedData = JSON.parse(responseText);
    } catch {
      console.warn('⚠️ 响应解析失败');
      return errorResponse('响应解析失败');
    }

    let dramaDetail: DramaDetail | null = null;

    // 处理代理 API 响应格式
    if (source.searchProxy && vodName && isProxyResponse(parsedData)) {
      if (!parsedData.success || !parsedData.data || parsedData.data.length === 0) {
        console.warn(`⚠️ 代理搜索未找到: "${vodName}"`);
        return errorResponse('未找到该影视资源', 404);
      }
      // 查找匹配的结果
      const targetId = parseInt(body.ids);
      const item = parsedData.data.find(d => d.vod_id === targetId) || parsedData.data[0];
      dramaDetail = formatDramaDetail(item);
    } else if (isStandardResponse(parsedData)) {
      // 处理标准 API 响应格式
      if (parsedData.code !== 1 || !parsedData.list || parsedData.list.length === 0) {
        console.warn('⚠️ 获取影视详情失败');
        return errorResponse('获取影视详情失败');
      }
      dramaDetail = formatDramaDetail(parsedData.list[0]);
    } else {
      console.warn('⚠️ 无法解析响应格式');
      return errorResponse('无法解析响应格式');
    }

    const result: ApiResponse<DramaDetail> = {
      code: 200,
      msg: 'success',
      data: dramaDetail,
    };

    return NextResponse.json(result);
  } catch (error) {
    // 只对意外错误输出完整日志
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('⚠️ 请求超时');
      return errorResponse('请求超时，请稍后重试');
    }
    
    console.error('❌ 获取详情异常:', error instanceof Error ? error.message : '未知错误');
    return errorResponse('获取影视详情失败');
  }
}

