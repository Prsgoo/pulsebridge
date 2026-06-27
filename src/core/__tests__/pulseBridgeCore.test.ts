import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { PulseBridgeCore } from "../pulseBridgeCore.js";
import { InMemoryTokenStore } from "../../contracts/tokens/inMemoryTokenStore.js";
import {
  PluginAuthError,
  RateLimitError,
  ReauthRequiredError,
} from "../../contracts/errors/pulseErrors.js";
import type { IntegrationPlugin } from "../../plugin-sdk/integrationPlugin.js";
import type { ProcessorPlugin } from "../../plugin-sdk/processorPlugin.js";
import type { PollingConfig } from "../../contracts/plugins/integrationPluginManifest.js";
import type { PulseRecord } from "../../contracts/records/pulseRecord.js";
import type { PulseViewRecord } from "../../contracts/records/pulseViewRecord.js";

const DEFAULT_OPERATION_ID = "fetch";

const makeRecord = (type: string): PulseRecord => ({
  type,
  timestamp: new Date().toISOString(),
  source: "test",
  data: {},
});

const makeIntegrationPlugin = (
  id = "test-integration",
  operationId = DEFAULT_OPERATION_ID,
  result: PulseRecord[] = [],
  secretKeys: Array<{ key: string; required: boolean }> = [],
  polling?: PollingConfig,
): IntegrationPlugin => ({
  manifest: {
    id,
    name: `${id} name`,
    version: "1.0.0",
    kind: "integration",
    operations: [
      {
        id: operationId,
        name: "Fetch",
        recordType: "test.record",
      },
    ],
    ...(secretKeys.length > 0
      ? {
          auth: {
            type: "apiKey",
            secrets: secretKeys.map((s) => ({
              key: s.key,
              required: s.required,
            })),
          },
        }
      : {}),
    ...(polling ? { polling } : {}),
  },
  execute: vi.fn().mockResolvedValue(result),
});

const makeProcessorPlugin = (
  id = "test-processor",
  viewName = "test.view",
  consumes: string[] = [],
): ProcessorPlugin => ({
  manifest: {
    id,
    name: `${id} name`,
    version: "1.0.0",
    kind: "processor",
    consumes,
    produces: [viewName],
    providesCapabilities: [],
  },
  process: vi.fn().mockResolvedValue({
    view: viewName,
    generatedAt: new Date().toISOString(),
    items: [],
  } as PulseViewRecord),
});

describe("PulseBridgeCore – registration", () => {
  let core: PulseBridgeCore;

  beforeEach(() => {
    core = new PulseBridgeCore();
  });

  it("registers an integration plugin", async () => {
    const plugin = makeIntegrationPlugin();
    await core.registerIntegration(plugin);
    expect(core.getIntegrationManifest("test-integration")).toBeDefined();
  });

  it("registers a processor plugin", async () => {
    const plugin = makeProcessorPlugin();
    await core.registerProcessor(plugin);
    expect(core.getProcessorManifest("test-processor")).toBeDefined();
  });

  it("throws when registering the same integration twice", async () => {
    const plugin = makeIntegrationPlugin();
    await core.registerIntegration(plugin);
    await expect(core.registerIntegration(plugin)).rejects.toThrow(
      "already registered",
    );
  });

  it("throws when registering the same processor twice", async () => {
    const plugin = makeProcessorPlugin();
    await core.registerProcessor(plugin);
    await expect(core.registerProcessor(plugin)).rejects.toThrow(
      "already registered",
    );
  });

  it("calls configure on the integration plugin when config is provided", async () => {
    const plugin = makeIntegrationPlugin();
    plugin.configure = vi.fn();
    await core.registerIntegration(plugin, { apiKey: "test" });
    expect(plugin.configure).toHaveBeenCalledWith({ apiKey: "test" });
  });

  it("calls configure on the processor plugin when config is provided", async () => {
    const plugin = makeProcessorPlugin();
    plugin.configure = vi.fn();
    await core.registerProcessor(plugin, { threshold: 10 });
    expect(plugin.configure).toHaveBeenCalledWith({ threshold: 10 });
  });

  it("lists registered integration manifests", async () => {
    await core.registerIntegration(makeIntegrationPlugin("int-a"));
    await core.registerIntegration(makeIntegrationPlugin("int-b"));
    expect(core.listIntegrationManifests()).toHaveLength(2);
  });

  it("lists registered processor manifests", async () => {
    await core.registerProcessor(makeProcessorPlugin("proc-a"));
    await core.registerProcessor(makeProcessorPlugin("proc-b"));
    expect(core.listProcessorManifests()).toHaveLength(2);
  });
});

describe("PulseBridgeCore – plugin state", () => {
  let core: PulseBridgeCore;

  beforeEach(() => {
    core = new PulseBridgeCore();
  });

  it("sets integration status to enabled after registration", async () => {
    await core.registerIntegration(makeIntegrationPlugin());
    expect(core.getPluginState("test-integration")?.status).toBe("enabled");
  });

  it("disables a plugin", async () => {
    await core.registerIntegration(makeIntegrationPlugin());
    core.disablePlugin("test-integration", "maintenance");
    expect(core.getPluginState("test-integration")?.status).toBe("disabled");
  });

  it("re-enables a disabled plugin", async () => {
    await core.registerIntegration(makeIntegrationPlugin());
    core.disablePlugin("test-integration");
    core.enablePlugin("test-integration");
    expect(core.getPluginState("test-integration")?.status).toBe("enabled");
  });

  it("isPluginEnabled returns true for unknown plugins", () => {
    expect(core.isPluginEnabled("unknown")).toBe(true);
  });

  it("isPluginEnabled returns false for disabled plugins", async () => {
    await core.registerIntegration(makeIntegrationPlugin());
    core.disablePlugin("test-integration");
    expect(core.isPluginEnabled("test-integration")).toBe(false);
  });

  it("lists all plugin states", async () => {
    await core.registerIntegration(makeIntegrationPlugin("int-a"));
    await core.registerIntegration(makeIntegrationPlugin("int-b"));
    expect(core.listPluginStates()).toHaveLength(2);
  });
});

describe("PulseBridgeCore – recommendsCapabilities", () => {
  it("logs a warning when an integration recommends an unprovided capability", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const core = new PulseBridgeCore({ logger });
    const integration: IntegrationPlugin = {
      ...makeIntegrationPlugin(),
      manifest: {
        ...makeIntegrationPlugin().manifest,
        recommendsCapabilities: ["planes.merge"],
      },
    };
    await core.registerIntegration(integration);
    core.validateCapabilities();
    expect(logger.warn).toHaveBeenCalledWith(
      "Plugin recommends a capability with no registered provider.",
      expect.objectContaining({ capability: "planes.merge" }),
    );
  });

  it("does not warn when the recommended capability is already provided", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const core = new PulseBridgeCore({ logger });
    const processor: ProcessorPlugin = {
      ...makeProcessorPlugin(),
      manifest: {
        ...makeProcessorPlugin().manifest,
        providesCapabilities: ["planes.merge"],
      },
    };
    await core.registerProcessor(processor);
    const integration: IntegrationPlugin = {
      ...makeIntegrationPlugin(),
      manifest: {
        ...makeIntegrationPlugin().manifest,
        recommendsCapabilities: ["planes.merge"],
      },
    };
    await core.registerIntegration(integration);
    core.validateCapabilities();
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Plugin recommends a capability with no registered provider.",
      expect.anything(),
    );
  });

  it("does not warn when recommendsCapabilities is not declared", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const core = new PulseBridgeCore({ logger });
    await core.registerIntegration(makeIntegrationPlugin());
    core.validateCapabilities();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("PulseBridgeCore – validateCapabilities", () => {
  it("throws when a required capability is not provided", async () => {
    const core = new PulseBridgeCore();
    const integration: IntegrationPlugin = {
      ...makeIntegrationPlugin(),
      manifest: {
        ...makeIntegrationPlugin().manifest,
        requiresCapabilities: ["planes.feed"],
      },
    };
    await core.registerIntegration(integration);
    expect(() => core.validateCapabilities()).toThrow(
      "Missing required capabilities",
    );
  });

  it("does not throw when all capabilities are satisfied", async () => {
    const core = new PulseBridgeCore();
    const processor: ProcessorPlugin = {
      ...makeProcessorPlugin(),
      manifest: {
        ...makeProcessorPlugin().manifest,
        providesCapabilities: ["planes.feed"],
      },
    };
    const integration: IntegrationPlugin = {
      ...makeIntegrationPlugin(),
      manifest: {
        ...makeIntegrationPlugin().manifest,
        requiresCapabilities: ["planes.feed"],
      },
    };
    await core.registerProcessor(processor);
    await core.registerIntegration(integration);
    expect(() => core.validateCapabilities()).not.toThrow();
  });
});

describe("PulseBridgeCore – start/stop", () => {
  let core: PulseBridgeCore;

  beforeEach(() => {
    vi.useFakeTimers();
    core = new PulseBridgeCore();
  });

  afterEach(async () => {
    if (core.isRunning) await core.stop();
    vi.useRealTimers();
  });

  it("isRunning is false before start", () => {
    expect(core.isRunning).toBe(false);
  });

  it("isRunning is true after start", async () => {
    await core.start();
    expect(core.isRunning).toBe(true);
  });

  it("isRunning is false after stop", async () => {
    await core.start();
    await core.stop();
    expect(core.isRunning).toBe(false);
  });

  it("throws when start is called while already running", async () => {
    await core.start();
    await expect(core.start()).rejects.toThrow("already running");
  });

  it("executes integrations and triggers processors on start", async () => {
    const result: PulseRecord[] = [makeRecord("plane.observation")];
    const plugin = makeIntegrationPlugin("int", "fetch", result);
    const processor = makeProcessorPlugin("proc", "test.view", [
      "plane.observation",
    ]);

    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    await core.start();
    await core.waitForReady();

    expect(plugin.execute).toHaveBeenCalledOnce();
    expect(processor.process).toHaveBeenCalledOnce();
    expect(await core.getView("test.view")).toBeDefined();
  });

  it("re-executes integration and processor on each scheduler tick", async () => {
    const result: PulseRecord[] = [makeRecord("plane.observation")];
    const plugin = makeIntegrationPlugin("int", "fetch", result, [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    const processor = makeProcessorPlugin("proc", "test.view", [
      "plane.observation",
    ]);

    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    await core.start();
    await core.waitForReady();
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.execute).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.execute).toHaveBeenCalledTimes(3);
  });
});

describe("PulseBridgeCore – polling config", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("uses defaultIntervalMs when no user override is provided", async () => {
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 2_000,
      hard: false,
    });

    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();

    expect(plugin.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plugin.execute).toHaveBeenCalledTimes(2);

    await core.stop();
  });

  it("respects user override when hard is false", async () => {
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 10_000,
      hard: false,
    });

    await core.registerIntegration(plugin, undefined, {
      pollIntervalMs: 3_000,
    });
    await core.start();
    await core.waitForReady();

    expect(plugin.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(plugin.execute).toHaveBeenCalledTimes(2);

    await core.stop();
  });

  it("ignores user override when hard is true", async () => {
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 5_000,
      hard: true,
    });

    await core.registerIntegration(plugin, undefined, {
      pollIntervalMs: 1_000,
    });
    await core.start();
    await core.waitForReady();

    expect(plugin.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(plugin.execute).toHaveBeenCalledTimes(2);

    await core.stop();
  });

  it("clamps user override to minIntervalMs floor", async () => {
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 10_000,
      minIntervalMs: 5_000,
      hard: false,
    });

    await core.registerIntegration(plugin, undefined, {
      pollIntervalMs: 500,
    });
    await core.start();
    await core.waitForReady();

    expect(plugin.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_500);
    expect(plugin.execute).toHaveBeenCalledTimes(2);

    await core.stop();
  });
});

describe("PulseBridgeCore – rate limiting", () => {
  it("skips execution if called again before the interval expires", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 5_000,
      hard: true,
    });

    await core.registerIntegration(plugin);

    await core.start();
    await core.waitForReady();
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – reactive processor triggering", () => {
  it("triggers processor when its consumed type is updated", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();

    const result: PulseRecord[] = [makeRecord("plane.observation")];
    const plugin = makeIntegrationPlugin("int", "fetch", result, [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });

    const processor = makeProcessorPlugin("proc", "planes.view", [
      "plane.observation",
    ]);

    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    await core.start();
    await core.waitForReady();
    expect(processor.process).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(processor.process).toHaveBeenCalledTimes(2);

    await core.stop();
    vi.useRealTimers();
  });

  it("does not trigger processor when no consumed types are updated", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();

    const result: PulseRecord[] = [makeRecord("airport.data")];
    const plugin = makeIntegrationPlugin("int", "fetch", result, [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });

    const processor = makeProcessorPlugin("proc", "planes.view", [
      "plane.observation",
    ]);

    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    await core.start();
    await core.waitForReady();
    expect(processor.process).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(processor.process).not.toHaveBeenCalled();

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – plugin lifecycle", () => {
  let core: PulseBridgeCore;

  beforeEach(() => {
    core = new PulseBridgeCore();
  });

  afterEach(async () => {
    if (core.isRunning) await core.stop();
  });

  it("calls init on integration plugin after registration", async () => {
    const plugin = makeIntegrationPlugin();
    plugin.init = vi.fn().mockResolvedValue(undefined);

    await core.registerIntegration(plugin);

    expect(plugin.init).toHaveBeenCalledOnce();
  });

  it("calls init on processor plugin after registration", async () => {
    const plugin = makeProcessorPlugin();
    plugin.init = vi.fn().mockResolvedValue(undefined);

    await core.registerProcessor(plugin);

    expect(plugin.init).toHaveBeenCalledOnce();
  });

  it("calls destroy on all plugins when stop() is called", async () => {
    const integration = makeIntegrationPlugin();
    integration.init = vi.fn();
    integration.destroy = vi.fn().mockResolvedValue(undefined);

    const processor = makeProcessorPlugin();
    processor.init = vi.fn();
    processor.destroy = vi.fn().mockResolvedValue(undefined);

    await core.registerIntegration(integration);
    await core.registerProcessor(processor);

    await core.start();
    await core.stop();

    expect(integration.destroy).toHaveBeenCalledOnce();
    expect(processor.destroy).toHaveBeenCalledOnce();
  });

  it("does not throw if init or destroy are not implemented", async () => {
    const plugin = makeIntegrationPlugin();
    await core.registerIntegration(plugin);

    const processor = makeProcessorPlugin();
    await core.registerProcessor(processor);

    await core.start();
    await expect(core.stop()).resolves.not.toThrow();
  });
});

describe("PulseBridgeCore – config schema validation", () => {
  let core: PulseBridgeCore;

  beforeEach(() => {
    core = new PulseBridgeCore();
  });

  it("accepts valid config when integration plugin has a configSchema", async () => {
    const plugin = makeIntegrationPlugin();
    (plugin as typeof plugin & { configSchema: unknown }).configSchema =
      z.object({ enabled: z.boolean() });

    await expect(
      core.registerIntegration(plugin, { enabled: true }),
    ).resolves.not.toThrow();
  });

  it("throws when integration plugin config fails schema validation", async () => {
    const plugin = makeIntegrationPlugin();
    (plugin as typeof plugin & { configSchema: unknown }).configSchema =
      z.object({ enabled: z.boolean() });

    await expect(
      core.registerIntegration(plugin, { enabled: "yes" } as unknown),
    ).rejects.toThrow();
  });

  it("accepts valid config when processor plugin has a configSchema", async () => {
    const plugin = makeProcessorPlugin();
    (plugin as typeof plugin & { configSchema: unknown }).configSchema =
      z.object({ maxItems: z.number() });

    await expect(
      core.registerProcessor(plugin, { maxItems: 10 }),
    ).resolves.not.toThrow();
  });

  it("throws when processor plugin config fails schema validation", async () => {
    const plugin = makeProcessorPlugin();
    (plugin as typeof plugin & { configSchema: unknown }).configSchema =
      z.object({ maxItems: z.number() });

    await expect(
      core.registerProcessor(plugin, { maxItems: "ten" } as unknown),
    ).rejects.toThrow();
  });

  it("skips schema validation when no config is provided", async () => {
    const plugin = makeIntegrationPlugin();
    (plugin as typeof plugin & { configSchema: unknown }).configSchema =
      z.object({ enabled: z.boolean() });

    await expect(core.registerIntegration(plugin)).resolves.not.toThrow();
  });

  it("passes schema defaults to configure for an integration plugin", async () => {
    const plugin = makeIntegrationPlugin();
    plugin.configure = vi.fn();
    (plugin as typeof plugin & { configSchema: unknown }).configSchema =
      z.object({ baseUrl: z.string().default("https://example.com") });

    await core.registerIntegration(plugin, {});

    expect(plugin.configure).toHaveBeenCalledWith({
      baseUrl: "https://example.com",
    });
  });
});

describe("PulseBridgeCore – rate limit backoff", () => {
  it("skips execution while backoff is in effect after RateLimitError", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });

    vi.mocked(plugin.execute)
      .mockRejectedValueOnce(new RateLimitError("429", 5_000))
      .mockResolvedValue([]);

    await core.registerIntegration(plugin);

    await core.start();
    await core.waitForReady();
    expect(core.getPluginState("int")?.status).toBe("rate_limited");
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(plugin.execute).toHaveBeenCalledTimes(2);
    expect(core.getPluginState("int")?.status).toBe("enabled");

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – concurrent execution guard", () => {
  it("does not start a second execution while the first is still in progress", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore({ executionTimeoutMs: 100 });

    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });

    vi.mocked(plugin.execute)
      .mockResolvedValueOnce([])
      .mockImplementation(() => new Promise<PulseRecord[]>(() => {}));

    try {
      await core.registerIntegration(plugin);
      await core.start();
      await core.waitForReady();
      expect(plugin.execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(plugin.execute).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(plugin.execute).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(100);
      await core.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PulseBridgeCore – degraded backoff", () => {
  it("applies exponential backoff after consecutive failures", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });

    vi.mocked(plugin.execute)
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue([]);

    await core.registerIntegration(plugin);

    await core.start();
    await core.waitForReady();
    expect(core.getPluginState("int")?.status).toBe("degraded");
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(plugin.execute).toHaveBeenCalledTimes(2);
    expect(core.getPluginState("int")?.status).toBe("enabled");

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – circuit breaker (integrations)", () => {
  it("disables plugin after maxConsecutiveFailures consecutive errors", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore({
      maxConsecutiveFailures: 3,
    });
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockRejectedValue(new Error("always fails"));

    await core.registerIntegration(plugin);

    await core.start();
    await core.waitForReady();
    expect(core.getPluginState("int")?.status).toBe("degraded");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(core.getPluginState("int")?.status).toBe("disabled");

    await core.stop();
    vi.useRealTimers();
  });

  it("resets failure count on success", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore({
      maxConsecutiveFailures: 3,
    });
    const plugin = makeIntegrationPlugin("int", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    vi.mocked(plugin.execute)
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue([]);

    await core.registerIntegration(plugin);

    await core.start();
    await core.waitForReady();
    expect(core.getPluginState("int")?.status).toBe("degraded");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(core.getPluginState("int")?.status).toBe("degraded");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(core.getPluginState("int")?.status).toBe("enabled");

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – circuit breaker (processors)", () => {
  it("disables processor after maxConsecutiveFailures consecutive errors", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore({ maxConsecutiveFailures: 2 });

    const result: PulseRecord[] = [makeRecord("plane.observation")];
    const plugin = makeIntegrationPlugin("int", "fetch", result, [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    const processor = makeProcessorPlugin("proc", "test.view", [
      "plane.observation",
    ]);
    vi.mocked(processor.process).mockRejectedValue(
      new Error("proc always fails"),
    );

    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    await core.start();
    await core.waitForReady();
    expect(core.getPluginState("proc")?.status).toBe("degraded");

    await vi.advanceTimersByTimeAsync(11_000);
    expect(core.getPluginState("proc")?.status).toBe("disabled");

    await core.stop();
    vi.useRealTimers();
  });

  it("processor skips execution during backoff", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();

    const result: PulseRecord[] = [makeRecord("plane.observation")];
    const plugin = makeIntegrationPlugin("int", "fetch", result, [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    const processor = makeProcessorPlugin("proc", "test.view", [
      "plane.observation",
    ]);
    vi.mocked(processor.process)
      .mockRejectedValueOnce(new Error("fail once"))
      .mockResolvedValue({
        view: "test.view",
        generatedAt: new Date().toISOString(),
        items: [],
      });

    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    await core.start();
    await core.waitForReady();
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(core.getPluginState("proc")?.status).toBe("degraded");

    await vi.advanceTimersByTimeAsync(200);
    expect(processor.process).toHaveBeenCalledTimes(1);

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – configureIntegration / configureProcessor", () => {
  let core: PulseBridgeCore;

  beforeEach(() => {
    core = new PulseBridgeCore();
  });

  it("configureIntegration throws for unknown pluginId", async () => {
    await expect(
      core.configureIntegration("unknown", { apiKey: "x" }),
    ).rejects.toThrow("not registered");
  });

  it("configureIntegration calls plugin.configure with provided config", async () => {
    const plugin = makeIntegrationPlugin();
    plugin.configure = vi.fn();
    await core.registerIntegration(plugin);

    await core.configureIntegration("test-integration", { apiKey: "abc" });
    expect(plugin.configure).toHaveBeenCalledWith({ apiKey: "abc" });
  });

  it("configureProcessor throws for unknown pluginId", async () => {
    await expect(
      core.configureProcessor("unknown", { threshold: 5 }),
    ).rejects.toThrow("not registered");
  });

  it("configureProcessor calls plugin.configure with provided config", async () => {
    const plugin = makeProcessorPlugin();
    plugin.configure = vi.fn();
    await core.registerProcessor(plugin);

    await core.configureProcessor("test-processor", { threshold: 42 });
    expect(plugin.configure).toHaveBeenCalledWith({ threshold: 42 });
  });
});

describe("PulseBridgeCore – disablePlugin on processors", () => {
  it("disabled processor is skipped during execution", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();

    const result: PulseRecord[] = [makeRecord("plane.observation")];
    const plugin = makeIntegrationPlugin("int", "fetch", result, [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    const processor = makeProcessorPlugin("proc", "test.view", [
      "plane.observation",
    ]);

    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    core.disablePlugin("proc");
    await core.start();
    await core.waitForReady();

    expect(processor.process).not.toHaveBeenCalled();

    await core.stop();
    vi.useRealTimers();
  });

  it("re-enabled processor resumes execution", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();

    const result: PulseRecord[] = [makeRecord("plane.observation")];
    const plugin = makeIntegrationPlugin("int", "fetch", result, [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    const processor = makeProcessorPlugin("proc", "test.view", [
      "plane.observation",
    ]);

    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    core.disablePlugin("proc");
    await core.start();
    await core.waitForReady();
    expect(processor.process).not.toHaveBeenCalled();

    core.enablePlugin("proc");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(processor.process).toHaveBeenCalledOnce();

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – secret gating", () => {
  it("skips plugin and sets auth_error when a required secret is missing", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin(
      "test-integration",
      "fetch",
      [],
      [{ key: "API_KEY", required: true }],
      { defaultIntervalMs: 60_000, hard: true },
    );
    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();
    expect(core.getPluginState("test-integration")?.status).toBe("auth_error");
    expect(plugin.execute).not.toHaveBeenCalled();
    await core.stop();
    vi.useRealTimers();
  });

  it("executes plugin when required secret is present", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore({ masterKey: "test-master-key" });
    const plugin = makeIntegrationPlugin(
      "test-integration",
      "fetch",
      [],
      [{ key: "API_KEY", required: true }],
      { defaultIntervalMs: 60_000, hard: true },
    );
    await core.registerIntegration(plugin);
    await core.provision("test-integration", { API_KEY: "value" });
    await core.start();
    await core.waitForReady();
    expect(plugin.execute).toHaveBeenCalledOnce();
    expect(core.getPluginState("test-integration")?.status).toBe("enabled");
    await core.stop();
    vi.useRealTimers();
  });

  it("executes plugin when optional secret is missing", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin(
      "test-integration",
      "fetch",
      [],
      [{ key: "OPTIONAL_KEY", required: false }],
      { defaultIntervalMs: 60_000, hard: true },
    );
    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();
    expect(plugin.execute).toHaveBeenCalledOnce();
    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – secret provisioning", () => {
  const MASTER_KEY = "test-master-key";
  const SECRET_KEY = "API_KEY";
  const SECRET_VALUE = "provisioned-value";

  const makeSecretPlugin = (id: string) =>
    makeIntegrationPlugin(
      id,
      "fetch",
      [],
      [{ key: SECRET_KEY, required: true }],
      {
        defaultIntervalMs: 60_000,
        hard: true,
      },
    );

  it("rejects provisioning a secret the plugin did not declare", async () => {
    const core = new PulseBridgeCore({ masterKey: MASTER_KEY });
    await core.registerIntegration(makeSecretPlugin("p"));
    await expect(
      core.provision("p", { UNDECLARED_KEY: SECRET_VALUE }),
    ).rejects.toThrow(/does not declare secret 'UNDECLARED_KEY'/);
  });

  it("rejects an empty secret value", async () => {
    const core = new PulseBridgeCore({ masterKey: MASTER_KEY });
    await core.registerIntegration(makeSecretPlugin("p"));
    await expect(core.provision("p", { [SECRET_KEY]: "   " })).rejects.toThrow(
      /must not be empty/,
    );
  });

  it("rejects provisioning an unregistered plugin", async () => {
    const core = new PulseBridgeCore({ masterKey: MASTER_KEY });
    await expect(
      core.provision("missing", { [SECRET_KEY]: SECRET_VALUE }),
    ).rejects.toThrow(/not registered/);
  });

  it("reports a declared secret as unset before provisioning", async () => {
    const core = new PulseBridgeCore({ masterKey: MASTER_KEY });
    await core.registerIntegration(makeSecretPlugin("p"));
    const spec = await core.getProvisioningSpec("p");
    expect(spec?.secrets).toEqual([
      { key: SECRET_KEY, required: true, set: false },
    ]);
  });

  it("reports a secret as set after provisioning, without exposing the value", async () => {
    const core = new PulseBridgeCore({ masterKey: MASTER_KEY });
    await core.registerIntegration(makeSecretPlugin("p"));
    await core.provision("p", { [SECRET_KEY]: SECRET_VALUE });
    const spec = await core.getProvisioningSpec("p");
    expect(spec?.secrets).toEqual([
      { key: SECRET_KEY, required: true, set: true },
    ]);
    expect(JSON.stringify(spec)).not.toContain(SECRET_VALUE);
  });

  it("clears a secret on deprovision", async () => {
    const core = new PulseBridgeCore({ masterKey: MASTER_KEY });
    await core.registerIntegration(makeSecretPlugin("p"));
    await core.provision("p", { [SECRET_KEY]: SECRET_VALUE });
    await core.deprovision("p", SECRET_KEY);
    const spec = await core.getProvisioningSpec("p");
    expect(spec?.secrets[0]?.set).toBe(false);
  });

  it("does not leak one plugin's secret to another declaring the same key", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore({ masterKey: MASTER_KEY });
    await core.registerIntegration(makeSecretPlugin("plugin-a"));
    await core.registerIntegration(makeSecretPlugin("plugin-b"));
    await core.provision("plugin-a", { [SECRET_KEY]: SECRET_VALUE });

    await core.start();
    await core.waitForReady();

    expect(core.getPluginState("plugin-a")?.status).toBe("enabled");
    expect(core.getPluginState("plugin-b")?.status).toBe("auth_error");

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – error handling", () => {
  it("sets status to needs_reauth when plugin throws ReauthRequiredError", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 60_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockRejectedValue(
      new ReauthRequiredError("Token expired"),
    );

    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();

    expect(core.getPluginState("test-integration")?.status).toBe(
      "needs_reauth",
    );
    expect(core.getPluginState("test-integration")?.lastError).toBe(
      "Token expired",
    );
    await core.stop();
    vi.useRealTimers();
  });

  it("sets status to auth_error when plugin throws PluginAuthError", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 60_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockRejectedValue(
      new PluginAuthError("Invalid API key"),
    );

    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();

    expect(core.getPluginState("test-integration")?.status).toBe("auth_error");
    expect(core.getPluginState("test-integration")?.lastError).toBe(
      "Invalid API key",
    );
    await core.stop();
    vi.useRealTimers();
  });

  it("sets status to degraded for unexpected errors", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 60_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockRejectedValue(new Error("Network timeout"));

    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();

    expect(core.getPluginState("test-integration")?.status).toBe("degraded");
    expect(core.getPluginState("test-integration")?.lastError).toBe(
      "Network timeout",
    );
    await core.stop();
    vi.useRealTimers();
  });

  it("sets status to rate_limited when plugin throws RateLimitError", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 60_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockRejectedValue(
      new RateLimitError("429 Too Many Requests", 30_000),
    );

    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();

    expect(core.getPluginState("test-integration")?.status).toBe(
      "rate_limited",
    );
    await core.stop();
    vi.useRealTimers();
  });

  it("sets needs_reauth status when plugin throws ReauthRequiredError", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 60_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockRejectedValueOnce(
      new ReauthRequiredError("Token expired"),
    );

    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();

    expect(core.getPluginState("test-integration")?.status).toBe(
      "needs_reauth",
    );

    await core.stop();
    vi.useRealTimers();
  });

  it("sets plugin to degraded and does not throw when the record store write fails", async () => {
    vi.useFakeTimers();
    const failingStore = {
      append: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      getByType: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined),
      setByPlugin: vi
        .fn()
        .mockRejectedValue(new Error("Redis connection refused")),
    };

    const core = new PulseBridgeCore({
      store: {
        records: failingStore,
        views: new (
          await import("../../storage/inMemoryViewStore.js")
        ).InMemoryViewStore(),
      },
    });

    const plugin = makeIntegrationPlugin(
      "int",
      "fetch",
      [makeRecord("plane.observation")],
      [],
      { defaultIntervalMs: 60_000, hard: true },
    );
    await core.registerIntegration(plugin);

    await core.start();
    await core.waitForReady();
    expect(core.getPluginState("int")?.status).toBe("degraded");
    expect(core.getPluginState("int")?.lastError).toBe(
      "Redis connection refused",
    );
    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – reauth flow", () => {
  it("calls reauth() on the next run when plugin is in needs_reauth state", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    plugin.reauth = vi.fn().mockResolvedValue(undefined);
    vi.mocked(plugin.execute)
      .mockRejectedValueOnce(new ReauthRequiredError("Token expired"))
      .mockResolvedValue([]);

    await core.registerIntegration(plugin);

    await core.start();
    await core.waitForReady();
    expect(core.getPluginState("test-integration")?.status).toBe(
      "needs_reauth",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.reauth).toHaveBeenCalledOnce();

    await core.stop();
    vi.useRealTimers();
  });

  it("clears needs_reauth status and resumes execution after successful reauth", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    plugin.reauth = vi.fn().mockResolvedValue(undefined);
    vi.mocked(plugin.execute)
      .mockRejectedValueOnce(new ReauthRequiredError("Token expired"))
      .mockResolvedValue([]);

    await core.registerIntegration(plugin);

    await core.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(core.getPluginState("test-integration")?.status).toBe("enabled");
    expect(plugin.execute).toHaveBeenCalledTimes(2);

    await core.stop();
    vi.useRealTimers();
  });

  it("sets auth_error and skips execute when reauth() throws", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    plugin.reauth = vi
      .fn()
      .mockRejectedValue(new Error("Refresh token invalid"));
    vi.mocked(plugin.execute).mockRejectedValueOnce(
      new ReauthRequiredError("Token expired"),
    );

    await core.registerIntegration(plugin);

    await core.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(core.getPluginState("test-integration")?.status).toBe("auth_error");
    expect(core.getPluginState("test-integration")?.lastError).toBe(
      "Refresh token invalid",
    );
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await core.stop();
    vi.useRealTimers();
  });

  it("warns and skips execution when plugin has no reauth() implementation", async () => {
    vi.useFakeTimers();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const coreWithLogger = new PulseBridgeCore({ logger });
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockRejectedValueOnce(
      new ReauthRequiredError("Token expired"),
    );

    await coreWithLogger.registerIntegration(plugin);

    await coreWithLogger.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("does not implement reauth"),
      expect.objectContaining({ pluginId: "test-integration" }),
    );
    expect(plugin.execute).toHaveBeenCalledTimes(1);

    await coreWithLogger.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – plugin:status-changed events", () => {
  it("emits plugin:status-changed when a plugin goes degraded", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 60_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockRejectedValue(new Error("boom"));

    const events: Array<{ pluginId: string; newStatus: string }> = [];
    core.on("plugin:status-changed", (e) =>
      events.push({ pluginId: e.pluginId, newStatus: e.newStatus }),
    );

    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();

    expect(events).toContainEqual({
      pluginId: "test-integration",
      newStatus: "degraded",
    });
    await core.stop();
    vi.useRealTimers();
  });

  it("emits plugin:status-changed with previousStatus when transitioning", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });
    vi.mocked(plugin.execute)
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue([]);

    const events: Array<{
      previousStatus: string | undefined;
      newStatus: string;
    }> = [];
    core.on("plugin:status-changed", (e) =>
      events.push({ previousStatus: e.previousStatus, newStatus: e.newStatus }),
    );

    await core.registerIntegration(plugin);
    await core.start();
    await core.waitForReady();

    const degraded = events.find((e) => e.newStatus === "degraded");
    expect(degraded?.previousStatus).toBe("enabled");

    await vi.advanceTimersByTimeAsync(1_000);
    const recovered = events.find(
      (e) => e.newStatus === "enabled" && e.previousStatus === "degraded",
    );
    expect(recovered).toBeDefined();

    await core.stop();
    vi.useRealTimers();
  });

  it("does not emit when status does not change", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 1_000,
      hard: true,
    });

    const events: string[] = [];
    core.on("plugin:status-changed", (e) => events.push(e.newStatus));

    await core.registerIntegration(plugin);
    await core.start();

    await vi.advanceTimersByTimeAsync(1_000);

    const enabledEvents = events.filter((s) => s === "enabled");
    expect(enabledEvents).toHaveLength(1);

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – oauth2 auth type", () => {
  it("executes normally when oauth2 auth is configured with a valid token", async () => {
    vi.useFakeTimers();
    const tokenStore = new InMemoryTokenStore();
    const core = new PulseBridgeCore({ tokens: tokenStore });

    const plugin: IntegrationPlugin = {
      manifest: {
        id: "oauth2-integration",
        name: "OAuth2 Integration",
        version: "1.0.0",
        kind: "integration",
        operations: [
          {
            id: "fetch",
            name: "Fetch",
            recordType: "test.record",
          },
        ],
        auth: { type: "oauth2" },
        polling: { defaultIntervalMs: 60_000, hard: true },
      },
      execute: vi.fn().mockResolvedValue([]),
    };

    tokenStore.set("oauth2-integration", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await core.registerIntegration(plugin);
    await core.start();

    expect(plugin.execute).toHaveBeenCalledOnce();
    expect(core.getPluginState("oauth2-integration")?.status).toBe("enabled");

    await core.stop();
    vi.useRealTimers();
  });

  it("sets auth_error when oauth2 auth is configured but no TokenStore is provided", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore();

    const plugin: IntegrationPlugin = {
      manifest: {
        id: "oauth2-no-store",
        name: "OAuth2 No Store",
        version: "1.0.0",
        kind: "integration",
        operations: [
          {
            id: "fetch",
            name: "Fetch",
            recordType: "test.record",
          },
        ],
        auth: { type: "oauth2" },
        polling: { defaultIntervalMs: 60_000, hard: true },
      },
      execute: vi.fn().mockResolvedValue([]),
    };

    await core.registerIntegration(plugin);
    await core.start();

    expect(core.getPluginState("oauth2-no-store")?.status).toBe("auth_error");
    expect(plugin.execute).not.toHaveBeenCalled();

    await core.stop();
    vi.useRealTimers();
  });

  it("uses tokenKey to look up the token when specified", async () => {
    vi.useFakeTimers();
    const tokenStore = new InMemoryTokenStore();
    const core = new PulseBridgeCore({ tokens: tokenStore });

    const plugin: IntegrationPlugin = {
      manifest: {
        id: "oauth2-custom-key",
        name: "OAuth2 Custom Key",
        version: "1.0.0",
        kind: "integration",
        operations: [
          {
            id: "fetch",
            name: "Fetch",
            recordType: "test.record",
          },
        ],
        auth: { type: "oauth2", tokenKey: "my-custom-token-key" },
        polling: { defaultIntervalMs: 60_000, hard: true },
      },
      execute: vi.fn().mockResolvedValue([]),
    };

    tokenStore.set("my-custom-token-key", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await core.registerIntegration(plugin);
    await core.start();

    expect(plugin.execute).toHaveBeenCalledOnce();
    expect(core.getPluginState("oauth2-custom-key")?.status).toBe("enabled");

    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – execution timeout", () => {
  it("sets plugin to degraded when execute() exceeds executionTimeoutMs", async () => {
    vi.useFakeTimers();
    const core = new PulseBridgeCore({ executionTimeoutMs: 50 });

    const plugin = makeIntegrationPlugin("test-integration", "fetch", [], [], {
      defaultIntervalMs: 60_000,
      hard: true,
    });
    vi.mocked(plugin.execute).mockImplementation(
      () => new Promise<PulseRecord[]>(() => {}),
    );

    await core.registerIntegration(plugin);

    const startPromise = core.start();
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(core.getPluginState("test-integration")?.status).toBe("degraded");
    expect(core.getPluginState("test-integration")?.lastError).toContain(
      "timed out after 50ms",
    );
    await core.stop();
    vi.useRealTimers();
  });
});

describe("PulseBridgeCore – actions & webhooks", () => {
  const ACTION_ID = "trigger";

  const makeActionPlugin = (
    invoke: NonNullable<IntegrationPlugin["invoke"]>,
  ): IntegrationPlugin => ({
    manifest: {
      id: "actor",
      name: "Actor",
      version: "1.0.0",
      kind: "integration",
      operations: [{ id: "fetch", name: "Fetch", recordType: "test.record" }],
      actions: [{ id: ACTION_ID, name: "Trigger" }],
    },
    execute: vi.fn().mockResolvedValue([]),
    invoke,
  });

  it("returns the action result from invokeAction", async () => {
    const core = new PulseBridgeCore();
    await core.registerIntegration(
      makeActionPlugin(async () => ({ data: { triggered: true } })),
    );

    const result = await core.invokeAction("actor", ACTION_ID);

    expect(result.data).toEqual({ triggered: true });
  });

  it("throws when invoking an action on an unregistered plugin", async () => {
    const core = new PulseBridgeCore();

    await expect(core.invokeAction("nope", ACTION_ID)).rejects.toThrow(
      "is not registered",
    );
  });

  it("reports a plugin as degraded when its action channel fails", async () => {
    const core = new PulseBridgeCore();
    await core.registerIntegration(
      makeActionPlugin(async () => {
        throw new PluginAuthError("rejected");
      }),
    );
    await core.start();
    await core.waitForReady();

    await expect(core.invokeAction("actor", ACTION_ID)).rejects.toThrow(
      "rejected",
    );

    expect(core.getHealth().status).toBe("degraded");
    await core.stop();
  });

  it("keeps the plugin polling status enabled when an action channel fails", async () => {
    const core = new PulseBridgeCore();
    await core.registerIntegration(
      makeActionPlugin(async () => {
        throw new PluginAuthError("rejected");
      }),
    );

    await expect(core.invokeAction("actor", ACTION_ID)).rejects.toThrow(
      "rejected",
    );

    expect(core.getPluginState("actor")?.status).toBe("enabled");
  });

  it("appends records returned from an ingested webhook", async () => {
    const core = new PulseBridgeCore();
    const plugin: IntegrationPlugin = {
      manifest: {
        id: "hooked",
        name: "Hooked",
        version: "1.0.0",
        kind: "integration",
        operations: [{ id: "fetch", name: "Fetch", recordType: "test.record" }],
        webhook: {},
      },
      execute: vi.fn().mockResolvedValue([]),
      ingest: async () => ({ records: [makeRecord("hook.event")] }),
    };
    await core.registerIntegration(plugin);

    await core.ingest("hooked", { body: "{}", headers: {} });

    expect(await core.getRecordsByType("hook.event")).toHaveLength(1);
  });
});

describe("PulseBridgeCore – refreshIntegration", () => {
  it("force-runs the named integration", async () => {
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [
      makeRecord("plane.observation"),
    ]);
    await core.registerIntegration(plugin);

    await core.refreshIntegration("int");

    expect(plugin.execute).toHaveBeenCalledOnce();
  });

  it("triggers processors that consume the repolled records", async () => {
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [
      makeRecord("plane.observation"),
    ]);
    const processor = makeProcessorPlugin("proc", "test.view", [
      "plane.observation",
    ]);
    await core.registerIntegration(plugin);
    await core.registerProcessor(processor);

    await core.refreshIntegration("int");

    expect(await core.getView("test.view")).toBeDefined();
  });

  it("throws when refreshing an unregistered integration", async () => {
    const core = new PulseBridgeCore();

    await expect(core.refreshIntegration("missing")).rejects.toThrow(
      "is not registered",
    );
  });

  it("repolls only the named integration", async () => {
    const core = new PulseBridgeCore();
    const target = makeIntegrationPlugin("target", "fetch", []);
    const other = makeIntegrationPlugin("other", "fetch", []);
    await core.registerIntegration(target);
    await core.registerIntegration(other);

    await core.refreshIntegration("target");

    expect(other.execute).not.toHaveBeenCalled();
  });

  it("is a no-op for a disabled integration", async () => {
    const core = new PulseBridgeCore();
    const plugin = makeIntegrationPlugin("int", "fetch", [
      makeRecord("plane.observation"),
    ]);
    await core.registerIntegration(plugin);
    core.disablePlugin("int");

    await core.refreshIntegration("int");

    expect(plugin.execute).not.toHaveBeenCalled();
  });

  it("uses freshly applied config on the repoll", async () => {
    const core = new PulseBridgeCore();
    let current = "";
    const plugin: IntegrationPlugin = {
      manifest: {
        id: "cfg",
        name: "Cfg",
        version: "1.0.0",
        kind: "integration",
        operations: [{ id: "fetch", name: "Fetch", recordType: "cfg.record" }],
      },
      configSchema: z.object({ token: z.string() }),
      configure: (config) => {
        current = (config as { token: string }).token;
      },
      execute: vi.fn(async () => [
        {
          type: "cfg.record",
          timestamp: new Date().toISOString(),
          source: "test",
          data: { token: current },
        },
      ]),
    };
    const processor: ProcessorPlugin = {
      manifest: {
        id: "proc",
        name: "Proc",
        version: "1.0.0",
        kind: "processor",
        consumes: ["cfg.record"],
        produces: ["cfg.view"],
        providesCapabilities: [],
      },
      process: async (events) => ({
        view: "cfg.view",
        generatedAt: new Date().toISOString(),
        items: events.map((e) => e.data),
      }),
    };
    await core.registerIntegration(plugin, { token: "A" });
    await core.registerProcessor(processor);

    await core.configureIntegration("cfg", { token: "B" });
    await core.refreshIntegration("cfg");

    const view = await core.getView("cfg.view");
    expect((view?.items[0] as { token: string }).token).toBe("B");
  });
});
