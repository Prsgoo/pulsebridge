import type { PulseViewRecord } from "../contracts/records/pulseViewRecord.js";
import type { ViewStore } from "../contracts/storage/viewStore.js";

export class InMemoryViewStore implements ViewStore {
  private readonly views = new Map<string, PulseViewRecord>();

  async clear(): Promise<void> {
    this.views.clear();
  }

  async set(view: PulseViewRecord): Promise<void> {
    this.views.set(view.view, view);
  }

  async get(viewName: string): Promise<PulseViewRecord | undefined> {
    return this.views.get(viewName);
  }

  async getAll(): Promise<ReadonlyArray<PulseViewRecord>> {
    return Array.from(this.views.values());
  }
}
