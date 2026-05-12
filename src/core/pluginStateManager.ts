import type { PluginState } from "../contracts/state/pluginState.js";
import type { PluginStatusChangedEvent } from "./pulseBridgeCore.js";

export interface SetPluginStatusOptions {
  lastRunAt?: string;
  lastError?: string;
  disabledReason?: string;
  /** When true, clears any existing lastError rather than carrying it forward. */
  clearLastError?: true;
}

/** Internal class that owns all plugin state transitions. */
export class PluginStateManager {
  private readonly pluginStates = new Map<string, PluginState>();
  private readonly emit: (
    event: "plugin:status-changed",
    payload: PluginStatusChangedEvent,
  ) => void;

  constructor(
    emit: (
      event: "plugin:status-changed",
      payload: PluginStatusChangedEvent,
    ) => void,
  ) {
    this.emit = emit;
  }

  enablePlugin(pluginId: string): void {
    const existing = this.pluginStates.get(pluginId);
    const previousStatus = existing?.status;
    this.pluginStates.set(pluginId, {
      pluginId,
      status: "enabled",
      // Preserve lastRunAt for history, but clear lastError — enablePlugin signals a fresh start.
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    });
    if (previousStatus !== "enabled") {
      this.emit("plugin:status-changed", {
        pluginId,
        previousStatus,
        newStatus: "enabled",
      });
    }
  }

  disablePlugin(pluginId: string, reason?: string): void {
    const previousStatus = this.pluginStates.get(pluginId)?.status;
    const fields = this.mergeStateFields(
      pluginId,
      reason ? { disabledReason: reason } : {},
    );
    this.pluginStates.set(pluginId, {
      pluginId,
      status: "disabled",
      ...fields,
    });
    if (previousStatus !== "disabled") {
      this.emit("plugin:status-changed", {
        pluginId,
        previousStatus,
        newStatus: "disabled",
      });
    }
  }

  setPluginStatus(
    pluginId: string,
    status: PluginState["status"],
    options: SetPluginStatusOptions = {},
  ): void {
    const previousStatus = this.pluginStates.get(pluginId)?.status;
    const fields = this.mergeStateFields(pluginId, options);
    if (options.clearLastError) {
      delete fields.lastError;
    }
    // Do not carry disabledReason forward when transitioning away from disabled.
    if (status !== "disabled") {
      delete fields.disabledReason;
    }
    this.pluginStates.set(pluginId, { pluginId, status, ...fields });
    if (previousStatus !== status) {
      this.emit("plugin:status-changed", {
        pluginId,
        previousStatus,
        newStatus: status,
      });
    }
  }

  /** Returns true if the plugin is not explicitly disabled.
   *  Returns true for unknown plugin IDs — unregistered plugins are not considered disabled. */
  isPluginEnabled(pluginId: string): boolean {
    const state = this.pluginStates.get(pluginId);
    if (!state) return true;
    return state.status !== "disabled";
  }

  getPluginState(pluginId: string): PluginState | undefined {
    return this.pluginStates.get(pluginId);
  }

  listPluginStates(): ReadonlyArray<PluginState> {
    return Array.from(this.pluginStates.values());
  }

  private mergeStateFields(
    pluginId: string,
    overrides: Partial<
      Pick<PluginState, "lastRunAt" | "lastError" | "disabledReason">
    > = {},
  ): Partial<Pick<PluginState, "lastRunAt" | "lastError" | "disabledReason">> {
    const existing = this.pluginStates.get(pluginId);
    const lastRunAt = overrides.lastRunAt ?? existing?.lastRunAt;
    const lastError = overrides.lastError ?? existing?.lastError;
    const disabledReason = overrides.disabledReason ?? existing?.disabledReason;
    return {
      ...(lastRunAt ? { lastRunAt } : {}),
      ...(lastError ? { lastError } : {}),
      ...(disabledReason ? { disabledReason } : {}),
    };
  }
}
