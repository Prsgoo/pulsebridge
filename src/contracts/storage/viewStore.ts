import type { PulseViewRecord } from "../records/pulseViewRecord.js";

export interface ViewStore {
  set(view: PulseViewRecord): Promise<void>;
  get(viewName: string): Promise<PulseViewRecord | undefined>;
  getAll(): Promise<ReadonlyArray<PulseViewRecord>>;
  clear(): Promise<void>;
}
