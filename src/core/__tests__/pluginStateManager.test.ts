import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginStateManager } from "../pluginStateManager.js";
import type { PluginStatusChangedEvent } from "../pulseBridgeCore.js";

type EmitFn = (
  event: "plugin:status-changed",
  payload: PluginStatusChangedEvent,
) => void;

describe("PluginStateManager", () => {
  let emitSpy: ReturnType<typeof vi.fn<EmitFn>>;
  let manager: PluginStateManager;

  beforeEach(() => {
    emitSpy = vi.fn<EmitFn>();
    manager = new PluginStateManager(emitSpy);
  });

  it("enablePlugin — emits status-changed when transitioning from a different status", () => {
    manager.setPluginStatus("p1", "degraded");
    emitSpy.mockClear();

    manager.enablePlugin("p1");

    expect(emitSpy).toHaveBeenCalledOnce();
    const payload = emitSpy.mock.calls[0]?.[1];
    expect(payload.newStatus).toBe("enabled");
    expect(payload.previousStatus).toBe("degraded");
  });

  it("enablePlugin — does NOT emit when plugin is already enabled", () => {
    manager.enablePlugin("p1");
    emitSpy.mockClear();

    manager.enablePlugin("p1");

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("enablePlugin — preserves lastRunAt from previous state", () => {
    const lastRunAt = "2026-01-01T00:00:00.000Z";
    manager.setPluginStatus("p1", "degraded", { lastRunAt });
    manager.enablePlugin("p1");

    expect(manager.getPluginState("p1")?.lastRunAt).toBe(lastRunAt);
  });

  it("enablePlugin — clears lastError when enabling", () => {
    manager.setPluginStatus("p1", "degraded", { lastError: "boom" });
    manager.enablePlugin("p1");

    expect(manager.getPluginState("p1")?.lastError).toBeUndefined();
  });

  it("disablePlugin — emits status-changed on first disable", () => {
    manager.enablePlugin("p1");
    emitSpy.mockClear();

    manager.disablePlugin("p1", "manual");

    expect(emitSpy).toHaveBeenCalledOnce();
    const payload = emitSpy.mock.calls[0]?.[1];
    expect(payload.newStatus).toBe("disabled");
  });

  it("disablePlugin — does NOT emit when plugin is already disabled", () => {
    manager.disablePlugin("p1", "first time");
    emitSpy.mockClear();

    manager.disablePlugin("p1", "second time");

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("disablePlugin — stores disabledReason", () => {
    manager.disablePlugin("p1", "maintenance");
    expect(manager.getPluginState("p1")?.disabledReason).toBe("maintenance");
  });

  it("setPluginStatus — preserves disabledReason when setting status to disabled", () => {
    manager.disablePlugin("p1", "original reason");
    manager.setPluginStatus("p1", "disabled");
    expect(manager.getPluginState("p1")?.disabledReason).toBe(
      "original reason",
    );
  });

  it("setPluginStatus — clears disabledReason when transitioning away from disabled", () => {
    manager.disablePlugin("p1", "maintenance");
    manager.setPluginStatus("p1", "enabled");
    expect(manager.getPluginState("p1")?.disabledReason).toBeUndefined();
  });

  it("setPluginStatus — clearLastError removes lastError", () => {
    manager.setPluginStatus("p1", "degraded", { lastError: "oops" });
    manager.setPluginStatus("p1", "enabled", { clearLastError: true });
    expect(manager.getPluginState("p1")?.lastError).toBeUndefined();
  });

  it("setPluginStatus — does NOT emit when status is unchanged", () => {
    manager.setPluginStatus("p1", "degraded");
    emitSpy.mockClear();

    manager.setPluginStatus("p1", "degraded");

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("isPluginEnabled — returns true for unknown plugin IDs", () => {
    expect(manager.isPluginEnabled("unknown")).toBe(true);
  });

  it("isPluginEnabled — returns false for a disabled plugin", () => {
    manager.disablePlugin("p1");
    expect(manager.isPluginEnabled("p1")).toBe(false);
  });

  it("isPluginEnabled — returns true for degraded (not disabled)", () => {
    manager.setPluginStatus("p1", "degraded");
    expect(manager.isPluginEnabled("p1")).toBe(true);
  });

  it("listPluginStates — returns all registered plugin states", () => {
    manager.enablePlugin("p1");
    manager.enablePlugin("p2");
    expect(manager.listPluginStates()).toHaveLength(2);
  });
});
