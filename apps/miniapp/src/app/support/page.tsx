'use client';

/**
 * Support — spec §10. Tickets live in the Mini App so a shopper can see the
 * thread next to the order it is about; the bot is offered as the faster route
 * because that is where the notification arrives (§10.2).
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { support as supportApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { dateTime } from '@/lib/format';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Badge,
  Button,
  ChatIcon,
  EmptyState,
  ErrorState,
  Field,
  HelpIcon,
  Input,
  Row,
  RowGroup,
  Section,
  Sheet,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { haptic, openExternal } from '@/lib/telegram';

export default function SupportPage() {
  const router = useRouter();
  const { locale, config, toast } = useApp();
  const t = useT();
  useBackButton('/profile');

  const [tickets, setTickets] = useState<
    Array<{ id: string; number: string; subject: string; status: string; updatedAt: string; unread: number }> | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await supportApi.tickets();
      setTickets(data.items);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async () => {
    if (subject.trim().length < 3 || body.trim().length < 5) {
      haptic.warning();
      return;
    }
    setSending(true);
    try {
      await supportApi.createTicket({ subject: subject.trim(), body: body.trim() });
      setComposing(false);
      setSubject('');
      setBody('');
      haptic.success();
      toast(t('support.sent'), 'success');
      await load();
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setSending(false);
    }
  }, [subject, body, load, toast, t, locale]);

  return (
    <div className="pb-8">
      <ScreenHeader back="/profile" title={t('support.title')} />

      <Section>
        <RowGroup>
          <Row icon={<HelpIcon size={17} />} title={t('profile.faq')} onClick={() => router.push('/support/faq')} />
          {config?.botUsername && (
            <Row
              icon={<ChatIcon size={17} />}
              title={t('support.openInBot')}
              hint={`@${config.botUsername}`}
              onClick={() => openExternal(`https://t.me/${config.botUsername}`)}
            />
          )}
        </RowGroup>
      </Section>

      {error && <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />}

      {!tickets && !error && (
        <div className="space-y-3 px-4">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-[64px] w-full rounded-[var(--radius-lg)]" />
          ))}
        </div>
      )}

      {tickets && tickets.length === 0 && (
        <EmptyState
          icon={<ChatIcon size={30} />}
          title={t('support.noTickets')}
          action={<Button onClick={() => setComposing(true)}>{t('support.newTicket')}</Button>}
        />
      )}

      {tickets && tickets.length > 0 && (
        <>
          <Section title={t('privacy.requests')}>
            <RowGroup>
              {tickets.map((ticket) => (
                <Row
                  key={ticket.id}
                  title={ticket.subject}
                  hint={`${ticket.number} · ${dateTime(ticket.updatedAt, locale)}`}
                  trailing={
                    ticket.unread > 0 ? (
                      <Badge tone="accent">{ticket.unread}</Badge>
                    ) : (
                      <Badge tone="neutral">{ticket.status}</Badge>
                    )
                  }
                  onClick={() => router.push(`/support/${ticket.id}`)}
                />
              ))}
            </RowGroup>
          </Section>
          <div className="px-4">
            <Button variant="outline" block onClick={() => setComposing(true)}>
              {t('support.newTicket')}
            </Button>
          </div>
        </>
      )}

      <Sheet open={composing} onClose={() => setComposing(false)} title={t('support.newTicket')} height="tall">
        <div className="space-y-3.5 pb-2">
          <Field label={t('support.subject')} required>
            <Input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={160} />
          </Field>
          <Field label={t('support.message')} required>
            <Textarea value={body} onChange={(event) => setBody(event.target.value)} rows={6} maxLength={4000} />
          </Field>
          <Button block loading={sending} onClick={send}>
            {t('support.send')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
