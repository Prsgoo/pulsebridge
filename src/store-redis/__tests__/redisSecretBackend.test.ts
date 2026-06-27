import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { RedisSecretBackend } from "../redisSecretBackend.js";

describe("RedisSecretBackend", () => {
  let backend: RedisSecretBackend;
  let client: InstanceType<typeof RedisMock>;

  beforeEach(async () => {
    client = new RedisMock();
    await client.flushall();
    backend = new RedisSecretBackend({ client });
  });

  it("returns undefined for an unset key", async () => {
    expect(await backend.read("ns", "key")).toBeUndefined();
  });

  it("reads back a written blob", async () => {
    await backend.write("ns", "key", "blob");
    expect(await backend.read("ns", "key")).toBe("blob");
  });

  it("isolates keys across namespaces", async () => {
    await backend.write("ns-a", "key", "a");
    await backend.write("ns-b", "key", "b");
    expect(await backend.read("ns-a", "key")).toBe("a");
    expect(await backend.read("ns-b", "key")).toBe("b");
  });

  it("deletes a single key", async () => {
    await backend.write("ns", "key", "blob");
    await backend.delete("ns", "key");
    expect(await backend.read("ns", "key")).toBeUndefined();
  });

  it("lists the keys in a namespace stripped of the prefix", async () => {
    await backend.write("ns", "k1", "a");
    await backend.write("ns", "k2", "b");
    expect((await backend.listKeys("ns")).sort()).toEqual(["k1", "k2"]);
  });

  it("does not leak keys from another namespace into listKeys", async () => {
    await backend.write("ns-a", "k1", "a");
    await backend.write("ns-b", "k2", "b");
    expect(await backend.listKeys("ns-a")).toEqual(["k1"]);
  });

  it("deleteNamespace removes every key in the namespace only", async () => {
    await backend.write("ns-a", "k1", "a");
    await backend.write("ns-a", "k2", "b");
    await backend.write("ns-b", "k3", "c");
    await backend.deleteNamespace("ns-a");
    expect(await backend.listKeys("ns-a")).toEqual([]);
    expect(await backend.read("ns-b", "k3")).toBe("c");
  });

  it("handles keys that themselves contain a colon", async () => {
    await backend.write("ns", "scope:key", "blob");
    expect(await backend.read("ns", "scope:key")).toBe("blob");
    expect(await backend.listKeys("ns")).toEqual(["scope:key"]);
  });
});
