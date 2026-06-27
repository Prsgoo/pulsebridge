import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryTokenStore } from "../inMemoryTokenStore.js";
import type { OAuthToken } from "../tokenStore.js";

const makeToken = (suffix = ""): OAuthToken => ({
  accessToken: `token-${suffix}`,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

describe("InMemoryTokenStore", () => {
  let store: InMemoryTokenStore;

  beforeEach(() => {
    store = new InMemoryTokenStore();
  });

  it("returns undefined for a key that was never set", () => {
    expect(store.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a token by key", () => {
    const token = makeToken("abc");
    store.set("my-token", token);
    expect(store.get("my-token")).toEqual(token);
  });

  it("overwrites an existing token when set is called again", () => {
    store.set("my-token", makeToken("first"));
    const updated = makeToken("second");
    store.set("my-token", updated);
    expect(store.get("my-token")).toEqual(updated);
  });

  it("has — returns false for a key that was never set", () => {
    expect(store.has("missing")).toBe(false);
  });

  it("has — returns true after set", () => {
    store.set("my-token", makeToken());
    expect(store.has("my-token")).toBe(true);
  });

  it("delete — removes the token so get returns undefined", () => {
    store.set("my-token", makeToken());
    store.delete("my-token");
    expect(store.get("my-token")).toBeUndefined();
  });

  it("delete — has returns false after deletion", () => {
    store.set("my-token", makeToken());
    store.delete("my-token");
    expect(store.has("my-token")).toBe(false);
  });

  it("delete — is a no-op for a key that was never set", () => {
    expect(() => store.delete("never-set")).not.toThrow();
  });
});
