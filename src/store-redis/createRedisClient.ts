import type { Redis } from "ioredis";

export interface RedisClientOptions {
  /** Redis connection URL. Default: "redis://localhost:6379" */
  url?: string;
  /**
   * Base delay in milliseconds for exponential reconnect backoff.
   * Each attempt waits `min(baseRetryDelayMs * 2^attempt, maxRetryDelayMs)`.
   * @default 100
   */
  baseRetryDelayMs?: number;
  /**
   * Maximum delay in milliseconds between reconnect attempts.
   * @default 30_000
   */
  maxRetryDelayMs?: number;
  /**
   * Maximum number of reconnect attempts before giving up.
   * Set to 0 to disable retries entirely. Set to null to retry indefinitely.
   * NOTE: ioredis passes attempt starting at 1, so `attempt > maxRetryAttempts`
   * with maxRetryAttempts=0 stops after the first attempt (zero retries).
   * @default 20
   */
  maxRetryAttempts?: number | null;
  /**
   * Per-command timeout in milliseconds. Commands that exceed this are rejected.
   * Helps bound latency when Redis becomes slow rather than unresponsive.
   * @default 5_000
   */
  commandTimeout?: number;
}

/**
 * Creates an ioredis client pre-configured with sensible defaults for use with
 * PulseBridge stores: exponential reconnect backoff, bounded retry attempts,
 * and a per-command timeout so a slow Redis doesn't stall the scheduler.
 *
 * Pass the returned client to `RedisRecordStore` or `RedisViewStore`.
 */
export async function createRedisClient(
  options: RedisClientOptions = {},
): Promise<Redis> {
  const { Redis } = await import("ioredis");

  const {
    url = "redis://localhost:6379",
    baseRetryDelayMs = 100,
    maxRetryDelayMs = 30_000,
    maxRetryAttempts = 20,
    commandTimeout = 5_000,
  } = options;

  return new Redis(url, {
    commandTimeout,
    retryStrategy(attempt: number): number | null {
      if (maxRetryAttempts !== null && attempt > maxRetryAttempts) {
        return null; // stop retrying
      }
      return Math.min(
        baseRetryDelayMs * Math.pow(2, attempt - 1),
        maxRetryDelayMs,
      );
    },
    reconnectOnError(err: Error): boolean {
      // Reconnect on READONLY errors (Redis failover) and connection resets
      return (
        err.message.includes("READONLY") || err.message.includes("ECONNRESET")
      );
    },
  });
}
