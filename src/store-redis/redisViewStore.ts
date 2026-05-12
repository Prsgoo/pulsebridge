import type { Redis } from "ioredis";
import { ConsoleLogger } from "../runtime/consoleLogger.js";
import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { PulseViewRecord } from "../contracts/records/pulseViewRecord.js";
import type { ViewStore } from "../contracts/storage/viewStore.js";
import { scanRedisKeys } from "./scanRedisKeys.js";
import { withFallback } from "./withFallback.js";

export interface RedisViewStoreOptions {
  client: Redis;
  /** Key prefix for all Redis keys. Allows multiple PulseBridge instances to coexist on one Redis. Default: "pb:" */
  keyPrefix?: string;
  /** Optional TTL in seconds applied to each view on write. Prevents stale views from living indefinitely. Default: 3600 (1 hour) */
  ttlSeconds?: number;
  /** Logger for warnings and errors. Defaults to console if not provided. */
  logger?: PulseLogger;
  /**
   * Fallback store used transparently when Redis is unavailable.
   * On any Redis error, the operation is retried against this store and a warning is logged.
   * Useful with `InMemoryViewStore` to keep views readable during Redis outages.
   */
  fallback?: ViewStore;
}

export class RedisViewStore implements ViewStore {
  private readonly client: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly logger: PulseLogger;
  private readonly fallback: ViewStore | undefined;

  constructor(options: RedisViewStoreOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? "pb:";
    this.ttlSeconds = options.ttlSeconds ?? 3600;
    this.fallback = options.fallback;
    this.logger = options.logger ?? new ConsoleLogger();
  }

  private viewKey(viewName: string): string {
    return `${this.keyPrefix}views:${viewName}`;
  }

  async set(view: PulseViewRecord): Promise<void> {
    await withFallback(
      this.logger,
      async () => {
        const key = this.viewKey(view.view);
        await this.client.set(key, JSON.stringify(view), "EX", this.ttlSeconds);
      },
      async () => {
        await this.fallback?.set(view);
      },
      "[RedisViewStore] set failed",
      { viewName: view.view },
    );
  }

  async get(viewName: string): Promise<PulseViewRecord | undefined> {
    return withFallback(
      this.logger,
      async () => {
        const raw = await this.client.get(this.viewKey(viewName));
        if (raw === null) return undefined;
        try {
          return JSON.parse(raw) as PulseViewRecord;
        } catch {
          this.logger.warn("[RedisViewStore] Skipping malformed view entry.", {
            viewName,
          });
          return undefined;
        }
      },
      async () => this.fallback?.get(viewName),
      "[RedisViewStore] get failed",
      { viewName },
    );
  }

  async getAll(): Promise<ReadonlyArray<PulseViewRecord>> {
    return withFallback(
      this.logger,
      async () => {
        const pattern = this.viewKey("*");
        const keys = await this.scanKeys(pattern);
        if (keys.length === 0) return [];

        const pipeline = this.client.pipeline();
        for (const key of keys) {
          pipeline.get(key);
        }

        const results = await pipeline.exec();
        const views: PulseViewRecord[] = [];

        for (const result of results ?? []) {
          const [err, raw] = result as [Error | null, string | null];
          if (err) {
            this.logger.warn("[RedisViewStore] Failed to fetch view.", {
              error: err.message,
            });
            continue;
          }
          if (typeof raw !== "string") continue;
          try {
            views.push(JSON.parse(raw) as PulseViewRecord);
          } catch {
            this.logger.warn(
              "[RedisViewStore] Skipping malformed view entry in getAll.",
            );
          }
        }

        return views;
      },
      async () => this.fallback?.getAll() ?? [],
      "[RedisViewStore] getAll failed",
    );
  }

  async clear(): Promise<void> {
    await withFallback(
      this.logger,
      async () => {
        const pattern = this.viewKey("*");
        const keys = await this.scanKeys(pattern);
        if (keys.length > 0) {
          await this.client.del(...keys);
        }
      },
      async () => {
        await this.fallback?.clear();
      },
      "[RedisViewStore] clear failed",
    );
  }

  private scanKeys(pattern: string): Promise<string[]> {
    return scanRedisKeys(this.client, pattern);
  }
}
