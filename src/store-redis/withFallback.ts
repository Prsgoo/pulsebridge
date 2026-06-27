import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";

export async function withFallback<T>(
  logger: PulseLogger,
  operation: () => Promise<T>,
  onFallback: () => Promise<T>,
  label: string,
  meta?: Record<string, unknown>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    logger.warn(`${label} — using fallback store.`, {
      ...meta,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      return await onFallback();
    } catch (fallbackErr) {
      logger.error(`${label} — fallback also failed.`, {
        ...meta,
        error:
          fallbackErr instanceof Error
            ? fallbackErr.message
            : String(fallbackErr),
      });
      throw fallbackErr;
    }
  }
}
