/**
 * Bud — Retry Tool Executor
 *
 * Wraps Vercel AI SDK tool execution and retries transient errors.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export function isTransientError(error: any): boolean {
  if (!error) return false;

  const message = typeof error.message === 'string' ? error.message : String(error);
  const code = error.code || '';

  // Network / timeout / rate-limit indicators
  if (
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNRESET') ||
    message.includes('ECONNREFUSED') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED'
  ) {
    return true;
  }

  // HTTP 5xx / 429
  const status = error.status || error.statusCode;
  if (status >= 500 || status === 429) return true;

  return false;
}

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
  onRetry?: (attempt: number, reason: string) => void
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;

  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const isTransient = isTransientError(err);

      if (!isTransient || attempt >= maxRetries) {
        throw err;
      }

      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const reason = (err as Error).message || 'transient error';
      onRetry?.(attempt + 1, reason);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
