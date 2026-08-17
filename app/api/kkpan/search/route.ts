import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRequest } from '@/lib/admin-route';
import {
  searchKkpanResources,
  cleanKkpanTitle,
  formatBytes,
} from '@/lib/kkpan';
import { PAN_BRANDS, type PanBrand } from '@/types/pan-resource';

const FORMAT_RE = /\b(MP4|MKV|AVI|MOV|RMVB|WMV|FLV|WEBM|ISO|TS)\b/i;

// GET - 从 kkpans.com 拉取转存成功的网盘资源（管理端录入辅助）
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

  try {
    const items = await searchKkpanResources(keyword);

    const normalized = items
      .filter(
        (item): item is typeof item & { targetPlatform: PanBrand } =>
          (PAN_BRANDS as string[]).includes(item.targetPlatform)
      )
      .map((item) => ({
        brand: item.targetPlatform,
        title: cleanKkpanTitle(item.fileName),
        url: item.shareLink,
        code: item.shareCode?.toUpperCase() || undefined,
        size: formatBytes(item.fileSize),
        format: item.fileName.match(FORMAT_RE)?.[1]?.toUpperCase(),
        // 透传 kkpan_id 与 source，便于前端入库时回传，参与失效联动与 ID 对账
        kkpan_id: item.id,
        source: 'kkpan' as const,
        updatedAt: item.updatedAt?.slice(0, 10),
      }));

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
