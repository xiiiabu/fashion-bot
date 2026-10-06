'use client';

import { useEffect } from 'react';

/**
 * The last-resort boundary. A webview that renders nothing looks like the Mini
 * App itself is broken, so even an unexpected throw gets a screen with a way
 * out. The error is logged to the console rather than shown: it may carry
 * internals, and the shopper cannot act on a stack trace.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error('[miniapp]', error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-5 px-8 text-center">
      <p className="t-section">Что-то пошло не так</p>
      <p className="max-w-[30ch] text-[14px] leading-relaxed text-[var(--fg-muted)]">
        Попробуйте ещё раз. Если не поможет — закройте и откройте приложение заново.
      </p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex h-12 items-center rounded-[var(--radius-md)] border border-[var(--line)] px-5 text-[15px] font-medium"
      >
        Повторить
      </button>
    </div>
  );
}
