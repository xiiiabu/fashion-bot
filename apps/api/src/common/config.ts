/**
 * Typed configuration. Everything the service needs comes from the
 * environment (SEC-004: no secrets in code), is validated once at boot, and
 * fails loudly rather than defaulting a production secret to a dev value.
 */

import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    });

const int = (fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const csv = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim() !== ''
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : fallback,
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().optional(),

  API_PORT: int(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  MINIAPP_PUBLIC_URL: z.string().default('http://localhost:3000'),
  ADMIN_PUBLIC_URL: z.string().default('http://localhost:3001'),
  CORS_ORIGINS: csv(['http://localhost:3000', 'http://localhost:3001']),

  SESSION_JWT_SECRET: z.string().min(16),
  SESSION_ACCESS_TTL: int(900),
  SESSION_REFRESH_TTL: int(2_592_000),
  ADMIN_JWT_SECRET: z.string().min(16),
  ADMIN_SESSION_TTL: int(3600),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_BOT_USERNAME: z.string().optional().default(''),
  TELEGRAM_MINIAPP_URL: z.string().optional().default(''),
  TELEGRAM_INITDATA_MAX_AGE: int(86_400),

  DEV_AUTH_ENABLED: bool(false),
  DEV_AUTH_SECRET: z.string().optional().default(''),

  PAYMENTS_ENABLED: bool(true),
  /**
   * PAYMENTS_LIVE=false is the state this release ships in: the orchestrator,
   * commission, ledger and refunds all run, but against the mock provider.
   * No real money moves until a PSP contract and certification are in place
   * (spec §8.4 "обязательное решение до production").
   */
  PAYMENTS_LIVE: bool(false),
  PAYMENT_PROVIDERS: csv(['mock']),
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().optional().default('dev-mock-webhook-secret'),
  PAYME_MERCHANT_ID: z.string().optional().default(''),
  PAYME_SECRET_KEY: z.string().optional().default(''),
  CLICK_MERCHANT_ID: z.string().optional().default(''),
  CLICK_SERVICE_ID: z.string().optional().default(''),
  CLICK_SECRET_KEY: z.string().optional().default(''),
  UZUM_MERCHANT_ID: z.string().optional().default(''),
  UZUM_SECRET_KEY: z.string().optional().default(''),

  DEFAULT_CURRENCY: z.enum(['UZS', 'USD', 'EUR', 'RUB']).default('UZS'),
  DEFAULT_COMMISSION_BPS: int(1000),
  COMMISSION_INCLUDES_DELIVERY: bool(false),
  RESERVATION_TTL_SECONDS: int(900),
  QUOTE_TTL_SECONDS: int(900),
  RETURN_WINDOW_DAYS: int(14),
  TIMEZONE: z.string().default('Asia/Tashkent'),

  AI_PROVIDER: z.enum(['local', 'anthropic']).default('local'),
  AI_LLM_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  AI_EXPLANATION_TIMEOUT_MS: int(6000),
  AI_FIT_CONFIDENCE_THRESHOLD: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0.55'));
      return Number.isFinite(parsed) ? parsed : 0.55;
    }),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  STORAGE_PUBLIC_BASE: z.string().default('http://localhost:4000/media'),

  RATE_LIMIT_WINDOW_MS: int(60_000),
  RATE_LIMIT_MAX: int(180),
  RATE_LIMIT_AI_MAX: int(20),
  RATE_LIMIT_AUTH_MAX: int(30),
});

export type AppConfig = z.infer<typeof schema> & {
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly telegramConfigured: boolean;
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === 'production';

  // SEC-004: a dev placeholder must never reach production.
  if (isProduction) {
    const weak: string[] = [];
    if (value.SESSION_JWT_SECRET.includes('dev-only')) weak.push('SESSION_JWT_SECRET');
    if (value.ADMIN_JWT_SECRET.includes('dev-only')) weak.push('ADMIN_JWT_SECRET');
    if (weak.length > 0) {
      throw new Error(`Refusing to start: development secrets in production (${weak.join(', ')})`);
    }
    if (value.DEV_AUTH_ENABLED) {
      throw new Error('Refusing to start: DEV_AUTH_ENABLED must be 0 in production (TG-001)');
    }
  }

  cached = {
    ...value,
    isProduction,
    isDevelopment: value.NODE_ENV === 'development',
    telegramConfigured: value.TELEGRAM_BOT_TOKEN.trim() !== '',
  };
  return cached;
}

export const CONFIG = 'APP_CONFIG';
