import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRequest } from '@/lib/admin-route';
import {
  getPanResourcesByDoubanId,
  getPanResourcesByContentId,
  getPanResourceById,
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
import {
  findContentIdentityByExternalRef,
  isValidContentId,
  resolveContentIdentity,
} from '@/lib/content-identity-db';
import { DOUBAN_CONTENT_PLUGIN_ID } from '@/lib/plugins/adapters/douban-content';
import { KKPAN_PLUGIN_ID } from '@/lib/plugins/adapters/kkpan-cloud-drive';
import {
  filterPublicPanResources,
  recordPanResourceMutation,
} from '@/lib/pan/resource-audit';

// 校验分享链接格式（仅允许 http/https，链接仅作存储与跳转，不发起服务端请求）
function isValidPanUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidKkpanId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function getKkpanIdentityIssue(input: PanResourceInput): string | null {
  const hasKkpanId = isValidKkpanId(input.kkpan_id);
  const hasProviderField =
    input.provider_id !== undefined || input.provider_resource_id !== undefined;
  if (!hasKkpanId) {
    return hasProviderField
      ? '来源插件身份只能通过受支持的插件导入'
      : null;
  }
  if (input.source !== undefined && input.source !== 'kkpan') {
    return '带 kkpan_id 的资源必须使用 kkpan 来源';
  }
  if (input.provider_id !== undefined && input.provider_id !== KKPAN_PLUGIN_ID) {
    return 'provider_id 与 kkpan 来源不一致';
  }
  if (
    input.provider_resource_id !== undefined &&
    input.provider_resource_id !== String(input.kkpan_id)
  ) {
    return 'provider_resource_id 与 kkpan_id 不一致';
  }
  return null;
}

async function withHostIdentity(
  input: PanResourceInput & { douban_id: string },
  options: { assignManualSource?: boolean } = {}
) {
  const identity = await resolveContentIdentity([
    { providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: input.douban_id },
  ]);
  if (input.content_id && input.content_id !== identity.contentId) {
    throw new RangeError('content_id 与 douban_id 的宿主身份不一致');
  }
  const hasKkpanId = isValidKkpanId(input.kkpan_id);
  return {
    ...input,
    content_id: identity.contentId,
    ...(options.assignManualSource && !hasKkpanId
      ? { source: input.source || ('manual' as const) }
      : {}),
    ...(hasKkpanId
      ? {
          provider_id: KKPAN_PLUGIN_ID,
          provider_resource_id: String(input.kkpan_id),
        }
      : {}),
  };
}

// GET - 获取网盘资源
// 公开：?douban_id=xxx 返回该片启用的资源（前台详情页使用）
// 管理：?all=true（需登录）返回全部资源，支持 keyword 模糊搜索 / douban_id 过滤 / limit
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const doubanId = searchParams.get('douban_id') || '';
    const contentId = searchParams.get('content_id') || '';

    if (contentId && !isValidContentId(contentId)) {
      return NextResponse.json(
        { code: 400, message: 'content_id 格式无效', data: null },
        { status: 400 }
      );
    }

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

      let resources = await getAllPanResources({
        doubanId: doubanId || undefined,
        contentId: contentId || undefined,
        keyword: keyword || undefined,
        limit,
      });
      // During the identity migration older rows may still have only the
      // legacy Douban key. Prefer the host identity, then fall back only when
      // it returned no rows for the same explicit movie reference.
      if (resources.length === 0 && contentId && doubanId) {
        resources = await getAllPanResources({
          doubanId,
          keyword: keyword || undefined,
          limit,
        });
      }

      return NextResponse.json({
        code: 200,
        message: '获取成功',
        data: { resources },
      });
    }

    if (!doubanId && !contentId) {
      return NextResponse.json(
        { code: 400, message: '缺少 douban_id 或 content_id 参数', data: null },
        { status: 400 }
      );
    }

    let resources = contentId
      ? await getPanResourcesByContentId(contentId)
      : await getPanResourcesByDoubanId(doubanId);
    if (resources.length === 0 && contentId && doubanId) {
      resources = await getPanResourcesByDoubanId(doubanId);
    }
    let policyContentId =
      contentId || resources.find((resource) => resource.content_id)?.content_id;
    // Legacy rows may have only douban_id. Resolve the existing identity for
    // policy filtering without creating a new identity during a public read.
    if (!policyContentId && /^\d{1,20}$/.test(doubanId)) {
      try {
        policyContentId = (
          await findContentIdentityByExternalRef({
            providerId: DOUBAN_CONTENT_PLUGIN_ID,
            externalId: doubanId,
          })
        )?.contentId;
      } catch (error) {
        if (process.env.KERKERKER_COMPLIANCE_MODE === 'enforce') throw error;
        console.warn('读取历史资源身份失败，审计模式保留兼容读取:', error);
      }
    }
    resources = await filterPublicPanResources(resources, undefined, {
      contentId: policyContentId,
    });
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

    let body: PanResourceInput;
    try {
      const parsed = (await request.json()) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('body must be an object');
      }
      body = parsed as PanResourceInput;
    } catch {
      return NextResponse.json(
        { code: 400, message: '请求体必须是合法 JSON 对象', data: null },
        { status: 400 }
      );
    }
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
    if (!/^\d{1,20}$/.test(douban_id)) {
      return NextResponse.json(
        { code: 400, message: 'douban_id 格式无效', data: null },
        { status: 400 }
      );
    }

    if (!PAN_BRANDS.includes(brand as PanBrand)) {
      return NextResponse.json(
        { code: 400, message: `不支持的品牌：${brand}`, data: null },
        { status: 400 }
      );
    }

    if (body.source !== undefined && body.source !== 'manual' && body.source !== 'kkpan') {
      return NextResponse.json(
        { code: 400, message: 'source 仅支持 manual / kkpan', data: null },
        { status: 400 }
      );
    }

    if (!isValidPanUrl(url)) {
      return NextResponse.json(
        { code: 400, message: '分享链接格式错误（需以 http/https 开头）', data: null },
        { status: 400 }
      );
    }

    if (
      (body.kkpan_id !== undefined && !isValidKkpanId(body.kkpan_id)) ||
      (body.source === 'kkpan' && !isValidKkpanId(body.kkpan_id))
    ) {
      return NextResponse.json(
        { code: 400, message: 'kkpan_id 必须是正安全整数', data: null },
        { status: 400 }
      );
    }

    const identityIssue = getKkpanIdentityIssue(body);
    if (identityIssue) {
      return NextResponse.json(
        { code: 400, message: identityIssue, data: null },
        { status: 400 }
      );
    }

    const authoritativeBody = await withHostIdentity(
      { ...body, douban_id },
      { assignManualSource: true }
    );

    const { resource } = await createPanResourceInDB({
      ...authoritativeBody,
      douban_id,
      brand: brand as PanBrand,
      title,
      url,
    });
    await recordPanResourceMutation(request, 'create', resource);

    return NextResponse.json({
      code: 200,
      message: '添加成功',
      data: { resource },
    });
  } catch (error) {
    console.error('添加网盘资源失败:', error);
    const status = error instanceof RangeError ? 400 : 500;
    return NextResponse.json(
      {
        code: status,
        message: error instanceof Error ? error.message : '添加网盘资源失败',
        data: null,
      },
      { status }
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

    let body: PanResourceInput & { id?: string };
    try {
      const parsed = (await request.json()) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('body must be an object');
      }
      body = parsed as PanResourceInput & { id?: string };
    } catch {
      return NextResponse.json(
        { code: 400, message: '请求体必须是合法 JSON 对象', data: null },
        { status: 400 }
      );
    }
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json(
        { code: 400, message: '缺少资源 id', data: null },
        { status: 400 }
      );
    }

    if (
      updates.brand !== undefined &&
      (typeof updates.brand !== 'string' || !PAN_BRANDS.includes(updates.brand as PanBrand))
    ) {
      return NextResponse.json(
        { code: 400, message: `不支持的品牌：${updates.brand}`, data: null },
        { status: 400 }
      );
    }

    if (
      updates.source !== undefined &&
      updates.source !== 'manual' &&
      updates.source !== 'kkpan'
    ) {
      return NextResponse.json(
        { code: 400, message: 'source 仅支持 manual / kkpan', data: null },
        { status: 400 }
      );
    }

    if (
      updates.url !== undefined &&
      (typeof updates.url !== 'string' || !isValidPanUrl(updates.url))
    ) {
      return NextResponse.json(
        { code: 400, message: '分享链接格式错误（需以 http/https 开头）', data: null },
        { status: 400 }
      );
    }


    if (updates.kkpan_id !== undefined && !isValidKkpanId(updates.kkpan_id)) {
      return NextResponse.json(
        { code: 400, message: 'kkpan_id 必须是正安全整数', data: null },
        { status: 400 }
      );
    }

    if (
      updates.provider_id !== undefined &&
      typeof updates.provider_id !== 'string'
    ) {
      return NextResponse.json(
        { code: 400, message: 'provider_id 格式无效', data: null },
        { status: 400 }
      );
    }
    if (
      updates.provider_resource_id !== undefined &&
      typeof updates.provider_resource_id !== 'string'
    ) {
      return NextResponse.json(
        { code: 400, message: 'provider_resource_id 格式无效', data: null },
        { status: 400 }
      );
    }

    if (
      updates.douban_id !== undefined &&
      (typeof updates.douban_id !== 'string' || !/^\d{1,20}$/.test(updates.douban_id))
    ) {
      return NextResponse.json(
        { code: 400, message: 'douban_id 格式无效', data: null },
        { status: 400 }
      );
    }
    const existingResource = await getPanResourceById(id);
    if (!existingResource) {
      return NextResponse.json(
        { code: 404, message: '资源不存在', data: null },
        { status: 404 }
      );
    }
    if (
      existingResource.kkpan_id !== undefined &&
      updates.douban_id !== undefined &&
      updates.douban_id !== existingResource.douban_id
    ) {
      return NextResponse.json(
        { code: 400, message: 'KKPAN 资源不能改关联影片', data: null },
        { status: 400 }
      );
    }

    const identityInput = {
      ...existingResource,
      ...updates,
      douban_id: updates.douban_id ?? existingResource.douban_id,
    };

    // Provider/resource IDs are immutable source identities. Ordinary editing may
    // change presentation fields, but re-binding an upstream ID needs a separate
    // audited migration flow so later syncs cannot resurrect the old resource.
    if (
      existingResource.kkpan_id !== undefined &&
      identityInput.kkpan_id !== existingResource.kkpan_id
    ) {
      return NextResponse.json(
        { code: 400, message: '来源资源 ID 不可修改，请通过重新导入或迁移流程处理', data: null },
        { status: 400 }
      );
    }
    if (
      (existingResource.provider_id !== undefined ||
        existingResource.provider_resource_id !== undefined) &&
      (identityInput.provider_id !== existingResource.provider_id ||
        identityInput.provider_resource_id !== existingResource.provider_resource_id)
    ) {
      return NextResponse.json(
        { code: 400, message: '来源插件引用不可修改，请通过重新导入或迁移流程处理', data: null },
        { status: 400 }
      );
    }
    const identityIssue = getKkpanIdentityIssue(identityInput);
    if (identityIssue) {
      return NextResponse.json(
        { code: 400, message: identityIssue, data: null },
        { status: 400 }
      );
    }
    const authoritative = await withHostIdentity(identityInput, {
      assignManualSource: true,
    });
    const authoritativeUpdates: PanResourceInput = {
      ...updates,
      content_id: authoritative.content_id,
      ...(authoritative.source ? { source: authoritative.source } : {}),
      ...(authoritative.provider_id
        ? {
            provider_id: authoritative.provider_id,
            provider_resource_id: authoritative.provider_resource_id,
          }
        : {}),
      ...(authoritative.kkpan_id
        ? { kkpan_id: authoritative.kkpan_id }
        : {}),
    };

    const resource = await updatePanResourceInDB(id, authoritativeUpdates);
    if (!resource) return NextResponse.json(
      { code: 404, message: '资源不存在', data: null },
      { status: 404 }
    );
    await recordPanResourceMutation(request, 'update', resource, {
      before: existingResource,
    });

    return NextResponse.json({
      code: 200,
      message: '更新成功',
      data: { resource },
    });
  } catch (error) {
    console.error('更新网盘资源失败:', error);
    const status = error instanceof RangeError ? 400 : 500;
    return NextResponse.json(
      {
        code: status,
        message: error instanceof Error ? error.message : '更新网盘资源失败',
        data: null,
      },
      { status }
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

    const existingResource = await getPanResourceById(id);
    if (!existingResource) {
      return NextResponse.json(
        { code: 404, message: '资源不存在', data: null },
        { status: 404 }
      );
    }

    const success = await deletePanResourceFromDB(id);
    if (!success) {
      return NextResponse.json(
        { code: 404, message: '资源不存在', data: null },
        { status: 404 }
      );
    }
    await recordPanResourceMutation(request, 'delete', existingResource, {
      before: existingResource,
    });

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
