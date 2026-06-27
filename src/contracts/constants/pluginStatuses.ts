export const PluginStatuses = {
  ENABLED: "enabled",
  DISABLED: "disabled",
  AUTH_ERROR: "auth_error",
  NEEDS_REAUTH: "needs_reauth",
  RATE_LIMITED: "rate_limited",
  MISCONFIGURED: "misconfigured",
  DEGRADED: "degraded",
} as const;

export type PluginStatus = (typeof PluginStatuses)[keyof typeof PluginStatuses];
