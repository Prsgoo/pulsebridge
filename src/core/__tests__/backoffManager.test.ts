/**
 * Unit tests for BackoffManager — pure backoff/circuit-breaker arithmetic driven
 * directly with a controllable clock and a real PluginStateManager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BackoffManager } from "../backoffManager.js";
import { PluginStateManager } from "../pluginStateManager.js";
import type { PulseLogger } from "../../contracts/runtime/pulseLogger.js";

const PLUGIN_ID = "test/plugin";
const BASE_TIME = new Date("2026-01-01T00:00:00.000Z").getTime();

const noopLogger: PulseLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface ManagerOptions {
  maxConsecutiveFailures?: number;
  maxDegradedBackoffMs?: number;
}

function makeManager(opts: ManagerOptions = {}) {
  const stateManager = new PluginStateManager(() => {});
  const manager = new BackoffManager({
    maxConsecutiveFailures: opts.maxConsecutiveFailures,
    maxDegradedBackoffMs: opts.maxDegradedBackoffMs ?? 300_000,
    stateManager,
    logger: noopLogger,
  });
  return { manager, stateManager };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BackoffManager — rate limit", () => {
  it("is not rate limited when nothing was set", () => {
    const { manager } = makeManager();

    expect(manager.isRateLimited(PLUGIN_ID)).toBe(false);
  });

  it("is rate limited while the backoff window is in the future", () => {
    const { manager } = makeManager();
    manager.setRateLimitBackoff(PLUGIN_ID, BASE_TIME + 1_000);

    expect(manager.isRateLimited(PLUGIN_ID)).toBe(true);
  });

  it("is no longer rate limited once the window has passed", () => {
    const { manager } = makeManager();
    manager.setRateLimitBackoff(PLUGIN_ID, BASE_TIME + 1_000);
    vi.setSystemTime(BASE_TIME + 1_000);

    expect(manager.isRateLimited(PLUGIN_ID)).toBe(false);
  });

  it("reports the remaining rate-limit backoff", () => {
    const { manager } = makeManager();
    manager.setRateLimitBackoff(PLUGIN_ID, BASE_TIME + 5_000);

    expect(manager.rateLimitBackoffRemaining(PLUGIN_ID)).toBe(5_000);
  });
});

describe("BackoffManager — last request tracking", () => {
  it("returns undefined when no request was recorded", () => {
    const { manager } = makeManager();

    expect(manager.getLastRequestAt(PLUGIN_ID)).toBeUndefined();
  });

  it("returns the recorded request timestamp", () => {
    const { manager } = makeManager();
    manager.setLastRequestAt(PLUGIN_ID, BASE_TIME + 200);

    expect(manager.getLastRequestAt(PLUGIN_ID)).toBe(BASE_TIME + 200);
  });
});

describe("BackoffManager — transient (degraded) backoff", () => {
  it("is degraded while the transient backoff window is open", () => {
    const { manager } = makeManager();
    manager.setTransientBackoff(PLUGIN_ID, 4_000);

    expect(manager.isDegradedBackoff(PLUGIN_ID)).toBe(true);
  });

  it("reports the remaining transient backoff", () => {
    const { manager } = makeManager();
    manager.setTransientBackoff(PLUGIN_ID, 4_000);

    expect(manager.degradedBackoffRemaining(PLUGIN_ID)).toBe(4_000);
  });

  it("clears after the transient window elapses", () => {
    const { manager } = makeManager();
    manager.setTransientBackoff(PLUGIN_ID, 4_000);
    vi.setSystemTime(BASE_TIME + 4_000);

    expect(manager.isDegradedBackoff(PLUGIN_ID)).toBe(false);
  });

  it("does not count a transient backoff as a consecutive failure", () => {
    const { manager } = makeManager();
    manager.setTransientBackoff(PLUGIN_ID, 4_000);

    expect(manager.getConsecutiveFailures(PLUGIN_ID)).toBe(0);
  });
});

describe("BackoffManager — integration backoff", () => {
  it("defaults the consecutive failure count to zero", () => {
    const { manager } = makeManager();

    expect(manager.getConsecutiveFailures(PLUGIN_ID)).toBe(0);
  });

  it("increments the consecutive failure count on each backoff", () => {
    const { manager } = makeManager();

    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);
    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(manager.getConsecutiveFailures(PLUGIN_ID)).toBe(2);
  });

  it("returns backoff_applied below the failure threshold", () => {
    const { manager } = makeManager({ maxConsecutiveFailures: 3 });

    const outcome = manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(outcome).toBe("backoff_applied");
  });

  it("applies the base backoff on the first failure", () => {
    const { manager } = makeManager();

    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(manager.degradedBackoffRemaining(PLUGIN_ID)).toBe(1_000);
  });

  it("doubles the backoff on the second failure", () => {
    const { manager } = makeManager();

    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);
    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(manager.degradedBackoffRemaining(PLUGIN_ID)).toBe(2_000);
  });

  it("caps the backoff at maxDegradedBackoffMs", () => {
    const { manager } = makeManager({ maxDegradedBackoffMs: 2_500 });

    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);
    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);
    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(manager.degradedBackoffRemaining(PLUGIN_ID)).toBe(2_500);
  });

  it("does not trip the circuit at exactly one below the threshold", () => {
    const { manager } = makeManager({ maxConsecutiveFailures: 3 });

    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);
    const outcome = manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(outcome).toBe("backoff_applied");
  });

  it("trips the circuit when failures reach the threshold", () => {
    const { manager } = makeManager({ maxConsecutiveFailures: 3 });

    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);
    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);
    const outcome = manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(outcome).toBe("circuit_tripped");
  });

  it("disables the plugin when the circuit trips", () => {
    const { manager, stateManager } = makeManager({
      maxConsecutiveFailures: 1,
    });

    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(stateManager.getPluginState(PLUGIN_ID)?.status).toBe("disabled");
  });

  it("includes the failure count and error in the disable reason", () => {
    const { manager, stateManager } = makeManager({
      maxConsecutiveFailures: 1,
    });

    manager.applyIntegrationBackoff(PLUGIN_ID, "the cause", 1_000);

    expect(stateManager.getPluginState(PLUGIN_ID)?.disabledReason).toBe(
      "Circuit breaker tripped after 1 consecutive failures. Last error: the cause",
    );
  });

  it("resets the failure count after the circuit trips", () => {
    const { manager } = makeManager({ maxConsecutiveFailures: 1 });

    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    expect(manager.getConsecutiveFailures(PLUGIN_ID)).toBe(0);
  });

  it("never trips the circuit when no threshold is configured", () => {
    const { manager } = makeManager();

    for (let i = 0; i < 10; i++) {
      manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);
    }

    expect(manager.getConsecutiveFailures(PLUGIN_ID)).toBe(10);
  });

  it("clears the integration backoff and failure count", () => {
    const { manager } = makeManager();
    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    manager.clearIntegrationBackoff(PLUGIN_ID);

    expect(manager.getConsecutiveFailures(PLUGIN_ID)).toBe(0);
  });

  it("clears the degraded backoff window", () => {
    const { manager } = makeManager();
    manager.applyIntegrationBackoff(PLUGIN_ID, "err", 1_000);

    manager.clearIntegrationBackoff(PLUGIN_ID);

    expect(manager.isDegradedBackoff(PLUGIN_ID)).toBe(false);
  });
});

describe("BackoffManager — processor backoff", () => {
  it("defaults the processor failure count to zero", () => {
    const { manager } = makeManager();

    expect(manager.getProcessorConsecutiveFailures(PLUGIN_ID)).toBe(0);
  });

  it("applies an independent processor backoff", () => {
    const { manager } = makeManager();

    manager.applyProcessorBackoff(PLUGIN_ID, "err", 1_000);

    expect(manager.processorBackoffRemaining(PLUGIN_ID)).toBe(1_000);
  });

  it("reports processor degraded backoff state", () => {
    const { manager } = makeManager();

    manager.applyProcessorBackoff(PLUGIN_ID, "err", 1_000);

    expect(manager.isProcessorDegradedBackoff(PLUGIN_ID)).toBe(true);
  });

  it("does not affect integration failures when a processor fails", () => {
    const { manager } = makeManager();

    manager.applyProcessorBackoff(PLUGIN_ID, "err", 1_000);

    expect(manager.getConsecutiveFailures(PLUGIN_ID)).toBe(0);
  });

  it("clears processor backoff independently", () => {
    const { manager } = makeManager();
    manager.applyProcessorBackoff(PLUGIN_ID, "err", 1_000);

    manager.clearProcessorBackoff(PLUGIN_ID);

    expect(manager.getProcessorConsecutiveFailures(PLUGIN_ID)).toBe(0);
  });
});
