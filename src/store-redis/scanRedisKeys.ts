import type { Redis } from "ioredis";

const SCAN_PAGE_SIZE = 100;

/**
 * Scans all keys matching `pattern` using cursor-based SCAN.
 * Returns the complete list once the cursor wraps back to "0".
 */
export async function scanRedisKeys(
  client: Redis,
  pattern: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      SCAN_PAGE_SIZE,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys;
}
