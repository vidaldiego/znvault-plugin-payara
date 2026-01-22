// Path: src/utils/ttl-cache.ts
// Generic TTL (time-to-live) cache utility

import type { Logger } from 'pino';

/**
 * Cached entry with timestamp
 */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

/**
 * Options for TTL cache
 */
export interface TtlCacheOptions {
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Optional logger for debug messages */
  logger?: Logger;
  /** Cache name for logging */
  name?: string;
}

/**
 * Generic TTL cache for storing values with automatic expiration.
 *
 * Useful for caching expensive operations like status checks
 * to reduce repeated shell calls during frequent polling.
 *
 * @example
 * ```typescript
 * const cache = new TtlCache<PayaraStatus>({ ttlMs: 5000, name: 'status' });
 *
 * // Check cache or fetch fresh
 * const cached = cache.get();
 * if (cached) {
 *   return cached;
 * }
 *
 * const fresh = await fetchStatus();
 * cache.set(fresh);
 * return fresh;
 * ```
 */
export class TtlCache<T> {
  private entry: CacheEntry<T> | null = null;
  private readonly ttlMs: number;
  private readonly logger?: Logger;
  private readonly name: string;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.logger = options.logger;
    this.name = options.name ?? 'cache';
  }

  /**
   * Get cached value if not expired.
   *
   * @param forceRefresh - If true, always returns null (forces refresh)
   * @returns Cached value or null if expired/missing
   */
  get(forceRefresh = false): T | null {
    if (forceRefresh || !this.entry) {
      return null;
    }

    const age = Date.now() - this.entry.timestamp;
    if (age >= this.ttlMs) {
      return null;
    }

    this.logger?.debug({ cacheAge: age, ttl: this.ttlMs, name: this.name }, 'Returning cached value');
    return this.entry.value;
  }

  /**
   * Store a value in cache with current timestamp.
   *
   * @param value - Value to cache
   */
  set(value: T): void {
    this.entry = { value, timestamp: Date.now() };
  }

  /**
   * Invalidate the cache (clear stored value).
   */
  invalidate(): void {
    this.entry = null;
    this.logger?.debug({ name: this.name }, 'Cache invalidated');
  }

  /**
   * Check if cache has a valid (non-expired) entry.
   *
   * @returns True if cache has valid entry
   */
  hasValid(): boolean {
    return this.get() !== null;
  }

  /**
   * Get cache age in milliseconds, or null if no entry.
   *
   * @returns Age in ms or null
   */
  getAge(): number | null {
    if (!this.entry) {
      return null;
    }
    return Date.now() - this.entry.timestamp;
  }

  /**
   * Get or fetch: returns cached value or calls fetcher function.
   *
   * @param fetcher - Async function to fetch fresh value
   * @param forceRefresh - If true, always fetches fresh
   * @returns Cached or fresh value
   */
  async getOrFetch(fetcher: () => Promise<T>, forceRefresh = false): Promise<T> {
    const cached = this.get(forceRefresh);
    if (cached !== null) {
      return cached;
    }

    const fresh = await fetcher();
    this.set(fresh);
    return fresh;
  }
}
