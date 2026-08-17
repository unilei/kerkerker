import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRequest } from '@/lib/admin-route';
import {
  getPanResourcesByDoubanId,
  getAllPanResources,
  createPanResourceInDB,
  updatePanResourceInDB,
  deletePanResourceFromDB,
} from '@/lib/pan-resources-db';
import {
  PAN_BRANDS,
  type PanBrand,
  type PanResourceInput,
} from '@/types/pan-resource';

// 校验分享链接格式（仅允许 http/https，链接仅作存储与跳转，不发起服务端请求）
function isValidPanUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// GET - 获取网盘资源
// 公开：?douban_id=xxx 返回该片启用的资源（前台详情页使用）
// 管理：?all=true（需登录）返回全部资源，支持 keyword 模糊搜索 / douban_id 过滤 / limit
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const doubanId = searchParams.get('douban_id') || '';

    if (searchParams.get('all') === 'true') {
      const unauthorizedResponse = requireAdminRequest(request);
      if (unauthorizedResponse) {
        return unauthorizedResponse;
      }

      const keyword = searchParams.get('keyword') || '';
      const limitParam = parseInt(searchParams.get('limit') || '50', 10);
      const limit = Number.isFinite(limitParam)
        ? Math.min(Math.max(limitParam, 1), 200)
        : 50;

      const resources = await getAllPanResources({
        doubanId: doubanId || undefined,
        keyword: keyword || undefined,
        limit,
      });

      return NextResponse.json({
        code: 200,
        message: '获取成功',
        data: { resources },
      });
    }

    if (!doubanId) {
      return NextResponse.json(
        { code: 400, message: '缺少 douban_id 参数', data: null },
        { status: 400 }
      );
    }

    const resources = await getPanResourcesByDoubanId(doubanId);
    return NextResponse.json({
      code: 200,
      message: '获取成功',
      data: { resources },
    });
  } catch (error) {
    console.error('获取网盘资源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '获取网盘资源失败',
        data: null,
      },
      { status: 500 }
    );
  }
}

// POST - 新增网盘资源（管理端）
export async function POST(request: NextRequest) {
  try {
    const unauthorizedResponse = requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = (await request.json()) as PanResourceInput;
    const { douban_id, brand, title, url } = body;

    if (!douban_id || !brand || !title || !url) {
      return NextResponse.json(
        {
          code: 400,
          message: '缺少必要字段（douban_id、brand、title、url）',
          data: null,
        },
        { status: 400 }
      );
    }

    if (!PAN_BRANDS.includes(brand as PanBrand)) {
      return NextResponse.json(
        { code: 400, message: `不支持的品牌：${brand}`, data: null },
        { status: 400 }
      );
    }

    if (!isValidPanUrl(url)) {
      return NextResponse.json(
        { code: 400, message: '分享链接格式错误（需以 http/https 开头）', data: null },
        { status: 400 }
      );
    }

    const { resource } = await createPanResourceInDB({
      ...body,
      douban_id,
      brand: brand as PanBrand,
      title,
      url,
    });

    return NextResponse.json({
      code: 200,
      message: '添加成功',
      data: { resource },
    });
  } catch (error) {
    console.error('添加网盘资源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '添加网盘资源失败',
        data: null,
      },
      { status: 500 }
    );
  }
}

// PUT - 更新网盘资源（管理端）
export async function PUT(request: NextRequest) {
  try {
    const unauthorizedResponse = requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = (await request.json()) as PanResourceInput & { id?: string };
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json(
        { code: 400, message: '缺少资源 id', data: null },
        { status: 400 }
      );
    }

    if (updates.brand && !PAN_BRANDS.includes(updates.brand)) {
      return NextResponse.json(
        { code: 400, message: `不支持的品牌：${updates.brand}`, data: null },
        { status: 400 }
      );
    }

    if (updates.url && !isValidPanUrl(updates.url)) {
      return NextResponse.json(
        { code: 400, message: '分享链接格式错误（需以 http/https 开头）', data: null },
        { status: 400 }
      );
    }

    const resource = await updatePanResourceInDB(id, updates);
    if (!resource) {
      return NextResponse.json(
        { code: 404, message: '资源不存在', data: null },
        { status: 404 }
      );
    }

    return NextResponse.json({
      code: 200,
      message: '更新成功',
      data: { resource },
    });
  } catch (error) {
    console.error('更新网盘资源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '更新网盘资源失败',
        data: null,
      },
      { status: 500 }
    );
  }
}

// DELETE - 删除网盘资源（管理端）
export async function DELETE(request: NextRequest) {
  try {
    const unauthorizedResponse = requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { code: 400, message: '缺少资源 id', data: null },
        { status: 400 }
      );
    }

    const success = await deletePanResourceFromDB(id);
    if (!success) {
      return NextResponse.json(
        { code: 404, message: '资源不存在', data: null },
        { status: 404 }
      );
    }

    return NextResponse.json({
      code: 200,
      message: '删除成功',
      data: null,
    });
  } catch (error) {
    console.error('删除网盘资源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '删除网盘资源失败',
        data: null,
      },
      { status: 500 }
    );
  }
}
