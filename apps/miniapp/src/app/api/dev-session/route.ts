/**
 * Development sign-in relay. Dev-only, and it exists so the shared secret the
 * API requires stays on the server.
 *
 * The first version of this put DEV_AUTH_SECRET in a NEXT_PUBLIC_ variable,
 * which shipped it inside the JavaScript bundle — anyone who could load the
 * page could read it. A secret in a public bundle is not a secret, even in
 * development, so the browser now asks this route and the route holds the
 * credential.
 *
 * The gate is two explicit environment variables, not NODE_ENV: `next start`
 * sets NODE_ENV=production for every deployment including a demo one, so
 * branching on it would both disable the route where it is wanted and give a
 * false sense of safety where it is not. Both variables absent — the default
 * everywhere — means this route does not exist, and the only way into the Mini
 * App is a signed Telegram initData payload the API verifies (TG-001). The API
 * refuses dev sign-in in production independently, so there are two locks.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.DEV_AUTH_SECRET;
  if (!secret || process.env.ALLOW_DEV_SESSION !== '1') {
    return NextResponse.json({ code: 'NOT_FOUND', message: 'Not found' }, { status: 404 });
  }

  const api = (process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
    /\/$/,
    '',
  );

  let locale: string | undefined;
  let telegramId: number | undefined;
  try {
    const body = (await request.json()) as { locale?: string; telegramId?: number };
    locale = body.locale;
    telegramId = body.telegramId;
  } catch {
    /* an empty body is fine; the API defaults everything */
  }

  const upstream = await fetch(`${api}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, locale, telegramId }),
    cache: 'no-store',
  });

  const payload = await upstream.text();
  return new NextResponse(payload, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
