import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse, DramaListData } from '@/types/drama';

interface DramaListResponse {
  code: number;
  msg: string;
  page: number;
  pagecount: number;
  limit: number;
  total: number;
  list: Array<{
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
  }>;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // 构建API请求参数
    const apiParams: Record<string, string> = {
      ac: 'detail',
      pg: body.page || '1',
    };

    if (body.type_id) {
      apiParams.t = body.type_id;
    }

    // 如果有关键词，添加搜索参数
    if (body.keyword) {
      apiParams.wd = body.keyword;
    }

    // 构建查询字符串
    const queryString = new URLSearchParams(apiParams).toString();
    const apiUrl = `${body.source.api}?${queryString}`;

    // 调用影视API
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // 读取响应文本
    const responseText = await response.text();
    
    // 如果是XML或HTML响应，直接返回空结果
    if (responseText.startsWith('<?xml') || responseText.startsWith('<!DOCTYPE') || responseText.startsWith('<html')) {
      return NextResponse.json({
        code: 200,
        msg: 'success',
        data: { list: [], page: 1, pagecount: 0, limit: 24, total: 0 },
      });
    }

    // 解析JSON
    let data: DramaListResponse;
    try {
      data = JSON.parse(responseText);
    } catch {
      // JSON解析失败，静默返回空结果
      return NextResponse.json({
        code: 200,
        msg: 'success',
        data: { list: [], page: 1, pagecount: 0, limit: 24, total: 0 },
      });
    }

    // 检查API响应
    if (data.code !== 1) {
      return NextResponse.json({
        code: 200,
        msg: 'success',
        data: { list: [], page: 1, pagecount: 0, limit: 24, total: 0 },
      });
    }

    // 格式化数据
    const formattedList = (data.list || []).map((item) => ({
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

    const result: ApiResponse<DramaListData> = {
      code: 200,
      msg: 'success',
      data: {
        list: formattedList,
        page: parseInt(body.page || '1'),
        pagecount: data.pagecount || 1,
        limit: parseInt(body.limit || '24'),
        total: data.total || 0,
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
