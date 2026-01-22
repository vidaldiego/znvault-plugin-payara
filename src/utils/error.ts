// Path: src/utils/error.ts
// Error handling utilities

/**
 * Extracts a human-readable error message from an unknown error value.
 *
 * @param err - The error value (can be Error, string, or any other type)
 * @returns The error message string
 *
 * @example
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   console.error(`Operation failed: ${getErrorMessage(err)}`);
 * }
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
