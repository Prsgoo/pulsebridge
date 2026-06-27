import { describe, it, expect } from "vitest";
import { MasterKeyRequiredError } from "../../errors/pulseErrors.js";
import { EncryptedSecretVault } from "../encryptedSecretVault.js";
import { InMemorySecretBackend } from "../inMemorySecretBackend.js";

const MASTER_KEY = "test-master-key";

const makeVault = (masterKey: string = MASTER_KEY) =>
  new EncryptedSecretVault(new InMemorySecretBackend(), masterKey);

const makeKeylessVault = () =>
  new EncryptedSecretVault(new InMemorySecretBackend(), undefined);

describe("EncryptedSecretVault", () => {
  describe("set/get", () => {
    it("returns the value that was set", async () => {
      const vault = makeVault();
      await vault.set("plugin-a", "API_KEY", "secret-value");
      expect(await vault.get("plugin-a", "API_KEY")).toBe("secret-value");
    });

    it("returns undefined for an unset key", async () => {
      const vault = makeVault();
      expect(await vault.get("plugin-a", "API_KEY")).toBeUndefined();
    });

    it("treats an empty-string value as absent", async () => {
      const vault = makeVault();
      await vault.set("plugin-a", "API_KEY", "");
      expect(await vault.get("plugin-a", "API_KEY")).toBeUndefined();
      expect(await vault.has("plugin-a", "API_KEY")).toBe(false);
    });
  });

  describe("namespace isolation", () => {
    it("does not expose one plugin's secret under another plugin's namespace", async () => {
      const vault = makeVault();
      await vault.set("plugin-a", "API_KEY", "a-value");
      expect(await vault.get("plugin-b", "API_KEY")).toBeUndefined();
    });

    it("keeps same-named keys separate per namespace", async () => {
      const vault = makeVault();
      await vault.set("plugin-a", "API_KEY", "a-value");
      await vault.set("plugin-b", "API_KEY", "b-value");
      expect(await vault.get("plugin-a", "API_KEY")).toBe("a-value");
      expect(await vault.get("plugin-b", "API_KEY")).toBe("b-value");
    });

    it("deleteNamespace removes only the target plugin's secrets", async () => {
      const vault = makeVault();
      await vault.set("plugin-a", "API_KEY", "a-value");
      await vault.set("plugin-b", "API_KEY", "b-value");
      await vault.deleteNamespace("plugin-a");
      expect(await vault.has("plugin-a", "API_KEY")).toBe(false);
      expect(await vault.get("plugin-b", "API_KEY")).toBe("b-value");
    });
  });

  describe("listKeys", () => {
    it("lists the keys stored for a plugin", async () => {
      const vault = makeVault();
      await vault.set("plugin-a", "API_KEY", "x");
      await vault.set("plugin-a", "API_SECRET", "y");
      expect((await vault.listKeys("plugin-a")).sort()).toEqual([
        "API_KEY",
        "API_SECRET",
      ]);
    });
  });

  describe("encryption at rest", () => {
    it("stores ciphertext in the backend, not the plaintext", async () => {
      const backend = new InMemorySecretBackend();
      const vault = new EncryptedSecretVault(backend, MASTER_KEY);
      await vault.set("plugin-a", "API_KEY", "plaintext-marker");
      const stored = await backend.read("plugin-a", "API_KEY");
      expect(stored).toBeDefined();
      expect(stored).not.toContain("plaintext-marker");
    });

    it("cannot decrypt secrets written under a different master key", async () => {
      const backend = new InMemorySecretBackend();
      await new EncryptedSecretVault(backend, "key-one").set(
        "plugin-a",
        "API_KEY",
        "value",
      );
      const otherVault = new EncryptedSecretVault(backend, "key-two");
      await expect(otherVault.get("plugin-a", "API_KEY")).rejects.toThrow();
    });
  });

  describe("missing master key", () => {
    it("reports hasMasterKey false when none configured", () => {
      expect(makeKeylessVault().hasMasterKey).toBe(false);
    });

    it("throws MasterKeyRequiredError on set", async () => {
      const vault = makeKeylessVault();
      await expect(vault.set("plugin-a", "API_KEY", "x")).rejects.toThrow(
        MasterKeyRequiredError,
      );
    });

    it("throws MasterKeyRequiredError on get of an existing secret", async () => {
      const backend = new InMemorySecretBackend();
      await new EncryptedSecretVault(backend, MASTER_KEY).set(
        "plugin-a",
        "API_KEY",
        "value",
      );
      const keyless = new EncryptedSecretVault(backend, undefined);
      await expect(keyless.get("plugin-a", "API_KEY")).rejects.toThrow(
        MasterKeyRequiredError,
      );
    });

    it("treats an empty-string master key as no key", () => {
      expect(makeVault("").hasMasterKey).toBe(false);
    });

    it("allows listKeys without a master key", async () => {
      const backend = new InMemorySecretBackend();
      await new EncryptedSecretVault(backend, MASTER_KEY).set(
        "plugin-a",
        "API_KEY",
        "value",
      );
      const keyless = new EncryptedSecretVault(backend, undefined);
      expect(await keyless.listKeys("plugin-a")).toEqual(["API_KEY"]);
    });
  });
});
