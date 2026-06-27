import type { PulseRecord } from "../contracts/records/pulseRecord.js";
import { APPEND_BUCKET } from "../contracts/storage/recordStore.js";
import type { RecordStore } from "../contracts/storage/recordStore.js";

export interface InMemoryRecordStoreOptions {
  /**
   * Maximum number of records to retain per plugin bucket.
   * When the limit is exceeded, the oldest records are dropped.
   * Defaults to unlimited.
   */
  maxRecordsPerPlugin?: number;
}

export class InMemoryRecordStore implements RecordStore {
  private readonly buckets = new Map<string, PulseRecord[]>();
  private readonly typeIndex = new Map<string, PulseRecord[]>();
  private readonly maxRecordsPerPlugin: number | undefined;

  constructor(options: InMemoryRecordStoreOptions = {}) {
    this.maxRecordsPerPlugin = options.maxRecordsPerPlugin;
  }

  async clear(): Promise<void> {
    this.buckets.clear();
    this.typeIndex.clear();
  }

  /** Accumulates records into a shared bucket for direct store consumers. */
  async append(records: ReadonlyArray<PulseRecord>): Promise<void> {
    const existing = this.buckets.get(APPEND_BUCKET) ?? [];
    this.buckets.set(APPEND_BUCKET, [...existing, ...records]);
    for (const record of records) {
      const bucket = this.typeIndex.get(record.type) ?? [];
      bucket.push(record);
      this.typeIndex.set(record.type, bucket);
    }
  }

  /** Replaces all records previously written by a specific plugin. Safe to call in parallel
   *  across different pluginIds — each plugin owns its own bucket. */
  async setByPlugin(
    pluginId: string,
    records: ReadonlyArray<PulseRecord>,
  ): Promise<void> {
    const oldRecords = this.buckets.get(pluginId) ?? [];
    this.buckets.set(pluginId, this.cap([...records]));
    this.rebuildTypeIndex(pluginId, oldRecords, records);
  }

  async getAll(): Promise<ReadonlyArray<PulseRecord>> {
    const all: PulseRecord[] = [];
    for (const records of this.buckets.values()) {
      all.push(...records);
    }
    return all;
  }

  async getByType(recordType: string): Promise<ReadonlyArray<PulseRecord>> {
    return this.typeIndex.get(recordType) ?? [];
  }

  private cap(records: PulseRecord[]): PulseRecord[] {
    if (this.maxRecordsPerPlugin === undefined) return records;
    return records.length > this.maxRecordsPerPlugin
      ? records.slice(records.length - this.maxRecordsPerPlugin)
      : records;
  }

  /**
   * Updates the type index when a plugin replaces its records.
   * Removes the old records' contributions and adds the new ones.
   */
  private rebuildTypeIndex(
    pluginId: string,
    oldRecords: ReadonlyArray<PulseRecord>,
    newRecords: ReadonlyArray<PulseRecord>,
  ): void {
    const affectedTypes = new Set(oldRecords.map((r) => r.type));
    for (const record of newRecords) {
      affectedTypes.add(record.type);
    }

    const oldSet = new Set(oldRecords);
    for (const type of affectedTypes) {
      const retained = (this.typeIndex.get(type) ?? []).filter(
        (r) => !oldSet.has(r),
      );
      const added = newRecords.filter((r) => r.type === type);
      const merged = [...retained, ...added];
      if (merged.length > 0) {
        this.typeIndex.set(type, merged);
      } else {
        this.typeIndex.delete(type);
      }
    }
  }
}
