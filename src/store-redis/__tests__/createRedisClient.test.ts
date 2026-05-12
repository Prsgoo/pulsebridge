import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture constructor args before the module under test runs
const mockRedisConstructor = vi.fn().mockImplementation(function (
  this: Record<string, unknown>,
  _url: string,
  opts: Record<string, unknown>,
) {
  this._opts = opts;
});

vi.mock("ioredis", () => ({ Redis: mockRedisConstructor }));

const { createRedisClient } = await import("../createRedisClient.js");

type RetryStrategy = (attempt: number) => number | null;
type ReconnectOnError = (err: Error) => boolean;

function captureOpts(): {
  retryStrategy: RetryStrategy;
  reconnectOnError: ReconnectOnError;
} {
  return mockRedisConstructor.mock.results.at(-1)?.value._opts as {
    retryStrategy: RetryStrategy;
    reconnectOnError: ReconnectOnError;
  };
}

describe("createRedisClient", () => {
  beforeEach(() => {
    mockRedisConstructor.mockClear();
  });

  it("constructs a Redis instance with the default URL", async () => {
    await createRedisClient();
    expect(mockRedisConstructor).toHaveBeenCalledWith(
      "redis://localhost:6379",
      expect.any(Object),
    );
  });

  it("uses a custom URL when provided", async () => {
    await createRedisClient({ url: "redis://custom:9999" });
    expect(mockRedisConstructor).toHaveBeenCalledWith(
      "redis://custom:9999",
      expect.any(Object),
    );
  });

  it("passes commandTimeout to Redis", async () => {
    await createRedisClient({ commandTimeout: 1_000 });
    const { retryStrategy: _r, reconnectOnError: _rc, ...rest } = captureOpts();
    expect(rest).toMatchObject({ commandTimeout: 1_000 });
  });

  // ── retryStrategy ──────────────────────────────────────────────────────────

  it("retryStrategy — returns delay for first attempt", async () => {
    await createRedisClient({ baseRetryDelayMs: 100 });
    const { retryStrategy } = captureOpts();
    expect(retryStrategy(1)).toBe(100); // 100 * 2^0
  });

  it("retryStrategy — doubles delay on each attempt", async () => {
    await createRedisClient({ baseRetryDelayMs: 100 });
    const { retryStrategy } = captureOpts();
    expect(retryStrategy(2)).toBe(200); // 100 * 2^1
    expect(retryStrategy(3)).toBe(400); // 100 * 2^2
  });

  it("retryStrategy — caps delay at maxRetryDelayMs", async () => {
    await createRedisClient({ baseRetryDelayMs: 100, maxRetryDelayMs: 500 });
    const { retryStrategy } = captureOpts();
    // 100 * 2^10 = 102400 > 500
    expect(retryStrategy(11)).toBe(500);
  });

  it("retryStrategy — returns null when attempt exceeds maxRetryAttempts", async () => {
    await createRedisClient({ maxRetryAttempts: 20 });
    const { retryStrategy } = captureOpts();
    expect(retryStrategy(21)).toBeNull();
  });

  it("retryStrategy — returns null for attempt equal to maxRetryAttempts + 1", async () => {
    await createRedisClient({ maxRetryAttempts: 3 });
    const { retryStrategy } = captureOpts();
    expect(retryStrategy(3)).not.toBeNull(); // attempt 3 is still within limit
    expect(retryStrategy(4)).toBeNull(); // attempt 4 exceeds limit
  });

  it("retryStrategy — retries indefinitely when maxRetryAttempts is null", async () => {
    await createRedisClient({ maxRetryAttempts: null });
    const { retryStrategy } = captureOpts();
    expect(retryStrategy(1000)).not.toBeNull();
  });

  // ── reconnectOnError ───────────────────────────────────────────────────────

  it("reconnectOnError — returns true for READONLY errors", async () => {
    await createRedisClient();
    const { reconnectOnError } = captureOpts();
    expect(
      reconnectOnError(
        new Error("ERR READONLY You can't write against a read only slave"),
      ),
    ).toBe(true);
  });

  it("reconnectOnError — returns true for ECONNRESET errors", async () => {
    await createRedisClient();
    const { reconnectOnError } = captureOpts();
    expect(reconnectOnError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("reconnectOnError — returns false for other errors", async () => {
    await createRedisClient();
    const { reconnectOnError } = captureOpts();
    expect(
      reconnectOnError(new Error("WRONGPASS invalid username-password pair")),
    ).toBe(false);
  });
});
