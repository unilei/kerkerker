import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdminRequest } from '@/lib/admin-route';
import { getDatabase, getMongoClient } from '@/lib/db';

/**
 * 数据库状态 API
 * GET /api/database/status
 * 
 * 返回数据库连接状态、延迟、基本信息
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();

  const unauthorizedResponse = requireAdminRequest(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }
  
  try {
    const db = await getDatabase();
    const client = getMongoClient();
    
    // 执行 ping 命令测试连接
    await db.admin().ping();
    
    const latency = Date.now() - startTime;
    
    // 获取数据库基本信息
    const collections = await db.listCollections().toArray();
    const dbName = db.databaseName;
    
    // 获取服务器信息
    let serverInfo = null;
    try {
      const adminDb = client?.db().admin();
      if (adminDb) {
        const buildInfo = await adminDb.command({ buildInfo: 1 });
        serverInfo = {
          version: buildInfo.version,
          gitVersion: buildInfo.gitVersion?.substring(0, 8),
        };
      }
    } catch {
      // 权限不足时忽略
    }
    
    return NextResponse.json({
      code: 200,
      data: {
        connected: true,
        latency,
        database: dbName,
        collections: collections.map(c => c.name),
        collectionCount: collections.length,
        serverInfo,
        uri: maskUri(process.env.MONGODB_URI || ''),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    
    return NextResponse.json({
      code: 500,
      data: {
        connected: false,
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
        uri: maskUri(process.env.MONGODB_URI || ''),
        timestamp: new Date().toISOString(),
      },
    });
  }
}

/**
 * 隐藏 URI 中的敏感信息
 */
function maskUri(uri: string): string {
  if (!uri) return '(未配置)';
  
  try {
    // 匹配 mongodb://user:password@host 或 mongodb+srv://user:password@host
    const masked = uri.replace(
      /^(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@/,
      '$1$2:****@'
    );
    return masked;
  } catch {
    return '(格式错误)';
  }
}
