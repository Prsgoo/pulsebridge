import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStateStore } from "../inMemoryStateStore.js";

describe("InMemoryStateStore", () => {
  let store: InMemoryStateStore;

  beforeEach(() => {
    store = new InMemoryStateStore();
  });

  it("returns undefined for a key that has never been set", async () => {
    const value = await store.get("missing-key");
    expect(value).toBeUndefined();
  });

  it("returns the value after set()", async () => {
    await store.set("my-key", "hello");
    const value = await store.get("my-key");
    expect(value).toBe("hello");
  });

  it("overwrites an existing key on a second set()", async () => {
    await store.set("key", "first");
    await store.set("key", "second");
    expect(await store.get("key")).toBe("second");
  });

  it("returns undefined after delete()", async () => {
    await store.set("key", "value");
    await store.delete("key");
    expect(await store.get("key")).toBeUndefined();
  });

  it("delete() on a non-existent key does not throw", async () => {
    await expect(store.delete("never-set")).resolves.toBeUndefined();
  });

  it("stores multiple keys independently", async () => {
    await store.set("a", "1");
    await store.set("b", "2");
    expect(await store.get("a")).toBe("1");
    expect(await store.get("b")).toBe("2");
  });

  it("deleting one key does not affect another", async () => {
    await store.set("a", "1");
    await store.set("b", "2");
    await store.delete("a");
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBe("2");
  });
});
