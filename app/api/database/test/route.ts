import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { MongoClient } from 'mongodb';

import { requireAdminRequest } from '@/lib/admin-route';

/**
 * 数据库连接测试 API
 * POST /api/database/test
 * 
 * 创建新连接进行测试，不影响现有连接池
 */
export async function POST(request?: NextRequest) {
  const startTime = Date.now();
  const unauthorizedResponse = requireAdminRequest(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const uri = process.env.MONGODB_URI;
  
  if (!uri) {
    return NextResponse.json({
      code: 400,
      data: {
        success: false,
        latency: 0,
        error: 'MONGODB_URI 环境变量未配置',
      },
    });
  }
  
  let testClient: MongoClient | null = null;
  
  try {
    // 创建临时连接进行测试
    testClient = new MongoClient(uri, {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    });
    
    await testClient.connect();
    
    // 执行 ping 测试
    const db = testClient.db();
    await db.admin().ping();
    
    const latency = Date.now() - startTime;
    
    return NextResponse.json({
      code: 200,
      data: {
        success: true,
        latency,
        message: '连接测试成功',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    
    return NextResponse.json({
      code: 500,
      data: {
        success: false,
        latency,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
    });
  } finally {
    // 确保关闭测试连接
    if (testClient) {
      try {
        await testClient.close();
      } catch {
        // 忽略关闭错误
      }
    }
  }
}
