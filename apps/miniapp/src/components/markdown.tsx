'use client';

/**
 * A deliberately small Markdown renderer for the legal documents (§12.1).
 *
 * Written rather than installed, for one reason: these documents are the terms,
 * the privacy policy and the public offer. A general Markdown library accepts
 * raw HTML by default, which would make a CMS field an XSS vector, and the
 * sanitiser that fixes that is a second dependency with its own CVE history.
 * This handles exactly the subset the CMS produces — headings, paragraphs,
 * bold, italic, links, lists, rules — and renders everything else as text.
 *
 * Nothing here interprets HTML: the output is React elements built from parsed
 * tokens, so a `<script>` in the source renders as the literal characters.
 */

import { Fragment, type ReactNode } from 'react';
import { openExternal } from '@/lib/telegram';

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' };

function parse(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list && list.items.length > 0) blocks.push({ kind: 'list', ...list });
    list = null;
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      blocks.push({ kind: 'quote', text: quote.join(' ').trim() });
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushAll();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      continue;
    }

    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(numbered);
      const text = (bullet ?? numbered)![1].trim();
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(text);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushAll();
  return blocks;
}

/** Bold, italic, inline code and links. Everything else stays literal text. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // One pass, longest-token-first, so `**bold**` is not eaten by `*italic*`.
  const pattern =
    /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`/g;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    index += 1;
    const key = `${keyPrefix}-${index}`;

    if (match[1] !== undefined) {
      const href = match[2];
      // Only http(s), mailto and tel are followed. Anything else — javascript:,
      // data: — renders as the link text alone, since a legal document has no
      // business carrying a scheme we do not recognise.
      const safe = /^(https?:|mailto:|tel:)/i.test(href);
      nodes.push(
        safe ? (
          <a
            key={key}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              openExternal(href);
            }}
            className="font-medium text-[var(--accent)] underline underline-offset-2"
          >
            {match[1]}
          </a>
        ) : (
          <Fragment key={key}>{match[1]}</Fragment>
        ),
      );
    } else if (match[3] !== undefined || match[4] !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {match[3] ?? match[4]}
        </strong>,
      );
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(<em key={key}>{match[5] ?? match[6]}</em>);
    } else if (match[7] !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-[var(--bg-sunken)] px-1 py-0.5 text-[0.92em]">
          {match[7]}
        </code>,
      );
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  const blocks = parse(source);

  return (
    <div className="space-y-3.5">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'heading': {
            if (block.level === 1) {
              return (
                <h2 key={key} className="t-section pt-3 first:pt-0">
                  {inline(block.text, key)}
                </h2>
              );
            }
            if (block.level === 2) {
              return (
                <h3 key={key} className="pt-2.5 text-[15.5px] font-semibold leading-snug">
                  {inline(block.text, key)}
                </h3>
              );
            }
            return (
              <h4 key={key} className="t-eyebrow pt-2">
                {inline(block.text, key)}
              </h4>
            );
          }
          case 'paragraph':
            return (
              <p key={key} className="text-[14px] leading-relaxed text-[var(--fg-soft)]">
                {inline(block.text, key)}
              </p>
            );
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag
                key={key}
                className={
                  block.ordered
                    ? 'ml-5 list-decimal space-y-1.5 text-[14px] leading-relaxed text-[var(--fg-soft)]'
                    : 'ml-5 list-disc space-y-1.5 text-[14px] leading-relaxed text-[var(--fg-soft)]'
                }
              >
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote
                key={key}
                className="border-l-2 border-[var(--accent)] pl-3.5 text-[13.5px] italic leading-relaxed text-[var(--fg-muted)]"
              >
                {inline(block.text, key)}
              </blockquote>
            );
          case 'rule':
            return <hr key={key} className="border-t border-[var(--line)]" />;
          default:
            return null;
        }
      })}
    </div>
  );
}
