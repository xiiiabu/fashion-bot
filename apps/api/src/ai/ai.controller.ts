/**
 * AI endpoints — API group "AI" (§14.2):
 * /ai/style-intent, /ai/outfits, /ai/replace-item, /fit/recommendation, /feedback.
 *
 * NFR-006: these endpoints are the only ones that depend on the AI stack. If
 * every one of them fails, catalogue, cart and checkout are unaffected — which
 * is what the chaos test in UAT-20 checks.
 */

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  COLOR_FAMILIES,
  OCCASIONS,
  OUTFIT_SLOTS,
  SEASONS,
  STYLE_TAGS,
  type Locale,
  fromMajor,
} from '@fashion/core';
import { StylistService } from './stylist.service';
import { LlmService } from './llm.service';
import { CartService } from '../cart/cart.service';
import { Actor, CurrentUserId, RateLimit, RequestLocale, zodBody } from '../common/http';
import type { AuthenticatedActor } from '../common/http';
import { OptionalAuth as OptionalAuthGuard } from '../identity/guards';
import { loadConfig } from '../common/config';

const overridesSchema = z
  .object({
    styles: z.array(z.enum(STYLE_TAGS)).max(6).optional(),
    occasions: z.array(z.enum(OCCASIONS)).max(4).optional(),
    season: z.enum(SEASONS).nullable().optional(),
    preferredColors: z.array(z.enum(COLOR_FAMILIES)).max(6).optional(),
    avoidColors: z.array(z.enum(COLOR_FAMILIES)).max(6).optional(),
    requiredSlots: z.array(z.enum(OUTFIT_SLOTS)).max(6).optional(),
    excludedSlots: z.array(z.enum(OUTFIT_SLOTS)).max(6).optional(),
    excludedBrandIds: z.array(z.string().uuid()).max(20).optional(),
    preferredBrandIds: z.array(z.string().uuid()).max(20).optional(),
    gender: z.enum(['women', 'men', 'unisex']).nullable().optional(),
    /** Budget in major units (soum), which is how a shopper thinks. */
    budgetMajor: z.number().positive().max(2_000_000_000).nullable().optional(),
  })
  .optional();

const generateSchema = z.object({
  query: z.string().min(2).max(500),
  templateKey: z.string().max(60).nullable().optional(),
  overrides: overridesSchema,
});

const intentSchema = z.object({
  query: z.string().min(1).max(500),
  overrides: overridesSchema,
});

const replaceSchema = z.object({
  slot: z.enum(OUTFIT_SLOTS),
  skuId: z.string().uuid().nullable().optional(),
});

@Controller('ai')
export class AiController {
  private readonly config = loadConfig();

  constructor(
    private readonly stylist: StylistService,
    private readonly llm: LlmService,
    private readonly cart: CartService,
  ) {}

  @OptionalAuthGuard()
  @Get('config')
  aiConfig(@RequestLocale() locale: Locale) {
    return {
      // The stylist always works; the LLM only changes the wording.
      available: true,
      llmEnabled: this.llm.enabled,
      llmModel: this.llm.model,
      fitConfidenceThreshold: this.config.AI_FIT_CONFIDENCE_THRESHOLD,
      suggestions: this.stylist.suggestions(locale),
      templates: this.stylist.templates(locale),
    };
  }

  /** AI-001: expose the parse, so the UI can show the chips it understood. */
  @OptionalAuthGuard()
  @RateLimit({ bucket: 'ai' })
  @Post('style-intent')
  async styleIntent(
    @Body(zodBody(intentSchema)) body: z.infer<typeof intentSchema>,
    @Actor() actor: AuthenticatedActor | undefined,
    @RequestLocale() locale: Locale,
  ) {
    const intent = await this.stylist.parseIntent({
      query: body.query,
      userId: actor?.userId ?? null,
      locale,
      overrides: mapOverrides(body.overrides),
    });
    return {
      styles: intent.styles,
      occasions: intent.occasions,
      season: intent.season,
      budget: intent.budget,
      preferredColors: intent.preferredColors,
      avoidColors: intent.avoidColors,
      requiredSlots: intent.requiredSlots,
      excludedSlots: intent.excludedSlots,
      gender: intent.gender,
      language: intent.language,
      parseConfidence: intent.parseConfidence,
      unmatchedTerms: intent.unmatchedTerms,
    };
  }

  /** AI-002 … AI-006: the look itself. */
  @OptionalAuthGuard()
  @RateLimit({ bucket: 'ai' })
  @Post('outfits')
  async generate(
    @Body(zodBody(generateSchema)) body: z.infer<typeof generateSchema>,
    @Actor() actor: AuthenticatedActor | undefined,
    @RequestLocale() locale: Locale,
  ) {
    return this.stylist.generate({
      query: body.query,
      userId: actor?.userId ?? null,
      locale,
      templateKey: body.templateKey ?? null,
      overrides: mapOverrides(body.overrides),
    });
  }

  @OptionalAuthGuard()
  @Get('outfits/:id')
  async getOutfit(
    @Param('id') id: string,
    @Actor() actor: AuthenticatedActor | undefined,
    @RequestLocale() locale: Locale,
  ) {
    const outfit = await this.stylist.getSession(id, actor?.userId ?? null, locale);
    return outfit ?? { id, items: [], expired: true };
  }

  /** AI-007: replace one item, keeping intent, budget and the rest. */
  @OptionalAuthGuard()
  @RateLimit({ bucket: 'ai' })
  @Post('outfits/:id/replace-item')
  async replace(
    @Param('id') id: string,
    @Body(zodBody(replaceSchema)) body: z.infer<typeof replaceSchema>,
    @Actor() actor: AuthenticatedActor | undefined,
    @RequestLocale() locale: Locale,
  ) {
    return this.stylist.replaceSlot(id, body.slot, {
      userId: actor?.userId ?? null,
      locale,
      skuId: body.skuId ?? null,
    });
  }

  @OptionalAuthGuard()
  @Get('outfits/:id/alternatives')
  async alternatives(
    @Param('id') id: string,
    @Query('slot') slot: string,
    @Actor() actor: AuthenticatedActor | undefined,
    @RequestLocale() locale: Locale,
  ) {
    const parsed = z.enum(OUTFIT_SLOTS).parse(slot);
    return this.stylist.alternativesForSlot(id, parsed, {
      userId: actor?.userId ?? null,
      locale,
    });
  }

  /**
   * AI-008: add the whole look. The stylist re-validates stock and size, the
   * cart service reports per-item exceptions, and the shopper sees both.
   */
  @RateLimit({ bucket: 'ai', max: 40 })
  @Post('outfits/:id/add-to-cart')
  async addToCart(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
    @RequestLocale() locale: Locale,
  ) {
    const prepared = await this.stylist.prepareForCart(id, userId);
    if (prepared.items.length === 0) {
      return {
        added: [],
        exceptions: prepared.exceptions,
        cart: await this.cart.view(userId, locale),
      };
    }
    const result = await this.cart.addLook(userId, prepared.items, {
      outfitSessionId: id,
      locale,
    });
    return {
      added: result.added,
      // Exceptions from both passes, so nothing disappears silently.
      exceptions: [...prepared.exceptions, ...result.exceptions],
      cart: result.cart,
    };
  }

  @Get('history')
  async history(@CurrentUserId() userId: string) {
    return { items: await this.stylist.history(userId) };
  }
}

function mapOverrides(
  overrides: z.infer<typeof overridesSchema>,
): Record<string, unknown> | undefined {
  if (!overrides) return undefined;
  const { budgetMajor, ...rest } = overrides;
  return {
    ...rest,
    ...(budgetMajor === null
      ? { budget: null }
      : budgetMajor !== undefined
        ? { budget: fromMajor(budgetMajor) }
        : {}),
  };
}
