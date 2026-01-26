// Path: src/session-store.ts
// Session store for chunked deployments with LRU eviction

import type { Logger } from 'pino';
import type { ChunkedDeploySession } from './types.js';
import { randomUUID } from 'node:crypto';

/**
 * Configuration for SessionStore
 */
export interface SessionStoreConfig {
  /** Maximum concurrent sessions (default: 10) */
  maxSessions?: number;
  /** Session timeout in milliseconds (default: 30 minutes) */
  timeoutMs?: number;
}

/**
 * Session store for chunked deployments.
 *
 * Features:
 * - Automatic expiration of sessions after timeout
 * - LRU-style eviction when max sessions exceeded
 * - Thread-safe session management
 *
 * @example
 * ```typescript
 * const store = new SessionStore(logger, { maxSessions: 10, timeoutMs: 30 * 60 * 1000 });
 * const session = store.create(['file1.txt'], []);
 * store.addFiles(session.id, [{ path: 'file2.txt', content: '...' }]);
 * const committed = store.get(session.id);
 * store.delete(session.id);
 * ```
 */
export class SessionStore {
  private readonly sessions = new Map<string, ChunkedDeploySession>();
  private readonly logger: Logger;
  private readonly maxSessions: number;
  private readonly timeoutMs: number;

  constructor(logger: Logger, config: SessionStoreConfig = {}) {
    this.logger = logger;
    this.maxSessions = config.maxSessions ?? 10;
    this.timeoutMs = config.timeoutMs ?? 30 * 60 * 1000; // 30 minutes
  }

  /**
   * Get the number of active sessions
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Create a new chunked deployment session
   */
  create(deletions: string[] = [], expectedFiles?: number): ChunkedDeploySession {
    // Clean up before creating new session
    this.cleanup();

    const session: ChunkedDeploySession = {
      id: randomUUID(),
      createdAt: Date.now(),
      files: [],
      deletions,
      expectedFiles,
    };

    this.sessions.set(session.id, session);
    this.logger.info({ sessionId: session.id, expectedFiles }, 'Started chunked deployment session');

    return session;
  }

  /**
   * Get a session by ID
   * Returns undefined if session doesn't exist or is expired
   */
  get(sessionId: string): ChunkedDeploySession | undefined {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return undefined;
    }

    // Check if expired
    if (Date.now() - session.createdAt > this.timeoutMs) {
      this.sessions.delete(sessionId);
      this.logger.debug({ sessionId }, 'Session expired on access');
      return undefined;
    }

    return session;
  }

  /**
   * Check if a session exists and is valid
   */
  has(sessionId: string): boolean {
    return this.get(sessionId) !== undefined;
  }

  /**
   * Add files to an existing session
   * Returns false if session doesn't exist
   */
  addFiles(sessionId: string, files: Array<{ path: string; content: string }>): boolean {
    const session = this.get(sessionId);
    if (!session) {
      return false;
    }

    session.files.push(...files);
    return true;
  }

  /**
   * Delete a session
   * Returns true if session existed and was deleted
   */
  delete(sessionId: string): boolean {
    const existed = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);

    if (existed) {
      this.logger.info({ sessionId }, 'Chunked deployment session deleted');
    }

    return existed;
  }

  /**
   * Clean up expired sessions and enforce max session limit
   * Called automatically on create(), but can be called manually
   */
  cleanup(): void {
    const now = Date.now();

    // First pass: collect expired session IDs (don't delete during iteration)
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.createdAt > this.timeoutMs) {
        expiredIds.push(id);
      }
    }

    // Delete expired sessions
    for (const id of expiredIds) {
      this.sessions.delete(id);
      this.logger.debug({ sessionId: id }, 'Removed expired chunk session');
    }

    // Second pass: enforce max sessions via LRU eviction
    while (this.sessions.size > this.maxSessions) {
      const oldestId = this.findOldestSession();

      if (oldestId) {
        this.sessions.delete(oldestId);
        this.logger.warn(
          { sessionId: oldestId, maxSessions: this.maxSessions },
          'Evicted oldest chunk session due to session limit'
        );
      } else {
        break; // Safety: shouldn't happen
      }
    }
  }

  /**
   * Find the oldest session ID
   */
  private findOldestSession(): string | null {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, session] of this.sessions.entries()) {
      if (session.createdAt < oldestTime) {
        oldestTime = session.createdAt;
        oldestId = id;
      }
    }

    return oldestId;
  }

  /**
   * Get all session IDs (for debugging/monitoring)
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get session statistics
   */
  getStats(): { count: number; maxSessions: number; timeoutMs: number } {
    return {
      count: this.sessions.size,
      maxSessions: this.maxSessions,
      timeoutMs: this.timeoutMs,
    };
  }
}
