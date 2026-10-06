'use client';

/**
 * Operator primitives.
 *
 * Tuned for density and for reading rather than for touch: 34px controls
 * instead of 48, tables instead of cards, and a status vocabulary that is the
 * same colour everywhere so an operator learns it once.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ── Button ──────────────────────────────────────────────────────────────── */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'xs' | 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-deep)]',
  secondary: 'bg-[var(--bg-sunken)] text-[var(--fg)] hover:bg-[var(--line-soft)]',
  outline: 'border border-[var(--line)] bg-[var(--bg-raised)] hover:bg-[var(--bg-sunken)]',
  ghost: 'text-[var(--fg-soft)] hover:bg-[var(--bg-sunken)]',
  // A destructive action is outlined in its own colour, never merely red text:
  // on a dense screen a red word is easy to mistake for a status.
  danger: 'border border-danger/45 bg-danger-soft text-danger hover:bg-danger/12',
};

const SIZES: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-[12px] rounded-[var(--radius-sm)] gap-1',
  sm: 'h-8 px-3 text-[13px] rounded-[var(--radius-sm)] gap-1.5',
  md: 'h-9 px-4 text-[13.5px] rounded-[var(--radius-md)] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', loading, block, icon, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        loading && 'pointer-events-none',
        className,
      )}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={13} /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cx('animate-spin', className)} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.6" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

/* ── Status pill ─────────────────────────────────────────────────────────── */

export type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'dark';

const TONES: Record<Tone, string> = {
  neutral: 'bg-[var(--bg-sunken)] text-[var(--fg-muted)] ring-[var(--line)]',
  accent: 'bg-[var(--accent-soft)] text-[var(--accent-deep)] ring-[var(--accent)]/28',
  success: 'bg-success-soft text-success ring-success/28',
  warn: 'bg-warn-soft text-warn ring-warn/28',
  danger: 'bg-danger-soft text-danger ring-danger/28',
  info: 'bg-info-soft text-info ring-info/28',
  dark: 'bg-[var(--fg)] text-[var(--bg)] ring-transparent',
};

export function Pill({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-[2px] text-[11px] font-semibold ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Inputs ──────────────────────────────────────────────────────────────── */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          'h-9 w-full rounded-[var(--radius-sm)] border bg-[var(--bg-raised)] px-2.5 text-[13.5px]',
          'placeholder:text-[var(--fg-faint)] focus:border-[var(--accent)] focus:outline-none',
          invalid ? 'border-danger' : 'border-[var(--line)]',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cx(
          'w-full resize-y rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--bg-raised)] px-2.5 py-2',
          'text-[13.5px] placeholder:text-[var(--fg-faint)] focus:border-[var(--accent)] focus:outline-none',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={cx(
          'h-9 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--bg-raised)] px-2 text-[13.5px]',
          'focus:border-[var(--accent)] focus:outline-none',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
    );
  },
);

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      {label && (
        <span className="t-label mb-1 block">
          {label}
          {required && <span className="text-danger"> *</span>}
        </span>
      )}
      {children}
      {error ? (
        <span className="mt-1 block text-[12px] text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[12px] text-[var(--fg-faint)]">{hint}</span>
      ) : null}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-[1px] h-[20px] w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-40',
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--line)]',
        )}
      >
        <span
          className={cx(
            'absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-[16px]' : 'translate-x-[2px]',
          )}
        />
      </button>
      {(label || hint) && (
        <span className="min-w-0">
          {label && (
            <label htmlFor={id} className="block text-[13.5px] leading-snug">
              {label}
            </label>
          )}
          {hint && <span className="mt-0.5 block text-[12px] text-[var(--fg-faint)]">{hint}</span>}
        </span>
      )}
    </div>
  );
}

/* ── Layout ──────────────────────────────────────────────────────────────── */

export function Card({
  title,
  action,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={cx(
        'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)]',
        className,
      )}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2.5">
          <h2 className="text-[13.5px] font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="t-display text-[22px] leading-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}

/**
 * A metric. The label sits above the number because an operator scans the
 * numbers first and reads the label only when one surprises them.
 */
export function Stat({
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
}) {
  const body = (
    <>
      <p className="t-label truncate">{label}</p>
      <p className={cx('t-money mt-1 text-[20px] leading-none', tone === 'danger' && 'text-danger')}>
        {value}
      </p>
      {hint && <p className="mt-1.5 truncate text-[12px] text-[var(--fg-faint)]">{hint}</p>}
    </>
  );
  const className = cx(
    'rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)] p-3.5 text-left',
    onClick && 'transition-colors hover:border-[var(--accent)]/45 hover:bg-[var(--bg-sunken)]',
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

/* ── Table ───────────────────────────────────────────────────────────────── */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('scroll-x', className)}>
      <table className="data-table">{children}</table>
    </div>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-10 text-center text-[13px] text-[var(--fg-muted)]">
        {children}
      </td>
    </tr>
  );
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: cols }).map((__, colIndex) => (
            <td key={colIndex}>
              <div className="skeleton h-3.5 w-full" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/* ── Feedback ────────────────────────────────────────────────────────────── */

export function Note({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'success' | 'danger' | 'neutral';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tones: Record<string, string> = {
    info: 'bg-info-soft text-info',
    warn: 'bg-warn-soft text-warn',
    success: 'bg-success-soft text-success',
    danger: 'bg-danger-soft text-danger',
    neutral: 'bg-[var(--bg-sunken)] text-[var(--fg-muted)]',
  };
  return (
    <div className={cx('flex items-start gap-3 rounded-[var(--radius-md)] px-3.5 py-3', tones[tone])}>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        {title && <p className="mb-0.5 font-semibold">{title}</p>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-danger/35 bg-danger-soft p-5 text-center">
      <p className="text-[13.5px] text-danger">{message}</p>
      {onRetry && (
        <Button className="mt-3" variant="outline" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-14 text-center">
      <p className="text-[14px] font-medium">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-[46ch] text-[13px] text-[var(--fg-muted)]">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ── Modal ───────────────────────────────────────────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const scrim = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={scrim}
      role="dialog"
      aria-modal="true"
      className="fade fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6"
      style={{ background: 'var(--scrim)' }}
      onClick={(event) => {
        if (event.target === scrim.current) onClose();
      }}
    >
      <div
        className="rise my-auto w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)] shadow-xl"
        style={{ maxWidth: width }}
      >
        {title && (
          <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
            <h2 className="text-[14px] font-semibold">{title}</h2>
            <button
              type="button"
              aria-label="Закрыть"
              onClick={onClose}
              className="text-[var(--fg-faint)] hover:text-[var(--fg)]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
        )}
        <div className="px-4 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-[var(--line)] bg-[var(--bg-sunken)] px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * A confirmation that makes the operator read what they are about to do.
 *
 * `confirmWord` requires typing a literal — used where the action moves money
 * or cannot be undone. A button that only needs a second click is not a
 * safeguard, it is a speed bump.
 */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = 'Подтвердить',
  confirmWord,
  danger,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  confirmWord?: string;
  danger?: boolean;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const ready = !confirmWord || typed.trim().toUpperCase() === confirmWord.toUpperCase();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!ready}
            loading={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <div className="text-[13.5px] leading-relaxed text-[var(--fg-soft)]">{body}</div>}
      {confirmWord && (
        <div className="mt-4">
          <Field label={`Введите «${confirmWord}», чтобы подтвердить`}>
            <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cx('flex gap-1 border-b border-[var(--line)]', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(option.value)}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
              active
                ? 'border-[var(--accent)] text-[var(--fg)]'
                : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="t-num ml-1.5 text-[11.5px] text-[var(--fg-faint)]">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Copy ────────────────────────────────────────────────────────────────── */

/** Ids and correlation ids exist to be pasted into a search or a ticket. */
export function CopyId({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      className="t-mono inline-flex items-center gap-1 text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      {label ?? `${value.slice(0, 8)}…`}
      <span className={cx('text-[10px]', copied ? 'text-success' : 'text-[var(--fg-faint)]')}>
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  );
}

/* ── Toasts ──────────────────────────────────────────────────────────────── */

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => onDismiss(toast.id)}
          className={cx(
            'rise pointer-events-auto max-w-[46ch] rounded-[var(--radius-md)] px-3.5 py-2.5 text-left text-[13px] shadow-lg',
            toast.tone === 'error'
              ? 'bg-danger text-white'
              : toast.tone === 'success'
                ? 'bg-success text-white'
                : 'bg-[var(--fg)] text-[var(--bg)]',
          )}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
