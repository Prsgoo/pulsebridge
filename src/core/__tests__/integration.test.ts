/**
 * Integration tests — exercises the full platform flow using real in-memory implementations.
 * These tests do not mock anything inside the platform boundary.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PulseBridgeCore } from "../pulseBridgeCore.js";
import { InMemoryTokenStore } from "../../contracts/tokens/inMemoryTokenStore.js";
import type { IntegrationPlugin } from "../../plugin-sdk/integrationPlugin.js";
import type { ProcessorPlugin } from "../../plugin-sdk/processorPlugin.js";
import type { PulseRecord } from "../../contracts/records/pulseRecord.js";
import type { PulseViewRecord } from "../../contracts/records/pulseViewRecord.js";
import type { RuntimeContext } from "../../contracts/runtime/runtimeContext.js";

interface SensorReading {
  sensorId: string;
  value: number;
}

interface SensorSummary {
  count: number;
  average: number;
  readings: Array<{ sensorId: string; value: number }>;
}

const SENSOR_INTEGRATION_ID = "test-integration/sensor";
const SENSOR_PROCESSOR_ID = "test-processor/sensor-summary";
const VIEW_SENSOR_SUMMARY = "sensor.summary";
const RECORD_TYPE_SENSOR = "sensor.reading";

function makeSensorIntegration(readings: SensorReading[]): IntegrationPlugin {
  return {
    manifest: {
      id: SENSOR_INTEGRATION_ID,
      name: "Sensor Integration",
      version: "1.0.0",
      kind: "integration",
      operations: [
        {
          id: "poll",
          name: "Poll sensors",
          recordType: RECORD_TYPE_SENSOR,
        },
      ],
      polling: { defaultIntervalMs: 60_000, hard: true },
    },
    async execute(
      _operationId: string,
      context: RuntimeContext,
    ): Promise<ReadonlyArray<PulseRecord>> {
      return readings.map((r) => ({
        type: RECORD_TYPE_SENSOR,
        timestamp: context.now().toISOString(),
        source: SENSOR_INTEGRATION_ID,
        data: r,
      }));
    },
  };
}

function makeSensorProcessor(): ProcessorPlugin {
  return {
    manifest: {
      id: SENSOR_PROCESSOR_ID,
      name: "Sensor Summary Processor",
      version: "1.0.0",
      kind: "processor",
      consumes: [RECORD_TYPE_SENSOR],
      produces: [VIEW_SENSOR_SUMMARY],
      providesCapabilities: [],
    },
    async process(
      records: ReadonlyArray<PulseRecord>,
    ): Promise<PulseViewRecord<SensorSummary> | null> {
      if (records.length === 0) return null;
      const readings = records.map((r) => r.data as SensorReading);
      const total = readings.reduce((sum, r) => sum + r.value, 0);
      const summary: SensorSummary = {
        count: readings.length,
        average: total / readings.length,
        readings: readings.map((r) => ({
          sensorId: r.sensorId,
          value: r.value,
        })),
      };
      return {
        view: VIEW_SENSOR_SUMMARY,
        generatedAt: new Date().toISOString(),
        items: [summary],
      };
    },
  };
}

describe("Platform integration — start() full flow", () => {
  let core: PulseBridgeCore;

  beforeEach(() => {
    vi.useFakeTimers();
    core = new PulseBridgeCore();
  });

  afterEach(async () => {
    if (core.isRunning) await core.stop();
    vi.useRealTimers();
  });

  it("produces a view from integration records through a processor", async () => {
    const readings: SensorReading[] = [
      { sensorId: "A", value: 10 },
      { sensorId: "B", value: 20 },
    ];

    await core.registerIntegration(makeSensorIntegration(readings));
    await core.registerProcessor(makeSensorProcessor());
    await core.start();
    await core.waitForReady();

    const view = await core.getView(VIEW_SENSOR_SUMMARY);
    expect(view).toBeDefined();
    if (!view) return;
    const summaries = view.items as ReadonlyArray<SensorSummary>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ count: 2, average: 15 });
    expect(summaries[0]?.readings).toHaveLength(2);
  });

  it("auto-registers manifest operations — no explicit registerIntegrationOperation needed", async () => {
    await core.registerIntegration(
      makeSensorIntegration([{ sensorId: "X", value: 42 }]),
    );
    await core.registerProcessor(makeSensorProcessor());
    await core.start();
    await core.waitForReady();

    const records = await core.getRecords();
    expect(records).toHaveLength(1);
  });
});

describe("Platform integration — processor state tracking", () => {
  it("sets processor status to enabled after successful execution", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    await core.registerIntegration(
      makeSensorIntegration([{ sensorId: "A", value: 1 }]),
    );
    await core.registerProcessor(makeSensorProcessor());

    const beforeRun = core.getPluginState(SENSOR_PROCESSOR_ID);
    expect(beforeRun?.status).toBe("enabled");

    await core.start();
    await core.waitForReady();

    const afterRun = core.getPluginState(SENSOR_PROCESSOR_ID);
    expect(afterRun?.status).toBe("enabled");
    expect(afterRun?.lastRunAt).toBeDefined();

    await core.stop();
    vi.useRealTimers();
  });

  it("sets processor status to degraded when process() throws", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    await core.registerIntegration(
      makeSensorIntegration([{ sensorId: "A", value: 1 }]),
    );
    await core.registerProcessor({
      ...makeSensorProcessor(),
      async process() {
        throw new Error("processor boom");
      },
    });

    await core.start();
    await core.waitForReady();

    const state = core.getPluginState(SENSOR_PROCESSOR_ID);
    expect(state?.status).toBe("degraded");
    expect(state?.lastError).toBe("processor boom");

    await core.stop();
    vi.useRealTimers();
  });
});

describe("Platform integration — getHealth()", () => {
  it("returns healthy when all plugins are enabled and running", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    await core.registerIntegration(
      makeSensorIntegration([{ sensorId: "A", value: 1 }]),
    );
    await core.registerProcessor(makeSensorProcessor());
    await core.start();

    const health = core.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.running).toBe(true);
    expect(health.plugins.every((p) => p.status === "enabled")).toBe(true);

    await core.stop();
    vi.useRealTimers();
  });

  it("returns degraded when any plugin is degraded", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    await core.registerIntegration({
      ...makeSensorIntegration([]),
      async execute() {
        throw new Error("bang");
      },
    });
    await core.registerProcessor(makeSensorProcessor());
    await core.start();
    await core.waitForReady();

    const integrationState = core.getPluginState(SENSOR_INTEGRATION_ID);
    expect(integrationState?.status).toBe("degraded");

    await core.stop();
    vi.useRealTimers();
  });
});

describe("Platform integration — provisioned secrets", () => {
  it("hands a provisioned secret to the plugin's scoped context", async () => {
    vi.useFakeTimers();
    const secretKey = "TEST_API_KEY";
    const secretValue = "provisioned-secret-value";
    const core = new PulseBridgeCore({ masterKey: "test-master-key" });
    let capturedSecret: string | undefined;

    await core.registerIntegration({
      manifest: {
        id: "test-secret-integration",
        name: "Secret Test Integration",
        version: "1.0.0",
        kind: "integration",
        operations: [
          {
            id: "fetch",
            name: "Fetch",
            recordType: "test.record",
          },
        ],
        auth: {
          type: "apiKey",
          secrets: [{ key: secretKey, required: true }],
        },
        polling: { defaultIntervalMs: 60_000, hard: true },
      },
      async execute(
        _op: string,
        context: RuntimeContext,
      ): Promise<ReadonlyArray<PulseRecord>> {
        capturedSecret = context.secrets.get(secretKey);
        return [];
      },
    });

    await core.provision("test-secret-integration", {
      [secretKey]: secretValue,
    });

    await core.start();
    await core.waitForReady();
    expect(capturedSecret).toBe(secretValue);
    await core.stop();
    vi.useRealTimers();
  });
});

describe("Platform integration — OAuth2 TokenStore", () => {
  it("proactively sets needs_reauth when a stored token is expired", async () => {
    vi.useFakeTimers();
    const tokenStore = new InMemoryTokenStore();
    const core = new PulseBridgeCore({ tokens: tokenStore });

    const integration: IntegrationPlugin = {
      ...makeSensorIntegration([{ sensorId: "A", value: 1 }]),
      manifest: {
        ...makeSensorIntegration([]).manifest,
        auth: { type: "oauth2" },
      },
    };
    await core.registerIntegration(integration);
    await core.registerProcessor(makeSensorProcessor());

    tokenStore.set(SENSOR_INTEGRATION_ID, {
      accessToken: "expired-token",
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });

    await core.start();
    await core.waitForReady();

    const state = core.getPluginState(SENSOR_INTEGRATION_ID);
    expect(state?.status).toBe("needs_reauth");

    await core.stop();
    vi.useRealTimers();
  });

  it("executes normally when token is not expired", async () => {
    vi.useFakeTimers();
    const tokenStore = new InMemoryTokenStore();
    const core = new PulseBridgeCore({ tokens: tokenStore });

    const integration = makeSensorIntegration([{ sensorId: "A", value: 1 }]);
    await core.registerIntegration(integration);
    await core.registerProcessor(makeSensorProcessor());

    tokenStore.set(SENSOR_INTEGRATION_ID, {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await core.start();
    await core.waitForReady();

    const state = core.getPluginState(SENSOR_INTEGRATION_ID);
    expect(state?.status).toBe("enabled");

    await core.stop();
    vi.useRealTimers();
  });
});

describe("Platform integration — processor chaining (consumesViews)", () => {
  it("passes upstream view data to a chained processor", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    await core.registerIntegration(
      makeSensorIntegration([{ sensorId: "A", value: 5 }]),
    );
    await core.registerProcessor(makeSensorProcessor());

    let receivedViews: ReadonlyArray<PulseViewRecord> | undefined;

    await core.registerProcessor({
      manifest: {
        id: "test-processor/chained",
        name: "Chained Processor",
        version: "1.0.0",
        kind: "processor",
        consumes: [],
        produces: ["chained.output"],
        consumesViews: [VIEW_SENSOR_SUMMARY],
      },
      async process(
        _records: ReadonlyArray<PulseRecord>,
        _context: RuntimeContext,
        views?: ReadonlyArray<PulseViewRecord>,
      ): Promise<PulseViewRecord | null> {
        receivedViews = views;
        return null;
      },
    });

    await core.start();
    await core.waitForReady();

    expect(receivedViews).toBeDefined();
    expect(receivedViews).toHaveLength(1);
    expect(receivedViews?.at(0)?.view).toBe(VIEW_SENSOR_SUMMARY);

    await core.stop();
    vi.useRealTimers();
  });
});

describe("Platform integration — maxRecordsPerPlugin", () => {
  it("caps records to maxRecordsPerPlugin when limit is set", async () => {
    vi.useFakeTimers();
    const { InMemoryRecordStore } =
      await import("../../storage/inMemoryRecordStore.js");
    const { InMemoryViewStore } =
      await import("../../storage/inMemoryViewStore.js");

    const core = new PulseBridgeCore({
      store: {
        records: new InMemoryRecordStore({ maxRecordsPerPlugin: 2 }),
        views: new InMemoryViewStore(),
      },
    });

    const readings: SensorReading[] = [
      { sensorId: "A", value: 1 },
      { sensorId: "B", value: 2 },
      { sensorId: "C", value: 3 },
    ];

    await core.registerIntegration(makeSensorIntegration(readings));
    await core.registerProcessor(makeSensorProcessor());
    await core.start();
    await core.waitForReady();

    const records = await core.getRecords();
    expect(records).toHaveLength(2);
    const sensorIds = (records as PulseRecord<SensorReading>[]).map(
      (r) => r.data.sensorId,
    );
    expect(sensorIds).toContain("B");
    expect(sensorIds).toContain("C");

    await core.stop();
    vi.useRealTimers();
  });
});
