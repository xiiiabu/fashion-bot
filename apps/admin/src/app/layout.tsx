import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppProvider } from '@/lib/app-context';
import { AppFrame } from '@/components/app-frame';

export const metadata: Metadata = {
  title: 'Atlas — панель управления',
  description: 'Управление каталогом, заказами, финансами и продавцами.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f6f1' },
    { media: '(prefers-color-scheme: dark)', color: '#141211' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500&family=Inter:wght@400;500;600&display=swap"
        />
        {/* The theme has to be on <html> before first paint, or an operator on
            a dark setup gets a white flash on every navigation. */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('atlas.ops.theme');if(s!=='dark'&&s!=='light'){s=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=s;}catch(e){}})();`,
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
