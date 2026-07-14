import { NextResponse } from 'next/server';

/**
 * SA-7: lightweight container healthcheck endpoint.
 *
 * Deliberately does NOT call core-api, the database, or any other backend
 * dependency — it only proves the Next.js standalone server process itself
 * is up and can handle a request. The previous Docker healthcheck probed the
 * SSR `/dashboard` route, which server-renders and fetches data from
 * core-api; a slow or degraded core-api would fail web-next's OWN
 * healthcheck even though the Next.js process was perfectly healthy,
 * conflating two independent failure domains.
 *
 * Matched by `next.config.ts` rewrites() only in the `afterFiles` phase
 * (the default for an array return), so this filesystem route always wins
 * over the `/api/:path*` -> core-api proxy rewrite — this response never
 * reaches core-api.
 */
export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
