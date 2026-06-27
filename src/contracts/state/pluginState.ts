import type { PluginStatus } from "../constants/pluginStatuses.js";

/** Health of a single non-polling capability channel (actions, webhooks). */
export type ChannelStatus =
  | "ok"
  | "auth_error"
  | "needs_reauth"
  | "rate_limited"
  | "degraded";

export interface ChannelHealth {
  status: ChannelStatus;
  lastError?: string;
  /** ISO-8601 timestamp of the last invocation that set this status. */
  lastAt?: string;
}

export interface PluginState {
  pluginId: string;
  status: PluginStatus;
  lastRunAt?: string;
  lastError?: string;
  disabledReason?: string;
  /**
   * Per-capability health for non-polling channels. A genuine endpoint failure
   * (auth/connectivity) on an action or webhook is recorded here without
   * tripping the polling circuit breaker. A plugin can be `enabled` (polling
   * fine) while an action channel is `auth_error` — "healthy" means every
   * channel works. Client-input errors never appear here.
   */
  channels?: {
    action?: ChannelHealth;
    webhook?: ChannelHealth;
  };
}
