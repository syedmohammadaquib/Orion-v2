import { NextRequest, NextResponse } from 'next/server';

/**
 * In-memory rate limiter for expensive AI endpoints, per IP.
 *
 * For production at scale, replace the Map with Redis (e.g. @upstash/ratelimit).
 * The Map approach works fine for a single-instance deployment.
 */

const WINDOW_MS = 60_000; // 1 minute
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const store = new Map<string, RateLimitEntry>();

function getClientIP(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'anonymous'
  );
}

function checkRateLimit(
  key: string,
  limit: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    store.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit - 1, resetAt: now + WINDOW_MS };
  }

  if (entry.count >= limit) {
    const resetAt = entry.windowStart + WINDOW_MS;
    return { allowed: false, remaining: 0, resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.windowStart + WINDOW_MS };
}

// Clean up stale entries periodically (prevent memory leak)
if (typeof globalThis !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of store.entries()) {
      if (now - entry.windowStart > WINDOW_MS * 2) {
        store.delete(ip);
      }
    }
  }, WINDOW_MS);
}

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isExecute = pathname === '/api/orion/execute';
  const isEvaluation = pathname === '/api/orion/evaluate' && request.method === 'POST';
  if (isExecute || isEvaluation) {
    const ip = getClientIP(request);
    const limit = isEvaluation ? 3 : 10;
    const { allowed, remaining, resetAt } = checkRateLimit(`${pathname}:${ip}`, limit);

    if (!allowed) {
      return new NextResponse(
        JSON.stringify({
          error: 'Rate limit exceeded. Please wait before submitting another AI request.',
          retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(Math.ceil((resetAt - Date.now()) / 1000)),
            'X-RateLimit-Limit': String(limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
          },
        },
      );
    }

    const response = NextResponse.next();
    response.headers.set('X-RateLimit-Limit', String(limit));
    response.headers.set('X-RateLimit-Remaining', String(remaining));
    response.headers.set('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/orion/:path*'],
};
