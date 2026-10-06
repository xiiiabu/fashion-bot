import Link from 'next/link';

/** A dead route inside a Mini App usually means a stale deep link. */
export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-5 px-8 text-center">
      <p className="t-display text-[3rem] leading-none text-[var(--fg-faint)]">404</p>
      <p className="max-w-[28ch] text-[14px] leading-relaxed text-[var(--fg-muted)]">
        Такой страницы нет. Возможно, ссылка устарела.
      </p>
      <Link
        href="/"
        className="inline-flex h-12 items-center rounded-[var(--radius-md)] bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--on-accent)]"
      >
        На главную
      </Link>
    </div>
  );
}
