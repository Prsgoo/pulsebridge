import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRecordStore } from "../inMemoryRecordStore.js";
import { InMemoryViewStore } from "../inMemoryViewStore.js";
import type { PulseRecord } from "../../contracts/records/pulseRecord.js";
import type { PulseViewRecord } from "../../contracts/records/pulseViewRecord.js";

const makeRecord = (type: string, source = "test"): PulseRecord => ({
  type,
  timestamp: new Date().toISOString(),
  source,
  data: {},
});

const makeView = (view: string): PulseViewRecord => ({
  view,
  generatedAt: new Date().toISOString(),
  items: [],
});

describe("InMemoryRecordStore", () => {
  let store: InMemoryRecordStore;

  beforeEach(() => {
    store = new InMemoryRecordStore();
  });

  it("starts empty", async () => {
    expect(await store.getAll()).toHaveLength(0);
  });

  it("appends records and returns them all", async () => {
    await store.append([
      makeRecord("plane.observation"),
      makeRecord("plane.observation"),
    ]);
    expect(await store.getAll()).toHaveLength(2);
  });

  it("accumulates across multiple appends", async () => {
    await store.append([makeRecord("plane.observation")]);
    await store.append([makeRecord("plane.observation")]);
    expect(await store.getAll()).toHaveLength(2);
  });

  it("returns records filtered by type", async () => {
    await store.append([
      makeRecord("plane.observation"),
      makeRecord("other.type"),
    ]);
    expect(await store.getByType("plane.observation")).toHaveLength(1);
    expect(await store.getByType("other.type")).toHaveLength(1);
  });

  it("returns empty array for an unknown type", async () => {
    await store.append([makeRecord("plane.observation")]);
    expect(await store.getByType("unknown")).toHaveLength(0);
  });

  it("clears all records", async () => {
    await store.append([makeRecord("plane.observation")]);
    await store.clear();
    expect(await store.getAll()).toHaveLength(0);
  });

  it("getByType returns only records of the requested type", async () => {
    await store.setByPlugin("plugin-a", [
      makeRecord("plane.observation"),
      makeRecord("airport.status"),
    ]);
    const planes = await store.getByType("plane.observation");
    expect(planes).toHaveLength(1);
    expect(planes[0]?.type).toBe("plane.observation");
  });

  it("getByType returns records across multiple plugins", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    await store.setByPlugin("plugin-b", [makeRecord("plane.observation")]);
    expect(await store.getByType("plane.observation")).toHaveLength(2);
  });

  it("getByType updates when a plugin replaces its records with different types", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    expect(await store.getByType("plane.observation")).toHaveLength(1);

    await store.setByPlugin("plugin-a", [makeRecord("airport.status")]);
    expect(await store.getByType("plane.observation")).toHaveLength(0);
    expect(await store.getByType("airport.status")).toHaveLength(1);
  });

  it("getByType includes records written via append", async () => {
    await store.append([makeRecord("plane.observation")]);
    expect(await store.getByType("plane.observation")).toHaveLength(1);
  });

  it("getByType returns empty array after clear", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    await store.clear();
    expect(await store.getByType("plane.observation")).toHaveLength(0);
  });

  it("setByPlugin replaces only this plugin's contribution to the type index", async () => {
    await store.setByPlugin("plugin-a", [makeRecord("plane.observation")]);
    await store.setByPlugin("plugin-b", [makeRecord("plane.observation")]);
    await store.setByPlugin("plugin-b", [makeRecord("airport.status")]);
    expect(await store.getByType("plane.observation")).toHaveLength(1);
  });
});

describe("InMemoryViewStore", () => {
  let store: InMemoryViewStore;

  beforeEach(() => {
    store = new InMemoryViewStore();
  });

  it("starts empty", async () => {
    expect(await store.getAll()).toHaveLength(0);
  });

  it("stores and retrieves a view by name", async () => {
    const view = makeView("planes.feed");
    await store.set(view);
    expect(await store.get("planes.feed")).toEqual(view);
  });

  it("returns undefined for an unknown view name", async () => {
    expect(await store.get("unknown")).toBeUndefined();
  });

  it("overwrites an existing view with the same name", async () => {
    await store.set(makeView("planes.feed"));
    const updated = {
      ...makeView("planes.feed"),
      generatedAt: "2099-01-01T00:00:00.000Z",
    };
    await store.set(updated);
    expect((await store.get("planes.feed"))?.generatedAt).toBe(
      "2099-01-01T00:00:00.000Z",
    );
  });

  it("returns all stored views", async () => {
    await store.set(makeView("planes.feed"));
    await store.set(makeView("other.view"));
    expect(await store.getAll()).toHaveLength(2);
  });

  it("clears all views", async () => {
    await store.set(makeView("planes.feed"));
    await store.clear();
    expect(await store.getAll()).toHaveLength(0);
  });
});
