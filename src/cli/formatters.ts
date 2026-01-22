// Path: src/cli/formatters.ts
// CLI formatting utilities for display output

import { ANSI } from './constants.js';

/**
 * Format file size to human readable
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format duration in ms to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Format date to relative time or absolute
 */
export function formatDate(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Create a progress bar string
 */
export function progressBar(current: number, total: number, width = 30): string {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `${ANSI.cyan}${bar}${ANSI.reset} ${percent}%`;
}

/**
 * Truncate a file path for display, keeping the end
 */
export function truncatePath(path: string, maxLength = 60): string {
  if (path.length <= maxLength) return path;
  return '...' + path.slice(-(maxLength - 3));
}

/**
 * Format a count with singular/plural label
 */
export function formatCount(count: number, singular: string, plural?: string): string {
  const label = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count} ${label}`;
}
