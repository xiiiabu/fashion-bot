'use client';

/**
 * The primitive layer. Everything visual in the app is built from these, so a
 * change to a radius or a press state lands everywhere at once.
 *
 * Deliberate choices:
 *  - Buttons are 48px tall minimum. A 44px target is the floor for a thumb, and
 *    Telegram's own chrome eats the bottom of the screen on some clients.
 *  - No spinners inside buttons that swap the label out; the label stays and the
 *    button goes quiet, so the shopper can still read what they tapped.
 *  - Sheets, not modals. A Mini App is a phone surface and a sheet is what the
 *    platform does; a centred dialog looks like a website.
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
  type TextareaHTMLAttributes,
} from 'react';
import { haptic } from '@/lib/telegram';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ── Button ──────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--accent)] text-[var(--on-accent)] active:bg-[var(--accent-deep)]',
  secondary: 'bg-[var(--bg-sunken)] text-[var(--fg)] active:bg-[var(--line-soft)]',
  outline: 'border border-[var(--line)] text-[var(--fg)] active:bg-[var(--bg-sunken)]',
  ghost: 'text-[var(--fg)] active:bg-[var(--bg-sunken)]',
  danger: 'bg-danger-soft text-danger active:opacity-80',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-[13px] rounded-[var(--radius-md)]',
  md: 'h-12 px-5 text-[15px] rounded-[var(--radius-md)]',
  lg: 'h-14 px-6 text-[16px] rounded-[var(--radius-lg)]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, block, icon, className, children, onClick, ...rest },
  ref,
) {
  const handle = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      haptic.tap(variant === 'primary' ? 'medium' : 'light');
      onClick?.(event);
    },
    [onClick, variant],
  );

  return (
    <button
      ref={ref}
      type="button"
      onClick={handle}
      className={cx(
        'pressable inline-flex items-center justify-center gap-2 font-medium tracking-[-0.01em]',
        'disabled:pointer-events-none disabled:opacity-45',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        block && 'w-full',
        loading && 'pointer-events-none',
        className,
      )}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 13 : 16} /> : icon}
      <span className={cx(loading && 'opacity-60')}>{children}</span>
    </button>
  );
});

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cx('animate-spin', className)}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Icon button ─────────────────────────────────────────────────────────── */

export function IconButton({
  label,
  children,
  active,
  className,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        haptic.tap('light');
        onClick?.(event);
      }}
      className={cx(
        'pressable inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
        active
          ? 'bg-[var(--accent)] text-[var(--on-accent)]'
          : 'bg-[var(--bg-raised)]/88 text-[var(--fg)] backdrop-blur-md',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Chip ────────────────────────────────────────────────────────────────── */

export function Chip({
  selected,
  children,
  onClick,
  className,
  disabled,
  count,
}: {
  selected?: boolean;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  count?: number;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={() => {
        haptic.select();
        onClick?.();
      }}
      className={cx(
        'pressable inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium',
        'disabled:pointer-events-none disabled:opacity-40',
        selected
          ? 'bg-[var(--fg)] text-[var(--bg)]'
          : 'border border-[var(--line)] bg-[var(--bg-raised)] text-[var(--fg-soft)]',
        className,
      )}
    >
      {children}
      {count !== undefined && (
        <span className={cx('text-[11px]', selected ? 'opacity-60' : 'text-[var(--fg-faint)]')}>
          {count}
        </span>
      )}
    </button>
  );
}

/* ── Badge ───────────────────────────────────────────────────────────────── */

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'dark';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--bg-sunken)] text-[var(--fg-muted)]',
  accent: 'bg-[var(--accent-soft)] text-[var(--accent-deep)]',
  success: 'bg-success-soft text-success',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  dark: 'bg-[var(--fg)] text-[var(--bg)]',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.07em]',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Inputs ──────────────────────────────────────────────────────────────── */

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string | null;
  suffix?: ReactNode;
  children: ReactNode;
  required?: boolean;
}

export function Field({ label, hint, error, children, required }: FieldProps) {
  return (
    <label className="block">
      {label && (
        <span className="t-label mb-1.5 block">
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

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          'h-12 w-full rounded-[var(--radius-md)] border bg-[var(--bg-raised)] px-3.5',
          'text-[15px] placeholder:text-[var(--fg-faint)]',
          'focus:border-[var(--accent)] focus:outline-none',
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
          'w-full resize-none rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--bg-raised)] px-3.5 py-3',
          'text-[15px] placeholder:text-[var(--fg-faint)] focus:border-[var(--accent)] focus:outline-none',
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 py-0.5">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-[15px] leading-snug">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--fg-faint)]">{hint}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          haptic.select();
          onChange(!checked);
        }}
        className={cx(
          'relative mt-0.5 h-[28px] w-[46px] shrink-0 rounded-full transition-colors duration-200',
          'disabled:opacity-40',
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--line)]',
        )}
      >
        <span
          className={cx(
            'absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow-sm transition-transform duration-200',
            checked ? 'translate-x-[21px]' : 'translate-x-[3px]',
          )}
          style={{ transitionTimingFunction: 'var(--ease-out-soft)' }}
        />
      </button>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        haptic.select();
        onChange(!checked);
      }}
      className="flex w-full items-start gap-3 text-left disabled:opacity-40"
    >
      <span
        className={cx(
          'mt-0.5 flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] border transition-colors',
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]'
            : 'border-[var(--line)] bg-[var(--bg-raised)]',
        )}
      >
        {checked && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path
              d="M2.5 6.2 4.7 8.4 9.5 3.6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-1 text-[14.5px] leading-snug">{label}</span>
    </button>
  );
}

export function Radio({
  checked,
  onChange,
  label,
  hint,
  trailing,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  hint?: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        haptic.select();
        onChange();
      }}
      className={cx(
        'flex w-full items-center gap-3 rounded-[var(--radius-md)] border p-3.5 text-left transition-colors',
        'disabled:opacity-40',
        checked ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-[var(--bg-raised)]',
      )}
    >
      <span
        className={cx(
          'flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full border-2',
          checked ? 'border-[var(--accent)]' : 'border-[var(--line)]',
        )}
      >
        {checked && <span className="h-[10px] w-[10px] rounded-full bg-[var(--accent)]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-medium leading-snug">{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] text-[var(--fg-muted)]">{hint}</span>}
      </span>
      {trailing && <span className="shrink-0 text-[14px]">{trailing}</span>}
    </button>
  );
}

/* ── Stepper ─────────────────────────────────────────────────────────────── */

export function Stepper({
  value,
  min = 1,
  max = 10,
  onChange,
  disabled,
  busy,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div
      className={cx(
        'inline-flex h-9 items-center rounded-full border border-[var(--line)] bg-[var(--bg-raised)]',
        disabled && 'opacity-50',
      )}
    >
      <button
        type="button"
        aria-label="−"
        disabled={disabled || busy || value <= min}
        onClick={() => {
          haptic.tap('light');
          onChange(value - 1);
        }}
        className="flex h-9 w-9 items-center justify-center rounded-l-full text-[18px] leading-none disabled:opacity-30"
      >
        −
      </button>
      <span className="t-num w-7 text-center text-[14px] font-medium">
        {busy ? <Spinner size={12} className="mx-auto" /> : value}
      </span>
      <button
        type="button"
        aria-label="+"
        disabled={disabled || busy || value >= max}
        onClick={() => {
          haptic.tap('light');
          onChange(value + 1);
        }}
        className="flex h-9 w-9 items-center justify-center rounded-r-full text-[18px] leading-none disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

/* ── Sheet ───────────────────────────────────────────────────────────────── */

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  /** 'auto' hugs the content; 'tall' takes most of the viewport for a filter list. */
  height = 'auto',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  height?: 'auto' | 'tall';
}) {
  const scrim = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={scrim}
      role="dialog"
      aria-modal="true"
      className="fade fixed inset-0 z-50 flex items-end"
      style={{ background: 'var(--scrim)' }}
      onClick={(event) => {
        if (event.target === scrim.current) onClose();
      }}
    >
      <div
        className={cx(
          'sheet-up flex w-full flex-col overflow-hidden rounded-t-[var(--radius-xl)] bg-[var(--bg)]',
          height === 'tall' && 'h-[86vh]',
          height === 'auto' && 'max-h-[86vh]',
        )}
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <div className="relative shrink-0 px-5 pt-3">
          <div className="mx-auto h-1 w-10 rounded-full bg-[var(--line)]" />
          {title && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <h2 className="t-section min-w-0 truncate">{title}</h2>
              <IconButton label="Close" onClick={onClose} className="-mr-1 bg-transparent">
                <CloseIcon />
              </IconButton>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-3">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-[var(--line)] bg-[var(--bg-raised)] px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Section ─────────────────────────────────────────────────────────────── */

export function Section({
  title,
  eyebrow,
  action,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Skip the horizontal padding so a rail can bleed to the edges. */
  flush?: boolean;
}) {
  return (
    <section className={cx('py-5', className)}>
      {(title || action || eyebrow) && (
        <header className="mb-3.5 flex items-end justify-between gap-3 px-4">
          <div className="min-w-0">
            {eyebrow && <p className="t-eyebrow mb-1">{eyebrow}</p>}
            {title && <h2 className="t-section truncate">{title}</h2>}
          </div>
          {action && <div className="shrink-0 pb-0.5">{action}</div>}
        </header>
      )}
      <div className={flush ? '' : 'px-4'}>{children}</div>
    </section>
  );
}

/* ── Row ─────────────────────────────────────────────────────────────────── */

export function Row({
  icon,
  title,
  hint,
  trailing,
  onClick,
  href,
  danger,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
  className?: string;
}) {
  const content = (
    <>
      {icon && (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--bg-sunken)] text-[var(--fg-soft)]">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate text-[15px]', danger && 'text-danger')}>{title}</span>
        {hint && <span className="mt-0.5 block truncate text-[12.5px] text-[var(--fg-faint)]">{hint}</span>}
      </span>
      {trailing !== undefined ? (
        <span className="shrink-0 text-[13.5px] text-[var(--fg-muted)]">{trailing}</span>
      ) : (onClick || href) ? (
        <ChevronIcon className="shrink-0 text-[var(--fg-faint)]" />
      ) : null}
    </>
  );

  const classes = cx(
    'flex w-full items-center gap-3 px-4 py-3.5 text-left',
    (onClick || href) && 'pressable active:bg-[var(--bg-sunken)]',
    className,
  );

  if (href) {
    return (
      <a href={href} className={classes} onClick={() => haptic.tap('light')}>
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={
        onClick
          ? () => {
              haptic.tap('light');
              onClick();
            }
          : undefined
      }
      disabled={!onClick}
      className={classes}
    >
      {content}
    </button>
  );
}

export function RowGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg-raised)]',
        '[&>*+*]:border-t [&>*+*]:border-[var(--line-soft)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Empty / error / loading ─────────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rise flex flex-col items-center px-8 py-16 text-center">
      {icon && <div className="mb-5 text-[var(--fg-faint)]">{icon}</div>}
      <h3 className="t-section">{title}</h3>
      {body && <p className="mt-2 max-w-[28ch] text-[14px] leading-relaxed text-[var(--fg-muted)]">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-[var(--radius-md)]', className)} />;
}

export function LoadingScreen() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Spinner size={22} className="text-[var(--fg-faint)]" />
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = 'Retry',
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <EmptyState
      icon={<AlertIcon size={32} />}
      title={message}
      action={
        onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
    />
  );
}

/* ── Divider & Note ─────────────────────────────────────────────────────── */

export function Divider({ className }: { className?: string }) {
  return <hr className={cx('border-t border-[var(--line)]', className)} />;
}

export function Note({
  tone = 'info',
  title,
  children,
  icon,
}: {
  tone?: 'info' | 'warn' | 'success' | 'danger' | 'neutral';
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  const tones: Record<string, string> = {
    info: 'bg-info-soft text-info',
    warn: 'bg-warn-soft text-warn',
    success: 'bg-success-soft text-success',
    danger: 'bg-danger-soft text-danger',
    neutral: 'bg-[var(--bg-sunken)] text-[var(--fg-muted)]',
  };
  return (
    <div className={cx('flex gap-2.5 rounded-[var(--radius-md)] p-3.5', tones[tone])}>
      {icon && <span className="mt-[1px] shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        {title && <p className="mb-0.5 font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/* ── Collapsible ─────────────────────────────────────────────────────────── */

export function Collapsible({
  title,
  children,
  defaultOpen,
  trailing,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className="border-b border-[var(--line)]">
      <button
        type="button"
        onClick={() => {
          haptic.tap('light');
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-4 text-left"
      >
        <span className="min-w-0 flex-1 text-[15px] font-medium">{title}</span>
        {trailing && <span className="shrink-0 text-[13px] text-[var(--fg-muted)]">{trailing}</span>}
        <ChevronIcon
          className={cx(
            'shrink-0 text-[var(--fg-faint)] transition-transform duration-200',
            open ? '-rotate-90' : 'rotate-90',
          )}
        />
      </button>
      {open && <div className="fade pb-4 text-[14px] leading-relaxed text-[var(--fg-soft)]">{children}</div>}
    </div>
  );
}

/* ── Segmented control ──────────────────────────────────────────────────── */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cx('flex gap-0.5 rounded-full bg-[var(--bg-sunken)] p-0.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => {
              haptic.select();
              onChange(option.value);
            }}
            className={cx(
              'flex-1 rounded-full py-2 text-[13.5px] font-medium transition-colors',
              active ? 'bg-[var(--bg-raised)] text-[var(--fg)] shadow-sm' : 'text-[var(--fg-muted)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Stars ───────────────────────────────────────────────────────────────── */

export function Stars({ value, size = 13 }: { value: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-[1px]" aria-label={`${value} / 5`}>
      {[1, 2, 3, 4, 5].map((index) => (
        <svg key={index} width={size} height={size} viewBox="0 0 16 16" aria-hidden>
          <path
            d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.6z"
            fill={index <= Math.round(value) ? 'var(--accent)' : 'var(--line)'}
          />
        </svg>
      ))}
    </span>
  );
}

/* ── Icons ───────────────────────────────────────────────────────────────── */

type IconProps = { size?: number; className?: string };

function icon(path: ReactNode, viewBox = '0 0 24 24') {
  return function Icon({ size = 20, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden
      >
        {path}
      </svg>
    );
  };
}

export const CloseIcon = icon(<path d="M6 6l12 12M18 6L6 18" />);
export const ChevronIcon = icon(<path d="M9 5l7 7-7 7" />);
export const ChevronLeftIcon = icon(<path d="M15 5l-7 7 7 7" />);
export const ChevronDownIcon = icon(<path d="M5 9l7 7 7-7" />);
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4.3-4.3" />
  </>,
);
export const HomeIcon = icon(<path d="M4 11.2 12 4l8 7.2V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />);
export const BagIcon = icon(
  <>
    <path d="M5.5 8h13l-1.1 11.2a1 1 0 0 1-1 .8H7.6a1 1 0 0 1-1-.8z" />
    <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
  </>,
);
export const HeartIcon = function HeartIcon({
  size = 20,
  className,
  filled,
}: IconProps & { filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M12 20s-7.5-4.6-7.5-9.4A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 3c0 4.8-7.5 9.4-7.5 9.4z" />
    </svg>
  );
};
export const SparkleIcon = icon(
  <>
    <path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7z" />
    <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </>,
);
export const UserIcon = icon(
  <>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M4.8 20c.9-3.4 3.7-5.4 7.2-5.4s6.3 2 7.2 5.4" />
  </>,
);
export const FilterIcon = icon(
  <>
    <path d="M4 7h16M7 12h10M10 17h4" />
  </>,
);
export const SortIcon = icon(
  <>
    <path d="M7 5v14M7 19l-3-3M7 19l3-3M17 19V5M17 5l-3 3M17 5l3 3" />
  </>,
);
export const AlertIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5M12 16.2v.3" />
  </>,
);
export const CheckIcon = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const TruckIcon = icon(
  <>
    <path d="M3 7h10v9H3zM13 10h4l3 3v3h-7z" />
    <circle cx="7" cy="18" r="1.6" />
    <circle cx="17" cy="18" r="1.6" />
  </>,
);
export const ReturnIcon = icon(
  <>
    <path d="M4 10h11a4.5 4.5 0 1 1 0 9h-3" />
    <path d="M8 6l-4 4 4 4" />
  </>,
);
export const RulerIcon = icon(
  <>
    <path d="M3.8 14.6 14.6 3.8l5.6 5.6L9.4 20.2z" />
    <path d="M8 10.4l1.6 1.6M11 7.4 12.6 9M14 4.4 15.6 6" />
  </>,
);
export const ShieldIcon = icon(<path d="M12 3.5l7 2.5v5.4c0 4.2-2.8 7.6-7 9.1-4.2-1.5-7-4.9-7-9.1V6z" />);
export const GlobeIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.4 2.4 14.1 0 17M12 3.5c-2.4 2.4-2.4 14.1 0 17" />
  </>,
);
export const TagIcon = icon(
  <>
    <path d="M11.3 3.5H20V12l-8.6 8.6a1.4 1.4 0 0 1-2 0l-6-6a1.4 1.4 0 0 1 0-2z" />
    <circle cx="16" cy="8" r="1.3" />
  </>,
);
export const ReceiptIcon = icon(
  <>
    <path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" />
    <path d="M9 8h6M9 11.5h6M9 15h3" />
  </>,
);
export const HelpIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.3M12 16.8v.3" />
  </>,
);
export const PinIcon = icon(
  <>
    <path d="M12 21s6.5-6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21z" />
    <circle cx="12" cy="10" r="2.4" />
  </>,
);
export const TrashIcon = icon(
  <>
    <path d="M4.5 7h15M9 7V5h6v2M6.5 7l.9 12a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9l.9-12" />
  </>,
);
export const SwapIcon = icon(
  <>
    <path d="M4 8h12l-3-3M20 16H8l3 3" />
  </>,
);
export const LockIcon = icon(
  <>
    <rect x="5" y="10.5" width="14" height="10" rx="1.6" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </>,
);
export const DownloadIcon = icon(
  <>
    <path d="M12 4v11M12 15l-4-4M12 15l4-4M5 19h14" />
  </>,
);
export const ChatIcon = icon(<path d="M20 12a7.5 7.5 0 0 1-11 6.6L5 20l1.3-3.7A7.5 7.5 0 1 1 20 12z" />);
export const StoreIcon = icon(
  <>
    <path d="M4 9.5 5.5 5h13L20 9.5M4 9.5h16V20H4z" />
    <path d="M9.5 20v-5h5v5" />
  </>,
);
export const ClockIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>,
);
