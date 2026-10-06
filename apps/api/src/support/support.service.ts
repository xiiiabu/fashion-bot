/**
 * Support, CMS administration and platform operations.
 *
 * FUL-009 A ticket links user, order, item, payment and return; PII is masked
 *         by role.
 * FUL-010 FAQ / self-service with a clear escalation — "бот не блокирует live
 *         support", so every self-service answer offers a human.
 * CNT-001/002 CMS content with scheduling and locale preview.
 * ADM-009 Alerts with severity, owner and status.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type CmsBlockKind, type SupportTicketStatus } from '@prisma/client';
import { type Locale, canSeePii, maskAddress, maskName, maskPhone, pickLocalized } from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { AuditService } from '../common/audit.service';
import type { AuthenticatedActor } from '../common/http';

export interface FaqEntry {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly category: string;
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────────── tickets (FUL-009)

  async createTicket(
    userId: string,
    input: {
      subject: string;
      body: string;
      category?: string;
      orderId?: string | null;
      orderItemId?: string | null;
      returnRequestId?: string | null;
      paymentId?: string | null;
    },
    locale: Locale,
  ) {
    // Linking to someone else's order must not be possible.
    if (input.orderId) {
      const order = await this.prisma.order.findFirst({
        where: { id: input.orderId, userId },
        select: { id: true },
      });
      if (!order) throw AppError.notFound('Order', input.orderId);
    }

    const open = await this.prisma.supportTicket.count({
      where: { userId, status: { in: ['OPEN', 'WAITING_CUSTOMER', 'WAITING_SELLER', 'ESCALATED'] } },
    });
    if (open >= 10) throw AppError.validation('You already have 10 open tickets');

    const count = await this.prisma.supportTicket.count();
    const number = `SUP-${new Date().getUTCFullYear()}-${String(count + 1).padStart(6, '0')}`;

    const ticket = await this.prisma.supportTicket.create({
      data: {
        number,
        userId,
        orderId: input.orderId ?? null,
        orderItemId: input.orderItemId ?? null,
        returnRequestId: input.returnRequestId ?? null,
        paymentId: input.paymentId ?? null,
        subject: input.subject.slice(0, 200),
        category: input.category ?? 'OTHER',
        locale,
        messages: {
          create: { authorType: 'USER', authorId: userId, body: input.body.slice(0, 4000) },
        },
      },
      include: { messages: true },
    });

    return {
      id: ticket.id,
      number: ticket.number,
      status: ticket.status,
      createdAt: ticket.createdAt.toISOString(),
    };
  }

  async listTickets(userId: string) {
    const rows = await this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1, where: { isInternal: false } },
        order: { select: { number: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      subject: row.subject,
      status: row.status,
      category: row.category,
      orderNumber: row.order?.number ?? null,
      lastMessage: row.messages[0]?.body?.slice(0, 160) ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getTicket(userId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { OR: [{ id: ticketId }, { number: ticketId }], userId },
      include: {
        messages: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } },
        order: { select: { id: true, number: true, status: true } },
      },
    });
    if (!ticket) throw AppError.notFound('SupportTicket', ticketId);
    return {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      category: ticket.category,
      order: ticket.order,
      createdAt: ticket.createdAt.toISOString(),
      messages: ticket.messages.map((message) => ({
        id: message.id,
        author: message.authorType,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  async replyAsUser(userId: string, ticketId: string, body: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
      select: { id: true, status: true },
    });
    if (!ticket) throw AppError.notFound('SupportTicket', ticketId);
    if (ticket.status === 'CLOSED') {
      throw AppError.conflict('CONFLICT', 'This ticket is closed — open a new one');
    }

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: { ticketId, authorType: 'USER', authorId: userId, body: body.slice(0, 4000) },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: { status: 'OPEN' },
      }),
    ]);
    return { ok: true };
  }

  /** FUL-009: the agent view, with PII masked unless the role may see it. */
  async adminListTickets(
    actor: AuthenticatedActor,
    options: { status?: SupportTicketStatus[]; limit?: number; offset?: number; search?: string },
  ) {
    const where: Prisma.SupportTicketWhereInput = {
      ...(options.status ? { status: { in: options.status } } : {}),
      ...(options.search
        ? {
            OR: [
              { number: { contains: options.search, mode: 'insensitive' } },
              { subject: { contains: options.search, mode: 'insensitive' } },
              { order: { number: { contains: options.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const showPii = canSeePii(actor.roles as never);
    const [total, rows] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: Math.min(options.limit ?? 25, 100),
        skip: options.offset ?? 0,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true } },
          order: { select: { id: true, number: true, status: true } },
          _count: { select: { messages: true } },
        },
      }),
    ]);

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        number: row.number,
        subject: row.subject,
        status: row.status,
        category: row.category,
        priority: row.priority,
        customer: {
          id: row.user.id,
          // ADM-007: masked by default; an unmasked read is a separate action.
          name: showPii
            ? [row.user.firstName, row.user.lastName].filter(Boolean).join(' ')
            : maskName([row.user.firstName, row.user.lastName].filter(Boolean).join(' ')),
          phone: showPii ? row.user.phone : maskPhone(row.user.phone),
        },
        order: row.order,
        messageCount: row._count.messages,
        assignedAdminId: row.assignedAdminId,
        createdAt: row.createdAt.toISOString(),
        firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
      })),
    };
  }

  async adminGetTicket(actor: AuthenticatedActor, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { OR: [{ id: ticketId }, { number: ticketId }] },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            locale: true,
            addresses: { where: { deletedAt: null }, take: 3 },
          },
        },
        order: {
          select: {
            id: true,
            number: true,
            status: true,
            grandTotalMinor: true,
            currency: true,
            addressSnapshot: true,
          },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) throw AppError.notFound('SupportTicket', ticketId);

    const showPii = canSeePii(actor.roles as never);
    if (showPii) {
      // ADM-007: access to the full phone/address is journalled.
      await this.audit.recordPiiAccess(actor, 'SupportTicket', ticket.id, ['phone', 'address']);
    }

    return {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      category: ticket.category,
      priority: ticket.priority,
      customer: {
        id: ticket.user.id,
        name: showPii
          ? [ticket.user.firstName, ticket.user.lastName].filter(Boolean).join(' ')
          : maskName([ticket.user.firstName, ticket.user.lastName].filter(Boolean).join(' ')),
        phone: showPii ? ticket.user.phone : maskPhone(ticket.user.phone),
        locale: ticket.user.locale,
        addresses: ticket.user.addresses.map((address) => ({
          id: address.id,
          city: address.city,
          street: showPii ? address.street : maskAddress(address.street),
          building: showPii ? address.building : maskAddress(address.building),
        })),
      },
      order: ticket.order,
      messages: ticket.messages.map((message) => ({
        id: message.id,
        author: message.authorType,
        authorId: message.authorId,
        body: message.body,
        isInternal: message.isInternal,
        createdAt: message.createdAt.toISOString(),
      })),
      createdAt: ticket.createdAt.toISOString(),
    };
  }

  async adminReply(
    actor: AuthenticatedActor,
    ticketId: string,
    input: { body: string; isInternal?: boolean; status?: SupportTicketStatus },
  ) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, firstResponseAt: true },
    });
    if (!ticket) throw AppError.notFound('SupportTicket', ticketId);

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          ticketId,
          authorType: 'AGENT',
          authorId: actor.adminUserId ?? null,
          body: input.body.slice(0, 4000),
          isInternal: input.isInternal ?? false,
        },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: input.status ?? 'WAITING_CUSTOMER',
          assignedAdminId: actor.adminUserId ?? undefined,
          firstResponseAt:
            ticket.firstResponseAt ?? (input.isInternal ? undefined : new Date()),
          resolvedAt: input.status === 'RESOLVED' ? new Date() : undefined,
        },
      }),
    ]);

    await this.audit.record(actor, {
      action: 'support.reply',
      objectType: 'SupportTicket',
      objectId: ticketId,
      after: { internal: input.isInternal ?? false, status: input.status },
    });
    return { ok: true };
  }

  /** FUL-010: self-service answers that always offer a human next. */
  faq(locale: Locale): { entries: FaqEntry[]; escalation: string } {
    const entries = FAQ_ENTRIES.map((entry) => ({
      id: entry.id,
      category: entry.category,
      question: pickLocalized(entry.question, locale),
      answer: pickLocalized(entry.answer, locale),
    }));
    return { entries, escalation: pickLocalized(ESCALATION_COPY, locale) };
  }

  // ───────────────────────────────────────────────── CMS (CNT-001/002)

  async listCmsBlocks() {
    return this.prisma.cmsBlock.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async upsertCmsBlock(
    input: {
      id?: string;
      key: string;
      kind: CmsBlockKind;
      titleRu?: string | null;
      titleUz?: string | null;
      titleEn?: string | null;
      subtitleRu?: string | null;
      subtitleUz?: string | null;
      ctaLabelRu?: string | null;
      ctaLabelUz?: string | null;
      ctaHref?: string | null;
      imageUrl?: string | null;
      config?: Record<string, unknown>;
      sortOrder?: number;
      isActive?: boolean;
      startsAt?: Date | null;
      endsAt?: Date | null;
      locales?: string[];
    },
    actor: AuthenticatedActor,
  ) {
    // ADM-011: a block cannot go live in a locale it has no title for.
    const locales = input.locales ?? ['ru', 'uz'];
    if (input.isActive) {
      if (locales.includes('ru') && !input.titleRu?.trim() && input.kind !== 'BANNER') {
        throw AppError.validation('A Russian title is required to publish this block');
      }
      if (locales.includes('uz') && !input.titleUz?.trim() && input.kind !== 'BANNER') {
        throw AppError.validation('An Uzbek title is required to publish this block');
      }
    }

    const data = {
      kind: input.kind,
      titleRu: input.titleRu ?? null,
      titleUz: input.titleUz ?? null,
      titleEn: input.titleEn ?? null,
      subtitleRu: input.subtitleRu ?? null,
      subtitleUz: input.subtitleUz ?? null,
      ctaLabelRu: input.ctaLabelRu ?? null,
      ctaLabelUz: input.ctaLabelUz ?? null,
      ctaHref: input.ctaHref ?? null,
      imageUrl: input.imageUrl ?? null,
      config: (input.config ?? {}) as Prisma.InputJsonValue,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? false,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      locales,
      createdByAdminId: actor.adminUserId ?? null,
    };

    const block = await this.prisma.cmsBlock.upsert({
      where: { key: input.key },
      create: { key: input.key, ...data },
      update: data,
    });

    await this.audit.record(actor, {
      action: 'cms.upsert',
      objectType: 'CmsBlock',
      objectId: block.id,
      after: { key: block.key, kind: block.kind, isActive: block.isActive },
    });
    return block;
  }

  async deleteCmsBlock(key: string, actor: AuthenticatedActor) {
    const block = await this.prisma.cmsBlock.findUnique({ where: { key } });
    if (!block) throw AppError.notFound('CmsBlock', key);
    await this.prisma.cmsBlock.delete({ where: { key } });
    await this.audit.record(actor, {
      action: 'cms.delete',
      objectType: 'CmsBlock',
      objectId: block.id,
      before: { key },
    });
    return { deleted: true };
  }

  /** CNT-002: preview a block as it will look in a locale at a given time. */
  async previewCms(locale: Locale, at: Date = new Date()) {
    const blocks = await this.prisma.cmsBlock.findMany({
      where: {
        locales: { has: locale },
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: at } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: at } }] },
        ],
      },
      orderBy: { sortOrder: 'asc' },
    });
    return blocks.map((block) => ({
      key: block.key,
      kind: block.kind,
      isActive: block.isActive,
      title: pickLocalized({ ru: block.titleRu, uz: block.titleUz, en: block.titleEn }, locale),
      subtitle: pickLocalized({ ru: block.subtitleRu, uz: block.subtitleUz }, locale),
      scheduled: block.startsAt != null || block.endsAt != null,
      startsAt: block.startsAt?.toISOString() ?? null,
      endsAt: block.endsAt?.toISOString() ?? null,
    }));
  }

  async upsertContentPage(
    input: { slug: string; locale: Locale; title: string; body: string; kind?: string; publish?: boolean },
    actor: AuthenticatedActor,
  ) {
    const page = await this.prisma.contentPage.upsert({
      where: { slug_locale: { slug: input.slug, locale: input.locale } },
      create: {
        slug: input.slug,
        locale: input.locale,
        title: input.title,
        body: input.body,
        kind: input.kind ?? 'PAGE',
        isPublished: input.publish ?? false,
        publishedAt: input.publish ? new Date() : null,
      },
      update: {
        title: input.title,
        body: input.body,
        kind: input.kind ?? undefined,
        isPublished: input.publish ?? undefined,
        publishedAt: input.publish ? new Date() : undefined,
      },
    });
    await this.audit.record(actor, {
      action: 'cms.page_upsert',
      objectType: 'ContentPage',
      objectId: page.id,
      after: { slug: page.slug, locale: page.locale, published: page.isPublished },
    });
    return page;
  }

  async listContentPages() {
    return this.prisma.contentPage.findMany({ orderBy: [{ slug: 'asc' }, { locale: 'asc' }] });
  }

  // ─────────────────────────────────────────────── alerts (ADM-009)

  async listAlerts(options: { status?: string; severity?: string; limit?: number }) {
    return this.prisma.alert.findMany({
      where: {
        status: options.status ?? 'OPEN',
        ...(options.severity ? { severity: options.severity } : {}),
      },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(options.limit ?? 50, 200),
    });
  }

  async acknowledgeAlert(alertId: string, actor: AuthenticatedActor) {
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) throw AppError.notFound('Alert', alertId);
    await this.prisma.alert.update({
      where: { id: alertId },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        ownerAdminId: actor.adminUserId ?? null,
      },
    });
    return { ok: true };
  }

  async resolveAlert(alertId: string, resolution: string, actor: AuthenticatedActor) {
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) throw AppError.notFound('Alert', alertId);
    await this.prisma.alert.update({
      where: { id: alertId },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: resolution.slice(0, 1000) },
    });
    await this.audit.record(actor, {
      action: 'alert.resolve',
      objectType: 'Alert',
      objectId: alertId,
      after: { resolution },
    });
    return { ok: true };
  }

  async raiseAlert(input: {
    code: string;
    severity?: 'INFO' | 'WARNING' | 'CRITICAL';
    title: string;
    description?: string;
    objectType?: string;
    objectId?: string;
    context?: Record<string, unknown>;
  }) {
    // One open alert per (code, object): a repeating condition should not
    // produce a thousand rows.
    const existing = await this.prisma.alert.findFirst({
      where: {
        code: input.code,
        objectId: input.objectId ?? null,
        status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };

    const alert = await this.prisma.alert.create({
      data: {
        code: input.code,
        severity: input.severity ?? 'WARNING',
        title: input.title,
        description: input.description ?? null,
        objectType: input.objectType ?? null,
        objectId: input.objectId ?? null,
        context: (input.context ?? {}) as Prisma.InputJsonValue,
      },
    });
    return { id: alert.id, created: true };
  }

  // ──────────────────────────────────── privacy requests (USR-006/§15.2)

  async listPrivacyRequests(options: { status?: string; limit?: number }) {
    return this.prisma.privacyRequest.findMany({
      where: options.status ? { status: options.status as never } : undefined,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(options.limit ?? 50, 200),
      include: { user: { select: { id: true, firstName: true, locale: true } } },
    });
  }

  async processPrivacyRequest(
    requestId: string,
    input: { status: 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED'; resolution?: string },
    actor: AuthenticatedActor,
  ) {
    const request = await this.prisma.privacyRequest.findUnique({ where: { id: requestId } });
    if (!request) throw AppError.notFound('PrivacyRequest', requestId);

    await this.prisma.privacyRequest.update({
      where: { id: requestId },
      data: {
        status: input.status,
        resolution: input.resolution ?? null,
        handledByAdminId: actor.adminUserId ?? null,
        completedAt: input.status === 'COMPLETED' ? new Date() : null,
      },
    });

    await this.audit.record(actor, {
      action: 'privacy.process',
      objectType: 'PrivacyRequest',
      objectId: requestId,
      after: { status: input.status, resolution: input.resolution },
      severity: 'CRITICAL',
    });
    return { ok: true };
  }

  // ───────────────────────────── feature flags & settings (ADM-010)

  async listFeatureFlags() {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async setFeatureFlag(
    input: { key: string; enabled: boolean; rolloutPercent?: number; description?: string; allowUserIds?: string[] },
    actor: AuthenticatedActor,
  ) {
    const flag = await this.prisma.featureFlag.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        enabled: input.enabled,
        rolloutPercent: input.rolloutPercent ?? 100,
        description: input.description ?? null,
        allowUserIds: input.allowUserIds ?? [],
        updatedByAdminId: actor.adminUserId ?? null,
      },
      update: {
        enabled: input.enabled,
        rolloutPercent: input.rolloutPercent ?? undefined,
        description: input.description ?? undefined,
        allowUserIds: input.allowUserIds ?? undefined,
        updatedByAdminId: actor.adminUserId ?? null,
      },
    });
    await this.audit.record(actor, {
      action: 'featureflag.set',
      objectType: 'FeatureFlag',
      objectId: flag.id,
      after: { key: flag.key, enabled: flag.enabled, rollout: flag.rolloutPercent },
      severity: 'NOTICE',
    });
    return flag;
  }

  /** NFR-015: deterministic bucketing, so a user's experience is stable. */
  async isFeatureEnabled(key: string, userId?: string | null): Promise<boolean> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!flag || !flag.enabled) return false;
    if (userId && flag.allowUserIds.includes(userId)) return true;
    if (flag.rolloutPercent >= 100) return true;
    if (flag.rolloutPercent <= 0) return false;
    if (!userId) return false;
    const bucket = [...userId].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 100, 7);
    return bucket < flag.rolloutPercent;
  }

  async listSettings() {
    return this.prisma.platformSetting.findMany({ orderBy: { key: 'asc' } });
  }

  async setSetting(key: string, value: unknown, actor: AuthenticatedActor, description?: string) {
    const before = await this.prisma.platformSetting.findUnique({ where: { key } });
    const setting = await this.prisma.platformSetting.upsert({
      where: { key },
      create: {
        key,
        value: value as Prisma.InputJsonValue,
        description: description ?? null,
        updatedByAdminId: actor.adminUserId ?? null,
      },
      update: {
        value: value as Prisma.InputJsonValue,
        description: description ?? undefined,
        updatedByAdminId: actor.adminUserId ?? null,
      },
    });
    await this.audit.record(actor, {
      action: 'setting.set',
      objectType: 'PlatformSetting',
      objectId: key,
      before: before?.value,
      after: value,
      severity: 'WARNING',
    });
    return setting;
  }

  // ───────────────────────────────────────────────── audit (ADM-006)

  async auditLog(options: {
    objectType?: string;
    objectId?: string;
    actorId?: string;
    action?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: Prisma.AuditLogWhereInput = {
      ...(options.objectType ? { objectType: options.objectType } : {}),
      ...(options.objectId ? { objectId: options.objectId } : {}),
      ...(options.actorId ? { actorId: options.actorId } : {}),
      ...(options.action ? { action: { contains: options.action } } : {}),
      ...(options.from || options.to
        ? {
            createdAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            },
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { sequence: 'desc' },
        take: Math.min(options.limit ?? 50, 200),
        skip: options.offset ?? 0,
      }),
    ]);
    return { total, rows };
  }

  /** ADM-005: the maker/checker queue. */
  async pendingApprovals(adminUserId?: string) {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      objectType: row.objectType,
      objectId: row.objectId,
      payload: row.payload,
      makerEmail: row.makerEmail,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      // The UI greys out rows the viewer is not allowed to approve.
      canApprove: adminUserId ? row.makerAdminId !== adminUserId : false,
    }));
  }
}

const ESCALATION_COPY = {
  ru: 'Не нашли ответ? Напишите нам — отвечает живой человек, обычно в течение рабочего дня.',
  uz: 'Javob topilmadimi? Bizga yozing — jonli odam javob beradi, odatda ish kuni ichida.',
  en: 'Did not find your answer? Message us — a real person replies, usually within a working day.',
};

const FAQ_ENTRIES: Array<{
  id: string;
  category: string;
  question: Record<'ru' | 'uz' | 'en', string>;
  answer: Record<'ru' | 'uz' | 'en', string>;
}> = [
  {
    id: 'delivery-time',
    category: 'delivery',
    question: {
      ru: 'Сколько идёт доставка?',
      uz: 'Yetkazib berish qancha vaqt oladi?',
      en: 'How long does delivery take?',
    },
    answer: {
      ru: 'Срок = время сборки у продавца + доставка курьером по вашей зоне. Точный диапазон виден на карточке товара и при оформлении — мы показываем диапазон, а не одну дату.',
      uz: 'Muddat = sotuvchining yig‘ish vaqti + kuryer yetkazishi. Aniq oraliq mahsulot kartasida va buyurtma berishda ko‘rinadi — biz bitta sana emas, oraliq ko‘rsatamiz.',
      en: 'The window is the seller handling time plus courier time for your zone. The exact range is on the product page and at checkout — we show a range, not a single date.',
    },
  },
  {
    id: 'multi-seller',
    category: 'orders',
    question: {
      ru: 'Почему заказ пришёл в нескольких посылках?',
      uz: 'Nega buyurtma bir necha paketda keldi?',
      en: 'Why did my order arrive in several parcels?',
    },
    answer: {
      ru: 'В корзине могут быть вещи разных брендов. Оплата одна, но каждый продавец собирает и отправляет свою часть — в заказе видно, какие позиции в какой посылке.',
      uz: 'Savatda turli brendlar bo‘lishi mumkin. To‘lov bitta, lekin har bir sotuvchi o‘z qismini yig‘ib yuboradi — buyurtmada qaysi buyum qaysi paketda ekani ko‘rinadi.',
      en: 'One cart can hold several brands. You pay once, but each seller packs and ships their own part — the order shows which items are in which parcel.',
    },
  },
  {
    id: 'size-recommendation',
    category: 'fit',
    question: {
      ru: 'Насколько точна рекомендация размера?',
      uz: 'O‘lcham tavsiyasi qanchalik aniq?',
      en: 'How accurate is the size recommendation?',
    },
    answer: {
      ru: 'Это рекомендация, а не гарантия. Она строится на размерной сетке бренда, замерах модели и — если вы их указали — ваших мерках. Если данных мало, мы честно показываем сетку и не выдаём размер за уверенный.',
      uz: 'Bu tavsiya, kafolat emas. U brend o‘lcham jadvali, model o‘lchamlari va — agar kiritgan bo‘lsangiz — sizning parametrlaringizga asoslanadi. Ma’lumot kam bo‘lsa, jadvalni ko‘rsatamiz va o‘lchamni ishonchli deb bermaymiz.',
      en: 'It is a recommendation, not a guarantee. It uses the brand chart, the garment measurements and, if you shared them, your own. With too little data we show the chart and do not present a size as confident.',
    },
  },
  {
    id: 'return-window',
    category: 'returns',
    question: {
      ru: 'Как вернуть вещь?',
      uz: 'Buyumni qanday qaytarish mumkin?',
      en: 'How do I return an item?',
    },
    answer: {
      ru: 'В заказе выберите «Возврат», отметьте позиции и причину. Условия и срок видны до оплаты и сохраняются в заказе. После проверки продавцом деньги возвращаются тем же способом, которым вы платили.',
      uz: 'Buyurtmada «Qaytarish»ni tanlang, buyumlar va sababni belgilang. Shartlar va muddat to‘lovdan oldin ko‘rinadi va buyurtmada saqlanadi. Sotuvchi tekshirgandan so‘ng pul siz to‘lagan usulda qaytariladi.',
      en: 'Open the order, choose Return, pick the items and a reason. The terms and window are shown before payment and stored with the order. After the seller inspects it, the money goes back the way you paid.',
    },
  },
  {
    id: 'ai-stylist',
    category: 'ai',
    question: {
      ru: 'Откуда AI берёт вещи для образа?',
      uz: 'AI uslub uchun buyumlarni qayerdan oladi?',
      en: 'Where does the AI get the items for a look?',
    },
    answer: {
      ru: 'Только из реального каталога: опубликованные товары с ценой и в наличии. AI не придумывает вещи и не предлагает то, что закончилось. Перед добавлением в корзину наличие и размер проверяются ещё раз.',
      uz: 'Faqat haqiqiy katalogdan: narxi bor va mavjud nashr etilgan mahsulotlar. AI buyum o‘ylab chiqarmaydi va tugagan narsani taklif qilmaydi. Savatga qo‘shishdan oldin mavjudlik va o‘lcham yana tekshiriladi.',
      en: 'Only from the real catalogue: published items that have a price and are in stock. It never invents a garment or offers a sold-out one, and availability and size are re-checked before anything enters your cart.',
    },
  },
  {
    id: 'payments',
    category: 'payments',
    question: {
      ru: 'Какие способы оплаты доступны?',
      uz: 'Qanday to‘lov usullari mavjud?',
      en: 'Which payment methods are available?',
    },
    answer: {
      ru: 'Платёжные провайдеры подключаются поэтапно. В текущей версии оплата работает в тестовом режиме: карта не списывается, но заказ, доставка и возврат проходят полностью. Мы не храним данные карты.',
      uz: 'To‘lov provayderlari bosqichma-bosqich ulanadi. Hozirgi versiyada to‘lov sinov rejimida ishlaydi: kartadan pul olinmaydi, lekin buyurtma, yetkazish va qaytarish to‘liq o‘tadi. Biz karta ma’lumotlarini saqlamaymiz.',
      en: 'Payment providers are being connected in stages. In this version payment runs in sandbox mode: no card is charged, but ordering, delivery and returns work end to end. We never store card data.',
    },
  },
  {
    id: 'privacy',
    category: 'privacy',
    question: {
      ru: 'Можно ли удалить мои данные?',
      uz: 'Ma’lumotlarimni o‘chirish mumkinmi?',
      en: 'Can I delete my data?',
    },
    answer: {
      ru: 'Да. В разделе «Приватность» можно выключить персонализацию, удалить профиль фигуры, скачать копию данных или удалить аккаунт. Заказы и бухгалтерские записи сохраняются по закону, остальное удаляется.',
      uz: 'Ha. «Maxfiylik» bo‘limida personalizatsiyani o‘chirish, tana profilini o‘chirish, ma’lumot nusxasini yuklab olish yoki akkauntni o‘chirish mumkin. Buyurtmalar va hisob yozuvlari qonun bo‘yicha saqlanadi, qolgani o‘chiriladi.',
      en: 'Yes. In Privacy you can switch off personalisation, delete your fit profile, download a copy of your data or delete your account. Orders and accounting records are kept as the law requires; everything else is removed.',
    },
  },
];
