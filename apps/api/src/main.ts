/**
 * API entrypoint.
 *
 * SEC-003: TLS termination is the platform's job, but the headers, CORS
 * policy and body limits are this file's. The raw body is captured for the
 * webhook routes so a provider signature can be verified over the exact bytes
 * that were signed (PAY-004).
 */

import 'reflect-metadata';
import { loadEnvFile } from './common/env';

// Before any module reads process.env, including the Prisma client.
loadEnvFile();

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';
import { NestPinoLogger, logger } from './common/logger';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new NestPinoLogger(),
    bodyParser: false,
  });

  // PAY-004: keep the raw body for signature verification. Providers sign the
  // bytes, so re-serialising the parsed object would break the HMAC.
  const captureRawBody = (req: Request, _res: Response, buf: Buffer): void => {
    if (req.originalUrl?.includes('/payments/webhook')) {
      (req as Request & { rawBodyText?: string }).rawBodyText = buf.toString('utf8');
    }
  };

  app.use(express.json({ limit: '6mb', verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: '2mb', verify: captureRawBody }));

  // SEC-003: secure headers. The API serves JSON plus one sandbox HTML page,
  // so the CSP is restrictive and set per response rather than globally loose.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'geolocation=(), camera=(), microphone=()');
    res.setHeader('cross-origin-resource-policy', 'same-site');
    if (config.isProduction) {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    if (req.path.startsWith('/payments/mock/')) {
      // The sandbox page runs one inline script of our own and nothing else.
      res.setHeader(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      );
      res.removeHeader('x-frame-options');
    } else {
      res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
    next();
  });

  app.enableCors({
    origin: (origin, callback) => {
      // Server-to-server calls (bot, webhooks) have no Origin header.
      if (!origin) return callback(null, true);
      if (config.CORS_ORIGINS.includes(origin)) return callback(null, true);
      // Telegram serves Mini Apps from web.telegram.org and the native clients
      // send no origin, so only the configured app origins need allowing.
      logger.warn({ origin }, 'blocked CORS origin');
      return callback(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-locale',
      'x-correlation-id',
      'idempotency-key',
      'x-bot-signature',
    ],
    exposedHeaders: ['x-correlation-id', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
    maxAge: 600,
  });

  // Product media. In production this is an S3-compatible bucket behind a CDN
  // (§13.1); locally the API serves the generated files so the Mini App has
  // real imagery with no external dependency.
  if (config.STORAGE_DRIVER === 'local') {
    app.use(
      '/media',
      express.static(config.STORAGE_LOCAL_DIR.replace(/\/$/, '') + '/media', {
        immutable: true,
        maxAge: '7d',
        setHeaders: (res) => {
          res.setHeader('cross-origin-resource-policy', 'cross-origin');
          res.removeHeader('content-security-policy');
        },
      }),
    );
  }

  app.set('trust proxy', 1);
  app.enableShutdownHooks();

  await app.listen(config.API_PORT, '0.0.0.0');

  logger.info(
    {
      port: config.API_PORT,
      env: config.NODE_ENV,
      paymentsLive: config.PAYMENTS_LIVE,
      providers: config.PAYMENT_PROVIDERS,
      aiProvider: config.AI_PROVIDER,
      telegram: config.telegramConfigured ? 'configured' : 'not configured',
    },
    'fashion marketplace API listening',
  );

  if (!config.PAYMENTS_LIVE) {
    logger.warn(
      'PAYMENTS_LIVE=false — the sandbox provider is in use. No card is charged; commission, ledger, refunds and payouts run for real.',
    );
  }
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'failed to start the API');
  process.exitCode = 1;
});
