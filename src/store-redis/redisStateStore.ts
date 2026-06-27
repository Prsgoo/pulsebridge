import type { Redis } from "ioredis";
import type { StateStore } from "../contracts/storage/stateStore.js";

export interface RedisStateStoreOptions {
  client: Redis;
  /**
   * Key prefix. Allows multiple PulseBridge instances to coexist on one Redis.
   * @default "pb:state:"
   */
  keyPrefix?: string;
}

/**
 * Redis-backed StateStore. Plugin state persists across process restarts,
 * making it suitable for stateful processors like price delta trackers.
 *
 * Keys are stored as plain Redis strings. Plugins are responsible for
 * namespacing their own keys within the store.
 */
export class RedisStateStore implements StateStore {
  private readonly client: Redis;
  private readonly prefix: string;

  constructor(options: RedisStateStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? "pb:state:";
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(this.key(key));
    return value ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(this.key(key), value);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.key(key));
  }
}
