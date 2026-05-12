import { describe, it, expect, vi, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { RedisRecordStore } from "../redisRecordStore.js";
import { InMemoryRecordStore } from "../../storage/inMemoryRecordStore.js";
import type { PulseRecord } from "../../contracts/records/pulseRecord.js";

const makeRecord = (type: string, source = "test"): PulseRecord => ({
  type,
  timestamp: new Date().toISOString(),
  source,
  data: {},
});

describe("RedisRecordStore", () => {
  let store: RedisRecordStore;
  let client: InstanceType<typeof RedisMock>;

  beforeEach(async () => {
    client = new RedisMock();
    await client.flushall();
    store = new RedisRecordStore({ client });
  });

  it("starts empty", async () => {
    expect(await store.getAll()).toHaveLength(0);
  });

  it("appends records and returns them all", async () => {
    await store.append([
      makeRecord("plane.observation"),
      makeRecord("plane.observation"),
    ]);
    expect(await store.getAll()).toHaveLength(2);
  });

  it("accumulates across multiple appends", async () => {
    await store.append([makeRecord("plane.observation")]);
    await store.append([makeRecord("plane.observation")]);
    expect(await store.getAll()).toHaveLength(2);
  });

  it("setByPlugin stores records under the plugin bucket", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    expect(await store.getAll()).toHaveLength(1);
  });

  it("setByPlugin replaces existing records for the same plugin", async () => {
    await store.setByPlugin("plugin-a", [
      makeRecord("plane.observation"),
      makeRecord("plane.observation"),
    ]);
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    expect(await store.getAll()).toHaveLength(1);
  });

  it("setByPlugin for different plugins keeps both buckets", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    await store.setByPlugin("plugin-b", [makeRecord("plane.observation")]);
    expect(await store.getAll()).toHaveLength(2);
  });

  it("returns records filtered by type", async () => {
    await store.append([
      makeRecord("plane.observation"),
      makeRecord("other.type"),
    ]);
    expect(await store.getByType("plane.observation")).toHaveLength(1);
    expect(await store.getByType("other.type")).toHaveLength(1);
  });

  it("returns empty array for an unknown type", async () => {
    await store.append([makeRecord("plane.observation")]);
    expect(await store.getByType("unknown")).toHaveLength(0);
  });

  it("clears all records", async () => {
    await store.append([makeRecord("plane.observation")]);
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    await store.clear();
    expect(await store.getAll()).toHaveLength(0);
  });

  it("preserves record data through serialization round-trip", async () => {
    const record: PulseRecord = {
      type: "plane.observation",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "opensky",
      entityKey: "ABC123",
      data: { callsign: "ABC123", altitude: 10000 },
    };
    await store.append([record]);
    const all = await store.getAll();
    expect(all[0]).toEqual(record);
  });

  // ── Type index ─────────────────────────────────────────────────────────────

  it("getByType returns only records of the requested type", async () => {
    await store.setByPlugin("plugin-a", [
      makeRecord("plane.observation"),
      makeRecord("airport.status"),
    ]);
    const planes = await store.getByType("plane.observation");
    expect(planes).toHaveLength(1);
    expect(planes[0]?.type).toBe("plane.observation");
  });

  it("getByType returns records across multiple plugins", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    await store.setByPlugin("plugin-b", [makeRecord("plane.observation")]);
    expect(await store.getByType("plane.observation")).toHaveLength(2);
  });

  it("getByType updates when a plugin replaces its records with different types", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    expect(await store.getByType("plane.observation")).toHaveLength(1);

    // Plugin now produces a different type — old type should be gone.
    await store.setByPlugin("plugin-a", [makeRecord("airport.status")]);
    expect(await store.getByType("plane.observation")).toHaveLength(0);
    expect(await store.getByType("airport.status")).toHaveLength(1);
  });

  it("getByType includes records written via append", async () => {
    await store.append([makeRecord("plane.observation")]);
    expect(await store.getByType("plane.observation")).toHaveLength(1);
  });

  it("getByType returns empty array after clear", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    await store.clear();
    expect(await store.getByType("plane.observation")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RedisRecordStore — fallback paths
// ---------------------------------------------------------------------------

describe("RedisRecordStore — fallback", () => {
  const makeThrowingClient = () =>
    ({
      rpush: vi.fn().mockRejectedValue(new Error("Redis down")),
      lrange: vi.fn().mockRejectedValue(new Error("Redis down")),
      del: vi.fn().mockRejectedValue(new Error("Redis down")),
      multi: vi.fn().mockReturnValue({
        del: vi.fn().mockReturnThis(),
        rpush: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error("Redis down")),
      }),
      scan: vi.fn().mockRejectedValue(new Error("Redis down")),
      pipeline: vi.fn().mockReturnValue({
        lrange: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error("Redis down")),
      }),
    }) as unknown as InstanceType<typeof RedisMock>;

  it("append — falls back to InMemoryRecordStore when Redis throws", async () => {
    const fallback = new InMemoryRecordStore();
    const throwingClient = makeThrowingClient();
    const store = new RedisRecordStore({ client: throwingClient, fallback });

    await store.append([makeRecord("plane.observation")]);
    expect(await fallback.getAll()).toHaveLength(1);
  });

  it("setByPlugin — falls back when Redis throws", async () => {
    const fallback = new InMemoryRecordStore();
    const throwingClient = makeThrowingClient();
    const store = new RedisRecordStore({ client: throwingClient, fallback });

    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    expect(await fallback.getAll()).toHaveLength(1);
  });

  it("getAll — returns fallback records when Redis throws", async () => {
    const fallback = new InMemoryRecordStore();
    await fallback.append([makeRecord("plane.observation")]);

    const throwingClient = makeThrowingClient();
    const store = new RedisRecordStore({ client: throwingClient, fallback });

    expect(await store.getAll()).toHaveLength(1);
  });

  it("clear — falls back when Redis throws", async () => {
    const fallback = new InMemoryRecordStore();
    await fallback.append([makeRecord("plane.observation")]);

    const throwingClient = makeThrowingClient();
    const store = new RedisRecordStore({ client: throwingClient, fallback });

    await store.clear();
    expect(await fallback.getAll()).toHaveLength(0);
  });

  it("getAll — returns empty array when Redis throws and no fallback is set", async () => {
    const throwingClient = makeThrowingClient();
    const store = new RedisRecordStore({ client: throwingClient });

    expect(await store.getAll()).toEqual([]);
  });
});
