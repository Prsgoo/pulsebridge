import type { StateStore } from "../contracts/storage/stateStore.js";

/**
 * In-memory StateStore implementation. State is lost on process restart.
 * Use RedisStateStore for persistence across restarts.
 */
export class InMemoryStateStore implements StateStore {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
