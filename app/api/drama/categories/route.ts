import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from '@/lib/url-security';
import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse, Category } from '@/types/drama';

interface CategoryResponse {
  code: number;
  msg?: string;
  class?: Array<{
    type_id: number | string;
    type_name: string;
    type_pid?: number | string;
  }>;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // SSRF 防御：source.api 来自请求体
    const safeApiBase = body.source?.api
      ? (await assertSafeOutboundUrl(body.source.api)).toString()
      : '';

    // 构建API请求参数
    const apiParams = new URLSearchParams({
      ac: 'list',
    });

    const apiUrl = `${safeApiBase}?${apiParams.toString()}`;

    // 调用影视API获取分类
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error('API请求失败');
    }

    const data: CategoryResponse = await response.json();

    if (data.code !== 1 || !data.class) {
      throw new Error('获取分类失败');
    }

    // 格式化分类数据
    const categories: Category[] = data.class.map((item) => ({
      id: item.type_id,
      name: item.type_name,
      icon: 'fas fa-film',
      count: 0,
    }));

    const result: ApiResponse<Category[]> = {
      code: 200,
      msg: 'success',
      data: categories,
    };

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      return NextResponse.json(
        { code: error.status, msg: error.message, data: [] },
        { status: error.status }
      );
    }

    console.error('Categories API error:', error);

    const errorResult: ApiResponse<Category[]> = {
      code: 500,
      msg: '获取分类失败',
      data: [],
    };

    return NextResponse.json(errorResult, { status: 500 });
  }
}
