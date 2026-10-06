/**
 * Health, readiness and the deployment's self-description.
 *
 * NFR-005/NFR-010: the readiness probe reports each dependency, so an
 * incident can be traced to a store rather than to "the API is down".
 */

import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LOCALES } from '@fashion/core';
import { Public } from './identity/guards';
import { PrismaService } from './common/prisma.service';
import { CacheService } from './common/cache.service';
import { loadConfig } from './common/config';
import { LlmService } from './ai/llm.service';
import { PaymentService } from './payments/payment.service';

const STARTED_AT = Date.now();

@Controller()
export class HealthController {
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly llm: LlmService,
    private readonly payments: PaymentService,
  ) {}

  @Public()
  @Get('healthz')
  liveness() {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000) };
  }

  @Public()
  @Get('readyz')
  async readiness(@Res() response: Response): Promise<void> {
    const [database, cache] = await Promise.all([this.prisma.ping(), this.cache.ping()]);
    // NFR-006: the AI stack is deliberately not part of readiness — an AI
    // outage must not take the catalogue or checkout out of rotation.
    const ready = database && cache;
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      checks: {
        database: database ? 'ok' : 'fail',
        cache: cache ? 'ok' : 'fail',
        cacheBackend: this.cache.backend,
      },
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    });
  }

  /** What the Mini App and the admin panel read at boot. */
  @Public()
  @Get('meta')
  meta() {
    return {
      service: 'fashion-marketplace-api',
      version: '1.0.0',
      environment: this.config.NODE_ENV,
      locales: LOCALES,
      currency: this.config.DEFAULT_CURRENCY,
      timezone: this.config.TIMEZONE,
      commission: {
        defaultRatePercent: this.config.DEFAULT_COMMISSION_BPS / 100,
        includesDelivery: this.config.COMMISSION_INCLUDES_DELIVERY,
      },
      reservationTtlSeconds: this.config.RESERVATION_TTL_SECONDS,
      returnWindowDays: this.config.RETURN_WINDOW_DAYS,
      telegram: {
        configured: this.config.telegramConfigured,
        botUsername: this.config.TELEGRAM_BOT_USERNAME || null,
      },
      ai: { llmEnabled: this.llm.enabled, model: this.llm.model, engine: '1.0.0' },
      payments: {
        enabled: this.config.PAYMENTS_ENABLED,
        /**
         * false in this release: the orchestrator, commission, ledger and
         * refunds all run, but against the sandbox provider. Going live needs
         * the §8.4 decisions plus PSP contracts and certification.
         */
        live: this.config.PAYMENTS_LIVE,
        providers: this.payments.listMethods(),
      },
    };
  }
}
