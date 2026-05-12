import type { PulseRecord } from "../records/pulseRecord.js";

/** Bucket key used by RecordStore.append() for records not attributed to a specific plugin. */
export const APPEND_BUCKET = "__append__";

export interface RecordStore {
  append(records: ReadonlyArray<PulseRecord>): Promise<void>;
  setByPlugin(
    pluginId: string,
    records: ReadonlyArray<PulseRecord>,
  ): Promise<void>;
  getAll(): Promise<ReadonlyArray<PulseRecord>>;
  getByType(recordType: string): Promise<ReadonlyArray<PulseRecord>>;
  clear(): Promise<void>;
}
