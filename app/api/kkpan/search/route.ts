import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRequest } from '@/lib/admin-route';
import { formatBytes } from '@/lib/kkpan';
import {
  createProfileInvocation,
  getRequestPluginProfileId,
  invokeProfilePlugin,
  type CloudDriveResourceCandidate,
  type PluginPage,
} from '@/lib/plugins';
import { KKPAN_PLUGIN_ID } from '@/lib/plugins/adapters/kkpan-cloud-drive';
import { PAN_BRANDS, type PanBrand } from '@/types/pan-resource';

// GET - 兼容的 KKPAN 管理搜索入口。真实执行经 profile/runtime 选择插件，
// 返回格式暂时保持不变，避免插件迁移破坏现有后台。
// ?keyword=片名，仅返回品牌可映射且带有效分享链接的条目
export async function GET(request: NextRequest) {
  const unauthorizedResponse = requireAdminRequest(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const keyword = request.nextUrl.searchParams.get('keyword')?.trim();
  if (!keyword) {
    return NextResponse.json(
      { code: 400, message: '缺少 keyword 参数', data: null },
      { status: 400 }
    );
  }
  if (keyword.length > 200) {
    return NextResponse.json(
      { code: 400, message: 'keyword 最长 200 个字符', data: null },
      { status: 400 }
    );
  }

  try {
    const profileId = getRequestPluginProfileId(request);
    const { context } = createProfileInvocation({
      profileId,
      capability: 'resource.cloud-drive',
      signal: request.signal,
      timeoutMs: 15_000,
    });
    const page = await invokeProfilePlugin<PluginPage<CloudDriveResourceCandidate>>({
      profileId,
      capability: 'resource.cloud-drive',
      operation: 'search',
      context,
      request: { title: keyword, limit: 40 },
    });

    const normalized = page.items.flatMap((item) => {
      const platformId = item.platform.brand || item.platform.platformId;
      if (!(PAN_BRANDS as readonly string[]).includes(platformId)) return [];
      const numericId = Number(item.externalId);
      if (
        item.providerId !== KKPAN_PLUGIN_ID ||
        !Number.isSafeInteger(numericId) ||
        numericId <= 0
      ) {
        return [];
      }
      return [{
        brand: platformId as PanBrand,
        title: item.title,
        url: item.url,
        code: item.accessCode?.toUpperCase() || undefined,
        size: formatBytes(item.sizeBytes),
        format: item.format,
        kkpan_id: numericId,
        source: 'kkpan' as const,
        provider_id: item.providerId,
        provider_resource_id: item.externalId,
        content_id: item.contentId,
        updatedAt: item.sourceUpdatedAt?.slice(0, 10),
      }];
    });

    return NextResponse.json({
      code: 200,
      message: '获取成功',
      data: { items: normalized },
    });
  } catch (error) {
    console.error('kkpans 拉取失败:', error);
    return NextResponse.json(
      {
        code: 502,
        message:
          error instanceof Error ? error.message : 'kkpans 拉取失败',
        data: null,
      },
      { status: 502 }
    );
  }
}
