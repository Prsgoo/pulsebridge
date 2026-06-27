import { scanRedisKeys } from "./scanRedisKeys.js";
import type { Redis } from "ioredis";
import type { SecretBackend } from "../contracts/secrets/secretBackend.js";

export interface RedisSecretBackendOptions {
  client: Redis;
  /**
   * Key prefix. Allows multiple PulseBridge instances to coexist on one Redis.
   * @default "pb:secret:"
   */
  keyPrefix?: string;
}

/**
 * Redis-backed {@link SecretBackend}. Stores encrypted blobs as plain Redis
 * strings under `<prefix><namespace>:<key>`. The values are opaque ciphertext —
 * this backend never sees plaintext or the master key.
 *
 * Namespaces (plugin ids) and keys may themselves contain `:`, so listing and
 * namespace-deletion match on the namespace segment exactly rather than parsing
 * the composite Redis key.
 */
export class RedisSecretBackend implements SecretBackend {
  private readonly client: Redis;
  private readonly prefix: string;

  constructor(options: RedisSecretBackendOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? "pb:secret:";
  }

  async read(namespace: string, key: string): Promise<string | undefined> {
    const value = await this.client.get(this.redisKey(namespace, key));
    return value ?? undefined;
  }

  async write(namespace: string, key: string, blob: string): Promise<void> {
    await this.client.set(this.redisKey(namespace, key), blob);
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.client.del(this.redisKey(namespace, key));
  }

  async deleteNamespace(namespace: string): Promise<void> {
    const keys = await this.namespaceKeys(namespace);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }

  async listKeys(namespace: string): Promise<string[]> {
    const stripLength = this.namespacePrefix(namespace).length;
    const keys = await this.namespaceKeys(namespace);
    return keys.map((k) => k.slice(stripLength));
  }

  private redisKey(namespace: string, key: string): string {
    return `${this.namespacePrefix(namespace)}${key}`;
  }

  private namespacePrefix(namespace: string): string {
    return `${this.prefix}${namespace}:`;
  }

  /** Full Redis keys belonging to `namespace`. */
  private namespaceKeys(namespace: string): Promise<string[]> {
    const pattern = `${escapeRedisGlob(this.namespacePrefix(namespace))}*`;
    return scanRedisKeys(this.client, pattern);
  }
}

/** Backslash-escapes the Redis glob metacharacters `* ? [ ] \`. */
function escapeRedisGlob(literal: string): string {
  return literal.replace(/[*?[\]\\]/g, (ch) => `\\${ch}`);
}
