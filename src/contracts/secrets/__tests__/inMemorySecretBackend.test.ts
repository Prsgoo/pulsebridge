import { describe, it, expect } from "vitest";
import { InMemorySecretBackend } from "../inMemorySecretBackend.js";

describe("InMemorySecretBackend", () => {
  it("returns undefined for an unset key", async () => {
    const backend = new InMemorySecretBackend();
    expect(await backend.read("ns", "key")).toBeUndefined();
  });

  it("reads back a written blob", async () => {
    const backend = new InMemorySecretBackend();
    await backend.write("ns", "key", "blob");
    expect(await backend.read("ns", "key")).toBe("blob");
  });

  it("overwrites an existing value", async () => {
    const backend = new InMemorySecretBackend();
    await backend.write("ns", "key", "first");
    await backend.write("ns", "key", "second");
    expect(await backend.read("ns", "key")).toBe("second");
  });

  it("isolates keys across namespaces", async () => {
    const backend = new InMemorySecretBackend();
    await backend.write("ns-a", "key", "a");
    await backend.write("ns-b", "key", "b");
    expect(await backend.read("ns-a", "key")).toBe("a");
    expect(await backend.read("ns-b", "key")).toBe("b");
  });

  it("deletes a single key", async () => {
    const backend = new InMemorySecretBackend();
    await backend.write("ns", "key", "blob");
    await backend.delete("ns", "key");
    expect(await backend.read("ns", "key")).toBeUndefined();
  });

  it("lists the keys in a namespace", async () => {
    const backend = new InMemorySecretBackend();
    await backend.write("ns", "k1", "a");
    await backend.write("ns", "k2", "b");
    expect((await backend.listKeys("ns")).sort()).toEqual(["k1", "k2"]);
  });

  it("returns an empty list for an unknown namespace", async () => {
    const backend = new InMemorySecretBackend();
    expect(await backend.listKeys("missing")).toEqual([]);
  });

  it("deleteNamespace removes every key in the namespace", async () => {
    const backend = new InMemorySecretBackend();
    await backend.write("ns", "k1", "a");
    await backend.write("ns", "k2", "b");
    await backend.deleteNamespace("ns");
    expect(await backend.listKeys("ns")).toEqual([]);
  });
});
