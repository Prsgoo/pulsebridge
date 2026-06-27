import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { SecretDecryptionError } from "../errors/pulseErrors.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const FIELD_SEPARATOR = ":";

/**
 * Derives a 32-byte AES key from an arbitrary-length master key string.
 *
 * The master key is expected to be high-entropy infrastructure material (an
 * env var, a KMS-issued value, an OS-keychain secret), so a single SHA-256
 * pass is sufficient and — unlike a deliberately slow KDF — fast enough to run
 * per decryption. Callers derive once and reuse the returned buffer.
 */
export function deriveKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

/**
 * Encrypts `plaintext` with AES-256-GCM under `key`. Returns a self-describing
 * blob `iv:authTag:ciphertext` (each part base64) that {@link decryptSecret}
 * can reverse. A random IV is used for every call, so identical plaintexts
 * produce different blobs.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext]
    .map((part) => part.toString("base64"))
    .join(FIELD_SEPARATOR);
}

/**
 * Reverses {@link encryptSecret}. Throws {@link SecretDecryptionError} if the
 * blob is malformed, the key is wrong, or the ciphertext was tampered with
 * (GCM authentication failure). The error never carries plaintext or the key.
 */
export function decryptSecret(blob: string, key: Buffer): string {
  const parts = blob.split(FIELD_SEPARATOR);
  if (parts.length !== 3) {
    throw new SecretDecryptionError("Malformed secret ciphertext.");
  }

  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new SecretDecryptionError("Malformed secret ciphertext.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretDecryptionError();
  }
}
