import type { Redis } from "ioredis";
import { ConsoleLogger } from "../runtime/consoleLogger.js";
import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { PulseRecord } from "../contracts/records/pulseRecord.js";
import { APPEND_BUCKET } from "../contracts/storage/recordStore.js";
import type { RecordStore } from "../contracts/storage/recordStore.js";
import { scanRedisKeys } from "./scanRedisKeys.js";
import { withFallback } from "./withFallback.js";

export interface RedisRecordStoreOptions {
  client: Redis;
  /** Key prefix for all Redis keys. Allows multiple PulseBridge instances to coexist on one Redis. Default: "pb:" */
  keyPrefix?: string;
  /** Logger for warnings and errors. Defaults to console if not provided. */
  logger?: PulseLogger;
  /**
   * Fallback store used transparently when Redis is unavailable.
   * On any Redis error, the operation is retried against this store and a warning is logged.
   * Reads prefer Redis; if Redis fails, they fall back here.
   * Useful with `InMemoryRecordStore` to keep the platform running during Redis outages.
   */
  fallback?: RecordStore;
}

/**
 * Redis key layout:
 *
 *   pb:records:<pluginId>             — primary plugin bucket (for getAll)
 *   pb:type:<recordType>:<pluginId>   — type index: records of this type from this plugin
 *   pb:type-plugins:<recordType>      — Set of pluginIds that have produced this type
 *   pb:plugin-types:<pluginId>        — Set of types this plugin has produced
 *
 * getByType reads pb:type-plugins:<type> → pipeline-reads pb:type:<type>:<pluginId> for each.
 * No full scan, no in-memory filter.
 */
export class RedisRecordStore implements RecordStore {
  private readonly client: Redis;
  private readonly keyPrefix: string;
  private readonly logger: PulseLogger;
  private readonly fallback: RecordStore | undefined;

  private readonly pluginWriteQueues = new Map<string, Promise<void>>();

  constructor(options: RedisRecordStoreOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? "pb:";
    this.fallback = options.fallback;
    this.logger = options.logger ?? new ConsoleLogger();
  }

  private bucketKey(pluginId: string): string {
    return `${this.keyPrefix}records:${pluginId}`;
  }

  private typePluginKey(recordType: string, pluginId: string): string {
    return `${this.keyPrefix}type:${recordType}:${pluginId}`;
  }

  private typePluginsSetKey(recordType: string): string {
    return `${this.keyPrefix}type-plugins:${recordType}`;
  }

  private pluginTypesSetKey(pluginId: string): string {
    return `${this.keyPrefix}plugin-types:${pluginId}`;
  }

  async append(records: ReadonlyArray<PulseRecord>): Promise<void> {
    if (records.length === 0) return;
    await withFallback(
      this.logger,
      async () => {
        const serialized = records.map((r) => JSON.stringify(r));
        const byType = groupByType(records);

        const multi = this.client.multi();
        multi.rpush(this.bucketKey(APPEND_BUCKET), ...serialized);
        for (const [type, typed] of byType) {
          multi.sadd(this.typePluginsSetKey(type), APPEND_BUCKET);
          multi.rpush(
            this.typePluginKey(type, APPEND_BUCKET),
            ...typed.map((r) => JSON.stringify(r)),
          );
          multi.sadd(this.pluginTypesSetKey(APPEND_BUCKET), type);
        }
        await multi.exec();
      },
      async () => {
        await this.fallback?.append(records);
      },
      "[RedisRecordStore] append failed",
    );
  }

  async setByPlugin(
    pluginId: string,
    records: ReadonlyArray<PulseRecord>,
  ): Promise<void> {
    const prev = this.pluginWriteQueues.get(pluginId) ?? Promise.resolve();
    const current = prev.then(() => this.doSetByPlugin(pluginId, records));
    this.pluginWriteQueues.set(
      pluginId,
      current.then(
        () => {},
        () => {},
      ),
    );
    return current;
  }

  private async doSetByPlugin(
    pluginId: string,
    records: ReadonlyArray<PulseRecord>,
  ): Promise<void> {
    await withFallback(
      this.logger,
      async () => {
        const oldTypes = new Set(
          await this.client.smembers(this.pluginTypesSetKey(pluginId)),
        );
        const newByType = groupByType(records);
        const newTypes = new Set(newByType.keys());

        const multi = this.client.multi();

        multi.del(this.bucketKey(pluginId));
        if (records.length > 0) {
          multi.rpush(
            this.bucketKey(pluginId),
            ...records.map((r) => JSON.stringify(r)),
          );
        }

        for (const type of oldTypes) {
          if (!newTypes.has(type)) {
            multi.srem(this.typePluginsSetKey(type), pluginId);
            multi.del(this.typePluginKey(type, pluginId));
          }
        }

        for (const [type, typed] of newByType) {
          multi.sadd(this.typePluginsSetKey(type), pluginId);
          multi.del(this.typePluginKey(type, pluginId));
          multi.rpush(
            this.typePluginKey(type, pluginId),
            ...typed.map((r) => JSON.stringify(r)),
          );
        }

        multi.del(this.pluginTypesSetKey(pluginId));
        if (newTypes.size > 0) {
          multi.sadd(this.pluginTypesSetKey(pluginId), ...newTypes);
        }

        const execResult = await multi.exec();
        if (execResult === null) {
          if (this.fallback) {
            this.logger.warn(
              "[RedisRecordStore] setByPlugin transaction aborted — falling back to in-memory store.",
              { pluginId },
            );
            await this.fallback.setByPlugin(pluginId, records);
          } else {
            throw new Error(
              `[RedisRecordStore] setByPlugin transaction aborted for plugin '${pluginId}' and no fallback store is configured.`,
            );
          }
        }
      },
      async () => {
        await this.fallback?.setByPlugin(pluginId, records);
      },
      "[RedisRecordStore] setByPlugin failed",
      { pluginId },
    );
  }

  async getAll(): Promise<ReadonlyArray<PulseRecord>> {
    return withFallback(
      this.logger,
      async () => {
        const pattern = this.bucketKey("*");
        const keys = await this.scanKeys(pattern);
        if (keys.length === 0) return [];

        const pipeline = this.client.pipeline();
        for (const key of keys) {
          pipeline.lrange(key, 0, -1);
        }

        const results = await pipeline.exec();
        const records: PulseRecord[] = [];

        for (const result of results ?? []) {
          const [err, values] = result as [Error | null, string[]];
          if (err) {
            this.logger.warn("[RedisRecordStore] Failed to fetch bucket.", {
              error: err.message,
            });
            continue;
          }
          if (!Array.isArray(values)) continue;
          for (const raw of values) {
            if (typeof raw !== "string") continue;
            try {
              records.push(JSON.parse(raw) as PulseRecord);
            } catch {
              this.logger.warn(
                "[RedisRecordStore] Skipping malformed record entry.",
              );
            }
          }
        }

        return records;
      },
      async () => this.fallback?.getAll() ?? [],
      "[RedisRecordStore] getAll failed",
    );
  }

  async getByType(recordType: string): Promise<ReadonlyArray<PulseRecord>> {
    return withFallback(
      this.logger,
      async () => {
        const pluginIds = await this.client.smembers(
          this.typePluginsSetKey(recordType),
        );
        if (pluginIds.length === 0) return [];

        const pipeline = this.client.pipeline();
        for (const pluginId of pluginIds) {
          pipeline.lrange(this.typePluginKey(recordType, pluginId), 0, -1);
        }

        const results = await pipeline.exec();
        const records: PulseRecord[] = [];

        for (const result of results ?? []) {
          const [err, values] = result as [Error | null, string[]];
          if (err) {
            this.logger.warn(
              "[RedisRecordStore] Failed to fetch type index bucket.",
              { recordType, error: err.message },
            );
            continue;
          }
          if (!Array.isArray(values)) continue;
          for (const raw of values) {
            if (typeof raw !== "string") continue;
            try {
              records.push(JSON.parse(raw) as PulseRecord);
            } catch {
              this.logger.warn(
                "[RedisRecordStore] Skipping malformed record in type index.",
              );
            }
          }
        }

        return records;
      },
      async () => this.fallback?.getByType(recordType) ?? [],
      "[RedisRecordStore] getByType failed",
      { recordType },
    );
  }

  async clear(): Promise<void> {
    await withFallback(
      this.logger,
      async () => {
        const patterns = [
          this.bucketKey("*"),
          `${this.keyPrefix}type:*`,
          `${this.keyPrefix}type-plugins:*`,
          `${this.keyPrefix}plugin-types:*`,
        ];
        const keyArrays = await Promise.all(
          patterns.map((p) => this.scanKeys(p)),
        );
        const keys = keyArrays.flat();
        if (keys.length > 0) {
          await this.client.del(...keys);
        }
      },
      async () => {
        await this.fallback?.clear();
      },
      "[RedisRecordStore] clear failed",
    );
  }

  private scanKeys(pattern: string): Promise<string[]> {
    return scanRedisKeys(this.client, pattern);
  }
}

/** Groups records by their `type` field. */
function groupByType(
  records: ReadonlyArray<PulseRecord>,
): Map<string, PulseRecord[]> {
  const map = new Map<string, PulseRecord[]>();
  for (const record of records) {
    const bucket = map.get(record.type);
    if (bucket) {
      bucket.push(record);
    } else {
      map.set(record.type, [record]);
    }
  }
  return map;
}
