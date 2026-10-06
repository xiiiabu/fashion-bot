'use client';

/** One support thread — spec §10.1. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { support as supportApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { dateTime } from '@/lib/format';
import { BottomBar, BottomBarSpacer, ScreenHeader, useBackButton } from '@/components/shell';
import { Badge, Button, ErrorState, LoadingScreen, Textarea, cx } from '@/components/ui';
import { haptic } from '@/lib/telegram';

export default function TicketPage() {
  const params = useParams<{ id: string }>();
  const { locale, toast } = useApp();
  const t = useT();
  useBackButton('/support');

  const [ticket, setTicket] = useState<{
    id: string;
    number: string;
    subject: string;
    status: string;
    messages: Array<{ id: string; body: string; authorRole: string; createdAt: string }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTicket(await supportApi.ticket(params.id));
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [params.id, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [ticket?.messages.length]);

  const send = useCallback(async () => {
    if (reply.trim().length < 2) return;
    setSending(true);
    try {
      await supportApi.reply(params.id, reply.trim());
      setReply('');
      haptic.success();
      await load();
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setSending(false);
    }
  }, [reply, params.id, load, toast, locale]);

  if (error) {
    return (
      <div>
        <ScreenHeader back="/support" title={t('support.title')} />
        <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div>
        <ScreenHeader back="/support" title={t('support.title')} />
        <LoadingScreen />
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader
        back="/support"
        title={ticket.subject}
        eyebrow={ticket.number}
        action={<Badge tone="neutral">{ticket.status}</Badge>}
      />

      <div className="space-y-3 px-4 py-4">
        {ticket.messages.map((message) => {
          const mine = message.authorRole === 'CUSTOMER' || message.authorRole === 'BUYER';
          return (
            <div key={message.id} className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
              <div
                className={cx(
                  'max-w-[82%] rounded-[var(--radius-lg)] px-3.5 py-2.5',
                  mine
                    ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                    : 'bg-[var(--bg-raised)] text-[var(--fg)]',
                )}
              >
                <p className="whitespace-pre-line text-[14px] leading-relaxed">{message.body}</p>
                <p className={cx('mt-1 text-[10.5px]', mine ? 'opacity-70' : 'text-[var(--fg-faint)]')}>
                  {dateTime(message.createdAt, locale)}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <BottomBarSpacer height={108} />

      <BottomBar>
        <div className="flex items-end gap-2.5">
          <Textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            placeholder={t('support.message')}
            rows={2}
            maxLength={4000}
          />
          <Button loading={sending} disabled={reply.trim().length < 2} onClick={send} className="shrink-0">
            {t('support.send')}
          </Button>
        </div>
      </BottomBar>
    </div>
  );
}
