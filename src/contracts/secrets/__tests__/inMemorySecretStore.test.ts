import { describe, it, expect } from "vitest";
import { InMemorySecretStore } from "../inMemorySecretStore.js";

describe("InMemorySecretStore", () => {
  describe("constructor", () => {
    it("initialises empty when no arguments are provided", () => {
      const store = new InMemorySecretStore();
      expect(store.has("ANY_KEY")).toBe(false);
    });

    it("initialises with provided key/value pairs", () => {
      const store = new InMemorySecretStore({ API_KEY: "abc123" });
      expect(store.has("API_KEY")).toBe(true);
      expect(store.get("API_KEY")).toBe("abc123");
    });

    it("initialises with multiple keys", () => {
      const store = new InMemorySecretStore({
        KEY_A: "value-a",
        KEY_B: "value-b",
      });
      expect(store.has("KEY_A")).toBe(true);
      expect(store.has("KEY_B")).toBe(true);
    });
  });

  describe("get", () => {
    it("returns the value for a key that exists", () => {
      const store = new InMemorySecretStore({ TOKEN: "secret" });
      expect(store.get("TOKEN")).toBe("secret");
    });

    it("returns undefined for a key that does not exist", () => {
      const store = new InMemorySecretStore();
      expect(store.get("MISSING")).toBeUndefined();
    });
  });

  describe("has", () => {
    it("returns true for a key that exists", () => {
      const store = new InMemorySecretStore({ TOKEN: "secret" });
      expect(store.has("TOKEN")).toBe(true);
    });

    it("returns false for a key that does not exist", () => {
      const store = new InMemorySecretStore();
      expect(store.has("MISSING")).toBe(false);
    });
  });

  describe("set", () => {
    it("adds a new key after construction", () => {
      const store = new InMemorySecretStore();
      store.set("NEW_KEY", "new-value");
      expect(store.has("NEW_KEY")).toBe(true);
      expect(store.get("NEW_KEY")).toBe("new-value");
    });

    it("overwrites an existing key", () => {
      const store = new InMemorySecretStore({ KEY: "original" });
      store.set("KEY", "updated");
      expect(store.get("KEY")).toBe("updated");
    });
  });
});
