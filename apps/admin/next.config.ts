import type { NextConfig } from 'next';

/**
 * The operator surface: the admin panel and the seller cabinet in one app.
 *
 * They share an authentication model (one login endpoint, one session, a
 * principal that is either an admin or a seller user), a design system and
 * most of their table and form machinery. Splitting them into two deployments
 * would duplicate all of that to express a difference that is one field on the
 * principal.
 *
 * Client-rendered for the same reason as the Mini App: the session lives in
 * the browser, and a server render would have to either hold operator
 * credentials or render a shell it cannot fill.
 */
const config: NextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  transpilePackages: ['@fashion/core'],
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_URL;
    if (!api || process.env.NODE_ENV === 'production') return [];
    return [{ source: '/media/:path*', destination: `${api.replace(/\/$/, '')}/media/:path*` }];
  },
};

export default config;
