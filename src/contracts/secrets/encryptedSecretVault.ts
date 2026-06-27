import { MasterKeyRequiredError } from "../errors/pulseErrors.js";
import { decryptSecret, deriveKey, encryptSecret } from "./secretCrypto.js";
import type { SecretBackend } from "./secretBackend.js";

/**
 * The core's single interface to secrets. Secrets are ALWAYS encrypted at rest:
 * the vault encrypts on the way into the {@link SecretBackend} and decrypts on
 * the way out, so the backend only ever holds opaque ciphertext.
 *
 * Secrets are namespaced by owning plugin id — identity is `(pluginId, key)`.
 * There is no cross-namespace access; a plugin's runtime view is built solely
 * from its own namespace.
 *
 * Encryption requires a master key supplied by the host at construction. If no
 * master key is configured, any read or write throws {@link MasterKeyRequiredError}.
 * A master-key-less vault is still valid for plugins that declare no secrets —
 * `listKeys`/`deleteNamespace` do not need the key.
 */
export class EncryptedSecretVault {
  private readonly derivedKey: Buffer | undefined;

  constructor(
    private readonly backend: SecretBackend,
    masterKey?: string,
  ) {
    this.derivedKey =
      masterKey !== undefined && masterKey !== ""
        ? deriveKey(masterKey)
        : undefined;
  }

  /** Whether a master key was configured (i.e. secrets can be read/written). */
  get hasMasterKey(): boolean {
    return this.derivedKey !== undefined;
  }

  /** Encrypts and stores a secret value under `(pluginId, key)`. */
  async set(pluginId: string, key: string, value: string): Promise<void> {
    const blob = encryptSecret(value, this.requireKey());
    await this.backend.write(pluginId, key, blob);
  }

  /**
   * Returns the decrypted value for `(pluginId, key)`, or undefined if it is
   * unset. Empty-string values are treated as absent to match
   * {@link SecretStore} semantics.
   */
  async get(pluginId: string, key: string): Promise<string | undefined> {
    const blob = await this.backend.read(pluginId, key);
    if (blob === undefined) return undefined;
    const value = decryptSecret(blob, this.requireKey());
    return value === "" ? undefined : value;
  }

  /** Whether `(pluginId, key)` holds a non-empty value. */
  async has(pluginId: string, key: string): Promise<boolean> {
    return (await this.get(pluginId, key)) !== undefined;
  }

  /** Lists the stored secret keys for a plugin. Does not require a master key. */
  listKeys(pluginId: string): Promise<string[]> {
    return this.backend.listKeys(pluginId);
  }

  /** Removes a single secret. Does not require a master key. */
  delete(pluginId: string, key: string): Promise<void> {
    return this.backend.delete(pluginId, key);
  }

  /** Removes every secret a plugin owns. Does not require a master key. */
  deleteNamespace(pluginId: string): Promise<void> {
    return this.backend.deleteNamespace(pluginId);
  }

  private requireKey(): Buffer {
    if (this.derivedKey === undefined) {
      throw new MasterKeyRequiredError();
    }
    return this.derivedKey;
  }
}
