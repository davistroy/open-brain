import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Public-boundary header hardening (ARCH-REVIEW R2 / ADR-0001).
 *
 * web-next is the public ingress for Open Brain. Every request that proxies
 * through to core-api MUST have its `X-Open-Brain-Caller` header overwritten
 * here so a client-supplied value cannot bypass core-api's rate limiter
 * (`BYPASS_CALLERS` set in `packages/core-api/src/middleware/rate-limit.ts`).
 *
 * Internal Docker-network callers (slack-bot, workers, voice-capture, etc.)
 * still set their own `X-Open-Brain-Caller` because they do not transit this
 * public proxy — they reach core-api directly inside the `open-brain` network.
 *
 * Next.js 16 renamed `middleware` to `proxy`; canonical export is `proxy()`.
 * See: docs/01-app/03-api-reference/03-file-conventions/proxy.mdx
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('X-Open-Brain-Caller', 'web-next-public');

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: '/api/:path*',
};
