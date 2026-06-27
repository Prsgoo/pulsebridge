import { describe, it, expect } from "vitest";
import { InMemorySecretStore } from "../inMemorySecretStore.js";
import {
  ScopedSecretStore,
  createScopedSecretStore,
} from "../scopedSecretStore.js";

describe("ScopedSecretStore", () => {
  const makeStore = (secrets: Record<string, string> = {}) =>
    new InMemorySecretStore(secrets);

  describe("get", () => {
    it("returns the value for an allowed key that exists", () => {
      const store = makeStore({ API_KEY: "secret" });
      const scoped = new ScopedSecretStore(store, new Set(["API_KEY"]));
      expect(scoped.get("API_KEY")).toBe("secret");
    });

    it("returns undefined for an allowed key that is not in the underlying store", () => {
      const store = makeStore();
      const scoped = new ScopedSecretStore(store, new Set(["API_KEY"]));
      expect(scoped.get("API_KEY")).toBeUndefined();
    });

    it("throws when accessing a key not in the allowed set", () => {
      const store = makeStore({ SECRET: "value" });
      const scoped = new ScopedSecretStore(store, new Set(["API_KEY"]));
      expect(() => scoped.get("SECRET")).toThrowError(
        `Plugin is not authorized to access secret "SECRET". Declare it in your auth.secrets manifest.`,
      );
    });

    it("throws for a completely unknown key", () => {
      const store = makeStore();
      const scoped = new ScopedSecretStore(store, new Set(["API_KEY"]));
      expect(() => scoped.get("UNKNOWN")).toThrowError(
        `Plugin is not authorized to access secret "UNKNOWN". Declare it in your auth.secrets manifest.`,
      );
    });
  });

  describe("has", () => {
    it("returns true for an allowed key that exists in the underlying store", () => {
      const store = makeStore({ API_KEY: "secret" });
      const scoped = new ScopedSecretStore(store, new Set(["API_KEY"]));
      expect(scoped.has("API_KEY")).toBe(true);
    });

    it("returns false for an allowed key not present in the underlying store", () => {
      const store = makeStore();
      const scoped = new ScopedSecretStore(store, new Set(["API_KEY"]));
      expect(scoped.has("API_KEY")).toBe(false);
    });

    it("returns false for a key not in the allowed set, regardless of underlying store", () => {
      const store = makeStore({ SECRET: "value" });
      const scoped = new ScopedSecretStore(store, new Set(["API_KEY"]));
      expect(scoped.has("SECRET")).toBe(false);
    });
  });
});

describe("createScopedSecretStore", () => {
  it("creates a scoped store from a list of SecretRequirements", () => {
    const store = new InMemorySecretStore({ API_KEY: "secret" });
    const scoped = createScopedSecretStore(store, [
      { key: "API_KEY", required: true },
    ]);
    expect(scoped.get("API_KEY")).toBe("secret");
  });

  it("only allows access to keys declared in requirements", () => {
    const store = new InMemorySecretStore({ API_KEY: "secret", OTHER: "x" });
    const scoped = createScopedSecretStore(store, [
      { key: "API_KEY", required: true },
    ]);
    expect(() => scoped.get("OTHER")).toThrow();
  });

  it("creates an empty-scope store when requirements array is empty", () => {
    const store = new InMemorySecretStore({ API_KEY: "secret" });
    const scoped = createScopedSecretStore(store, []);
    expect(scoped.has("API_KEY")).toBe(false);
    expect(() => scoped.get("API_KEY")).toThrow();
  });
});
