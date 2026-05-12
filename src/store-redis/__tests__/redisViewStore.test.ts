import { describe, it, expect, vi, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { RedisViewStore } from "../redisViewStore.js";
import { InMemoryViewStore } from "../../storage/inMemoryViewStore.js";
import type { PulseViewRecord } from "../../contracts/records/pulseViewRecord.js";

const makeView = (view: string): PulseViewRecord => ({
  view,
  generatedAt: new Date().toISOString(),
  items: [],
});

describe("RedisViewStore", () => {
  let store: RedisViewStore;
  let client: InstanceType<typeof RedisMock>;

  beforeEach(async () => {
    client = new RedisMock();
    await client.flushall();
    store = new RedisViewStore({ client });
  });

  it("starts empty", async () => {
    expect(await store.getAll()).toHaveLength(0);
  });

  it("stores and retrieves a view by name", async () => {
    const view = makeView("planes.feed");
    await store.set(view);
    expect(await store.get("planes.feed")).toEqual(view);
  });

  it("returns undefined for an unknown view name", async () => {
    expect(await store.get("unknown")).toBeUndefined();
  });

  it("overwrites an existing view with the same name", async () => {
    await store.set(makeView("planes.feed"));
    const updated = {
      ...makeView("planes.feed"),
      generatedAt: "2099-01-01T00:00:00.000Z",
    };
    await store.set(updated);
    expect((await store.get("planes.feed"))?.generatedAt).toBe(
      "2099-01-01T00:00:00.000Z",
    );
  });

  it("returns all stored views", async () => {
    await store.set(makeView("planes.feed"));
    await store.set(makeView("other.view"));
    expect(await store.getAll()).toHaveLength(2);
  });

  it("clears all views", async () => {
    await store.set(makeView("planes.feed"));
    await store.clear();
    expect(await store.getAll()).toHaveLength(0);
  });

  it("preserves view data through serialization round-trip", async () => {
    const view: PulseViewRecord = {
      view: "planes.feed",
      generatedAt: "2026-01-01T00:00:00.000Z",
      items: [
        {
          type: "plane.observation",
          timestamp: "2026-01-01T00:00:00.000Z",
          source: "opensky",
          data: {},
        },
      ],
    };
    await store.set(view);
    expect(await store.get("planes.feed")).toEqual(view);
  });
});

// ---------------------------------------------------------------------------
// RedisViewStore — fallback paths
// ---------------------------------------------------------------------------

describe("RedisViewStore — fallback", () => {
  const makeThrowingClient = () =>
    ({
      set: vi.fn().mockRejectedValue(new Error("Redis down")),
      get: vi.fn().mockRejectedValue(new Error("Redis down")),
      del: vi.fn().mockRejectedValue(new Error("Redis down")),
      scan: vi.fn().mockRejectedValue(new Error("Redis down")),
      pipeline: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error("Redis down")),
      }),
    }) as unknown as InstanceType<typeof RedisMock>;

  it("set — falls back to InMemoryViewStore when Redis throws", async () => {
    const fallback = new InMemoryViewStore();
    const throwingClient = makeThrowingClient();
    const store = new RedisViewStore({ client: throwingClient, fallback });

    await store.set(makeView("planes.feed"));
    expect(await fallback.get("planes.feed")).toBeDefined();
  });

  it("get — returns fallback value when Redis throws", async () => {
    const fallback = new InMemoryViewStore();
    await fallback.set(makeView("planes.feed"));

    const throwingClient = makeThrowingClient();
    const store = new RedisViewStore({ client: throwingClient, fallback });

    expect(await store.get("planes.feed")).toBeDefined();
  });

  it("getAll — returns fallback views when Redis throws", async () => {
    const fallback = new InMemoryViewStore();
    await fallback.set(makeView("planes.feed"));

    const throwingClient = makeThrowingClient();
    const store = new RedisViewStore({ client: throwingClient, fallback });

    expect(await store.getAll()).toHaveLength(1);
  });

  it("clear — falls back when Redis throws", async () => {
    const fallback = new InMemoryViewStore();
    await fallback.set(makeView("planes.feed"));

    const throwingClient = makeThrowingClient();
    const store = new RedisViewStore({ client: throwingClient, fallback });

    await store.clear();
    expect(await fallback.getAll()).toHaveLength(0);
  });

  it("get — returns undefined when Redis throws and no fallback is set", async () => {
    const throwingClient = makeThrowingClient();
    const store = new RedisViewStore({ client: throwingClient });

    expect(await store.get("planes.feed")).toBeUndefined();
  });

  it("getAll — returns empty array when Redis throws and no fallback is set", async () => {
    const throwingClient = makeThrowingClient();
    const store = new RedisViewStore({ client: throwingClient });

    expect(await store.getAll()).toEqual([]);
  });
});
