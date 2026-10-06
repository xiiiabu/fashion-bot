/**
 * Cache / counter store.
 *
 * Spec §13.1 is explicit that Redis is "не source of truth". Everything that
 * must survive a restart (reservations, idempotency records, ledger) lives in
 * Postgres. Redis only accelerates rate limiting and short-lived caches, so
 * the service degrades to an in-process map when Redis is absent — the API
 * still boots and behaves correctly on a single node.
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { loadConfig } from './config';
import { logger } from './logger';

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly redis: Redis | null;
  private readonly memory = new Map<string, MemoryEntry>();
  private sweeper: NodeJS.Timeout | null = null;
  readonly backend: 'redis' | 'memory';

  constructor() {
    const config = loadConfig();
    const url = config.REDIS_URL?.trim();
    if (url) {
      this.redis = new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      this.redis.on('error', (error) => {
        logger.warn({ err: error.message }, 'redis error; falling back to in-process cache');
      });
      this.backend = 'redis';
    } else {
      this.redis = null;
      this.backend = 'memory';
      logger.warn('REDIS_URL not set — using in-process cache (single node only)');
    }
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  async get(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        return await this.redis.get(key);
      } catch {
        /* fall through to memory */
      }
    }
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
        return;
      } catch {
        /* fall through */
      }
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch {
        /* ignore */
      }
    }
    this.memory.delete(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /**
   * Fixed-window counter used by the rate limiter (SEC-006).
   * Returns the count after the increment and when the window resets.
   */
  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const ttlSeconds = Math.ceil(windowMs / 1000);
    if (this.redis) {
      try {
        const pipeline = this.redis.multi();
        pipeline.incr(key);
        pipeline.pttl(key);
        const results = await pipeline.exec();
        const count = Number(results?.[0]?.[1] ?? 1);
        let ttl = Number(results?.[1]?.[1] ?? -1);
        if (ttl < 0) {
          await this.redis.pexpire(key, windowMs);
          ttl = windowMs;
        }
        return { count, resetAt: Date.now() + ttl };
      } catch {
        /* fall through */
      }
    }
    const now = Date.now();
    const entry = this.memory.get(key);
    if (!entry || entry.expiresAt < now) {
      this.memory.set(key, { value: '1', expiresAt: now + windowMs });
      return { count: 1, resetAt: now + windowMs };
    }
    const count = Number.parseInt(entry.value, 10) + 1;
    entry.value = String(count);
    this.memory.set(key, entry);
    return { count, resetAt: entry.expiresAt };
  }

  /** Best-effort distributed lock. Correctness never depends on it. */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.redis) {
      try {
        const result = await this.redis.set(key, '1', 'EX', Math.max(1, ttlSeconds), 'NX');
        return result === 'OK';
      } catch {
        /* fall through */
      }
    }
    const existing = this.memory.get(key);
    if (existing && existing.expiresAt > Date.now()) return false;
    this.memory.set(key, { value: '1', expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    await this.del(key);
  }

  async ping(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory.entries()) {
      if (entry.expiresAt < now) this.memory.delete(key);
    }
  }
}
