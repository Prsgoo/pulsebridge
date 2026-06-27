import type { SecretBackend } from "./secretBackend.js";

/**
 * In-memory {@link SecretBackend} for development and tests. Stores encrypted
 * blobs in a nested Map keyed by namespace then key. Not persistent — values
 * are lost when the process exits.
 */
export class InMemorySecretBackend implements SecretBackend {
  private readonly namespaces = new Map<string, Map<string, string>>();

  read(namespace: string, key: string): Promise<string | undefined> {
    return Promise.resolve(this.namespaces.get(namespace)?.get(key));
  }

  write(namespace: string, key: string, blob: string): Promise<void> {
    let bucket = this.namespaces.get(namespace);
    if (!bucket) {
      bucket = new Map<string, string>();
      this.namespaces.set(namespace, bucket);
    }
    bucket.set(key, blob);
    return Promise.resolve();
  }

  delete(namespace: string, key: string): Promise<void> {
    const bucket = this.namespaces.get(namespace);
    bucket?.delete(key);
    if (bucket && bucket.size === 0) {
      this.namespaces.delete(namespace);
    }
    return Promise.resolve();
  }

  deleteNamespace(namespace: string): Promise<void> {
    this.namespaces.delete(namespace);
    return Promise.resolve();
  }

  listKeys(namespace: string): Promise<string[]> {
    const bucket = this.namespaces.get(namespace);
    return Promise.resolve(bucket ? [...bucket.keys()] : []);
  }
}
