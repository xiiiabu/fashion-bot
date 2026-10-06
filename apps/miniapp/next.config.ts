import type { NextConfig } from 'next';

/**
 * The Mini App runs inside the Telegram webview, so it is a client-rendered
 * application served as static assets: initData only exists in the browser and
 * there is no cookie we could read on a server render. Keeping it static also
 * means the whole UI can be put behind a CDN and the API stays the only
 * stateful thing to scale (spec §13.2).
 */
const config: NextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // The product imagery and brand logos are served by the API from
  // /media, so the only rewriting we need is the API proxy in development.
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_URL;
    if (!api || process.env.NODE_ENV === 'production') return [];
    return [
      { source: '/media/:path*', destination: `${api.replace(/\/$/, '')}/media/:path*` },
    ];
  },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  transpilePackages: ['@fashion/core'],
};

export default config;
