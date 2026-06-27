import { describe, it, expect } from "vitest";
import { SecretDecryptionError } from "../../errors/pulseErrors.js";
import { decryptSecret, deriveKey, encryptSecret } from "../secretCrypto.js";

describe("secretCrypto", () => {
  const key = deriveKey("master-key-for-tests");

  describe("encrypt/decrypt round-trip", () => {
    it("returns the original plaintext after decryption", () => {
      const blob = encryptSecret("super-secret-value", key);
      expect(decryptSecret(blob, key)).toBe("super-secret-value");
    });

    it("round-trips an empty string", () => {
      const blob = encryptSecret("", key);
      expect(decryptSecret(blob, key)).toBe("");
    });

    it("round-trips unicode and multi-line values", () => {
      const value = "clé-🔐\nline2\ttabbed";
      expect(decryptSecret(encryptSecret(value, key), key)).toBe(value);
    });
  });

  describe("ciphertext properties", () => {
    it("produces a different blob each time for the same plaintext", () => {
      const a = encryptSecret("same", key);
      const b = encryptSecret("same", key);
      expect(a).not.toBe(b);
    });

    it("never contains the plaintext", () => {
      const blob = encryptSecret("plaintext-marker", key);
      expect(blob).not.toContain("plaintext-marker");
    });
  });

  describe("decryption failures", () => {
    it("throws SecretDecryptionError for the wrong key", () => {
      const blob = encryptSecret("value", key);
      const wrongKey = deriveKey("different-master-key");
      expect(() => decryptSecret(blob, wrongKey)).toThrow(
        SecretDecryptionError,
      );
    });

    it("throws SecretDecryptionError for a malformed blob", () => {
      expect(() => decryptSecret("not-a-valid-blob", key)).toThrow(
        SecretDecryptionError,
      );
    });

    it("throws SecretDecryptionError when the ciphertext is tampered with", () => {
      const blob = encryptSecret("value", key);
      const [iv, tag, ciphertext] = blob.split(":") as [string, string, string];
      const tampered = `${iv}:${tag}:${Buffer.from("tampered").toString("base64")}`;
      void ciphertext;
      expect(() => decryptSecret(tampered, key)).toThrow(SecretDecryptionError);
    });
  });

  describe("malformed structure", () => {
    const b64 = (bytes: number) => Buffer.alloc(bytes).toString("base64");

    it("reports a malformed blob when the field count is wrong", () => {
      expect(() => decryptSecret("only:two", key)).toThrow(
        "Malformed secret ciphertext.",
      );
    });

    it("reports a malformed blob when the IV length is wrong", () => {
      const blob = `${b64(2)}:${b64(16)}:${b64(8)}`;
      expect(() => decryptSecret(blob, key)).toThrow(
        "Malformed secret ciphertext.",
      );
    });

    it("reports a malformed blob when the auth tag length is wrong", () => {
      const blob = `${b64(12)}:${b64(2)}:${b64(8)}`;
      expect(() => decryptSecret(blob, key)).toThrow(
        "Malformed secret ciphertext.",
      );
    });
  });
});
