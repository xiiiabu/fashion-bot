/**
 * Structured logging for the bot — spec NFR-007.
 *
 * pino, same as the API, so the two produce one log stream a single tool can
 * read. The redaction list matters more here than elsewhere: a bot update
 * carries the shopper's name, username and chat id, and a token in a log line
 * is a token in whatever ships those logs.
 */

import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  base: { service: 'bot' },
  redact: {
    paths: [
      'token',
      '*.token',
      'config.token',
      'botToken',
      '*.botToken',
      'signature',
      '*.signature',
      'phone',
      '*.phone',
      'from.username',
      '*.from.username',
      'headers.authorization',
      'headers["x-bot-signature"]',
    ],
    censor: '[redacted]',
  },
  transport: isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
