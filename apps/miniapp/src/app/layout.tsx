import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';
import './globals.css';
import { AppProvider } from '@/lib/app-context';
import { AppFrame } from '@/components/app-frame';

export const metadata: Metadata = {
  title: 'Atlas — мода Ташкента',
  description:
    'Мультибрендовый маркетплейс одежды: единый каталог, AI-стилист и один заказ на все бренды.',
  applicationName: 'Atlas',
  other: {
    // Telegram reads this to decide whether it may cache the webview shell.
    'format-detection': 'telephone=no',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The Telegram webview mishandles pinch-zoom over a fixed layout, and the
  // type scale here is already readable without it.
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf7f1' },
    { media: '(prefers-color-scheme: dark)', color: '#121010' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        {/*
          The Telegram SDK is the one external script the Mini App needs, and it
          loads without blocking hydration. `beforeInteractive` was tried first
          and is wrong here: when telegram.org is slow or unreachable the whole
          app stalls on a splash screen with no way forward. Loading it async
          and waiting for `window.Telegram` with a short deadline (see
          waitForTelegram in lib/telegram.ts) means a blocked CDN costs us the
          native chrome, not the shop.
        */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          The display and UI faces. The CSS font stack in globals.css names
          real local fallbacks (New York / Georgia, and the system sans), so a
          blocked Google Fonts still renders a correct, readable page.
        */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500&family=Inter:wght@400;500;600&display=swap"
        />
        {/*
          The theme class has to be on <html> before first paint or the shopper
          sees a white flash on a dark client. This runs synchronously, reads
          Telegram's scheme when it is there and the OS preference otherwise.
        */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var w=window.Telegram&&window.Telegram.WebApp;var s=w&&w.colorScheme?w.colorScheme:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=s;}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <AppProvider>
          <AppFrame>{children}</AppFrame>
        </AppProvider>
      </body>
    </html>
  );
}
