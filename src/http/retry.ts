import axios from 'axios';

export interface RetryOptions {
  /** Total tries, including the first one. */
  attempts?: number;
  baseDelayMs?: number;
}

const MAX_DELAY_MS = 30_000;

/**
 * Retries rate limits (429), server errors (5xx) and dropped connections with
 * exponential backoff: 1s, 2s, 4s… Other errors (400, 401, 404) fail at once.
 */
export async function withRetry<T>(call: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 4, baseDelayMs = 1000 } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(error, attempt, baseDelayMs)));
    }
  }
}

export function isRetryable(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status === undefined) return true; // no response: connection reset, timeout
  return status === 429 || status >= 500;
}

/** Uses the server's Retry-After (seconds) when it sends one. */
export function retryDelay(error: unknown, attempt: number, baseDelayMs: number): number {
  const retryAfter = axios.isAxiosError(error) ? Number(error.response?.headers?.['retry-after']) : NaN;
  const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1);
  return Math.min(delay, MAX_DELAY_MS);
}
