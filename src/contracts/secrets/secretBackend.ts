/**
 * Pluggable storage for encrypted secret blobs, the same way records, views,
 * and state already have swappable backends (in-memory vs Redis).
 *
 * A backend stores and returns OPAQUE strings — it never sees plaintext and
 * never holds the master key. All encryption/decryption happens above it in
 * the {@link EncryptedSecretVault}. A backend implementation must therefore
 * make no assumptions about the shape of the values it stores.
 *
 * Secrets are namespaced by owning plugin id, so the identity of a secret is
 * the pair `(namespace, key)`. This makes cross-plugin access impossible by
 * construction: a plugin's vault view is built only from its own namespace.
 */
export interface SecretBackend {
  /** Returns the stored blob for `(namespace, key)`, or undefined if unset. */
  read(namespace: string, key: string): Promise<string | undefined>;

  /** Stores `blob` under `(namespace, key)`, overwriting any existing value. */
  write(namespace: string, key: string, blob: string): Promise<void>;

  /** Removes a single `(namespace, key)`. No-ops if it does not exist. */
  delete(namespace: string, key: string): Promise<void>;

  /** Removes every key in `namespace`. No-ops if the namespace is empty. */
  deleteNamespace(namespace: string): Promise<void>;

  /** Lists the keys present in `namespace`. Order is not guaranteed. */
  listKeys(namespace: string): Promise<string[]>;
}
