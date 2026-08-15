import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { validateRequestSession } from './auth';

export function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 401,
      message: '未授权',
      data: null,
    },
    { status: 401 }
  );
}

export function requireAdminRequest(
  request: Pick<NextRequest, 'cookies'> | undefined
) {
  if (validateRequestSession(request)) {
    return null;
  }

  return createUnauthorizedResponse();
}
