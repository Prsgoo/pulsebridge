/**
 * Tests for the three features added in the gap-fix pass:
 *   1. TransientError — short fixed backoff, no consecutive-failure increment
 *   2. view:updated event — emitted immediately when a processor writes a view
 *   3. Destroy timeout — stop() resolves even when a plugin's destroy() hangs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PulseBridgeCore } from "../pulseBridgeCore.js";
import { TransientError } from "../../contracts/errors/pulseErrors.js";
import type { IntegrationPlugin } from "../../plugin-sdk/integrationPlugin.js";
import type { ProcessorPlugin } from "../../plugin-sdk/processorPlugin.js";
import type { PulseRecord } from "../../contracts/records/pulseRecord.js";
import type { PulseViewRecord } from "../../contracts/records/pulseViewRecord.js";
import type { RuntimeContext } from "../../contracts/runtime/runtimeContext.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const INTEGRATION_ID = "test/integration";
const PROCESSOR_ID = "test/processor";
const RECORD_TYPE = "test.record";
const VIEW_NAME = "test.view";

function makeIntegration(
  execute: IntegrationPlugin["execute"],
): IntegrationPlugin {
  return {
    manifest: {
      id: INTEGRATION_ID,
      name: "Test Integration",
      version: "1.0.0",
      kind: "integration",
      operations: [{ id: "fetch", name: "Fetch", recordType: RECORD_TYPE }],
      polling: { defaultIntervalMs: 60_000, hard: true },
    },
    execute,
  };
}

function makeProcessor(
  process: ProcessorPlugin["process"] = async (records) => {
    if (records.length === 0) return null;
    return {
      view: VIEW_NAME,
      generatedAt: new Date().toISOString(),
      items: [{ count: records.length }],
    };
  },
): ProcessorPlugin {
  return {
    manifest: {
      id: PROCESSOR_ID,
      name: "Test Processor",
      version: "1.0.0",
      kind: "processor",
      consumes: [RECORD_TYPE],
      produces: [VIEW_NAME],
    },
    process,
  };
}

function makeRecord(context: RuntimeContext): PulseRecord {
  return {
    type: RECORD_TYPE,
    timestamp: context.now().toISOString(),
    source: INTEGRATION_ID,
    data: {},
  };
}

// ---------------------------------------------------------------------------
// 1. TransientError
// ---------------------------------------------------------------------------

describe("TransientError — platform behaviour", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("sets plugin status to degraded when integration throws TransientError", async () => {
    const core = new PulseBridgeCore();

    await core.registerIntegration(
      makeIntegration(async () => {
        throw new TransientError("NASA returned 503.");
      }),
    );

    await core.start();
    await core.stop();

    const state = core.getPluginState(INTEGRATION_ID);
    expect(state?.status).toBe("degraded");
    expect(state?.lastError).toBe("NASA returned 503.");
  });

  it("does not trip the circuit breaker after repeated TransientErrors", async () => {
    const core = new PulseBridgeCore({ maxConsecutiveFailures: 3 });
    let callCount = 0;

    await core.registerIntegration(
      makeIntegration(async () => {
        callCount++;
        throw new TransientError("transient");
      }),
    );

    await core.start();

    // Advance timers to trigger three more scheduler ticks — each fires a
    // transient error. If the circuit breaker were counting them the plugin
    // would be disabled; it should stay degraded.
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    await core.stop();

    const state = core.getPluginState(INTEGRATION_ID);
    // Plugin must NOT be disabled — circuit breaker must not have tripped.
    expect(state?.status).toBe("degraded");
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("recovers to enabled after a TransientError clears on next successful run", async () => {
    let shouldFail = true;
    const core = new PulseBridgeCore();

    await core.registerIntegration(
      makeIntegration(async (_, context) => {
        if (shouldFail) throw new TransientError("transient");
        return [makeRecord(context)];
      }),
    );
    await core.registerProcessor(makeProcessor());

    await core.start();
    await core.waitForReady();

    const degradedState = core.getPluginState(INTEGRATION_ID);
    expect(degradedState?.status).toBe("degraded");

    // Let the plugin recover on next tick.
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await core.stop();

    const recoveredState = core.getPluginState(INTEGRATION_ID);
    expect(recoveredState?.status).toBe("enabled");
  });
});

// ---------------------------------------------------------------------------
// 2. view:updated event
// ---------------------------------------------------------------------------

describe("view:updated event", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("emits view:updated when a processor writes a view on start()", async () => {
    const core = new PulseBridgeCore();
    const received: PulseViewRecord[] = [];

    core.on("view:updated", (view) => received.push(view));

    await core.registerIntegration(
      makeIntegration(async (_, context) => [makeRecord(context)]),
    );
    await core.registerProcessor(makeProcessor());
    await core.start();
    await core.stop();

    expect(received).toHaveLength(1);
    expect(received[0]?.view).toBe(VIEW_NAME);
  });

  it("emits view:updated again on subsequent scheduler ticks", async () => {
    const core = new PulseBridgeCore();
    const received: PulseViewRecord[] = [];

    core.on("view:updated", (view) => received.push(view));

    await core.registerIntegration(
      makeIntegration(async (_, context) => [makeRecord(context)]),
    );
    await core.registerProcessor(makeProcessor());
    await core.start();

    await vi.advanceTimersByTimeAsync(60_000);
    await core.stop();

    // Initial run + one scheduler tick = two emissions.
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received.every((v) => v.view === VIEW_NAME)).toBe(true);
  });

  it("does not emit view:updated when the processor returns null", async () => {
    const core = new PulseBridgeCore();
    const received: PulseViewRecord[] = [];

    core.on("view:updated", (view) => received.push(view));

    await core.registerIntegration(makeIntegration(async () => []));
    await core.registerProcessor(makeProcessor(async () => null));
    await core.start();
    await core.stop();

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Destroy timeout
// ---------------------------------------------------------------------------

describe("Plugin destroy timeout", () => {
  it("stop() resolves even when an integration destroy() never settles", async () => {
    vi.useFakeTimers();

    const core = new PulseBridgeCore();

    const hangingIntegration: IntegrationPlugin = {
      ...makeIntegration(async (_, context) => [makeRecord(context)]),
      destroy: () => new Promise(() => {}), // hangs forever
    };

    await core.registerIntegration(hangingIntegration);
    await core.start();

    const stopPromise = core.stop();
    // Advance past the 5 s destroy timeout so the platform gives up.
    await vi.runAllTimersAsync();
    await stopPromise;

    // If we reach here stop() did not hang.
    expect(core.isRunning).toBe(false);

    vi.useRealTimers();
  });

  it("stop() resolves even when a processor destroy() never settles", async () => {
    vi.useFakeTimers();

    const core = new PulseBridgeCore();

    const hangingProcessor: ProcessorPlugin = {
      ...makeProcessor(),
      destroy: () => new Promise(() => {}),
    };

    await core.registerIntegration(
      makeIntegration(async (_, context) => [makeRecord(context)]),
    );
    await core.registerProcessor(hangingProcessor);
    await core.start();

    const stopPromise = core.stop();
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(core.isRunning).toBe(false);

    vi.useRealTimers();
  });
});
