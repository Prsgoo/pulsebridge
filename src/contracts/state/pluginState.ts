import type { PluginStatus } from "../constants/pluginStatuses.js";

export interface PluginState {
  pluginId: string;
  status: PluginStatus;
  lastRunAt?: string;
  lastError?: string;
  disabledReason?: string;
}
