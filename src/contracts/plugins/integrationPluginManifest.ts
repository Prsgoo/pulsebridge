import type { Capability } from "../constants/capabilities.js";
import type { IntegrationOperationDefinition } from "../integrations/integrationOperationDefinition.js";
import type { SecretRequirement } from "../secrets/secretStore.js";
import type { PluginKinds } from "../constants/pluginKinds.js";

export interface RateLimitDefinition {
  /**
   * Maximum number of API requests per minute across all operations.
   * The platform enforces a minimum gap of `60_000 / requestsPerMinute` ms between requests.
   */
  requestsPerMinute?: number;
  /**
   * Maximum number of concurrent operation executions for this plugin.
   * Currently operations execute sequentially; this field is respected as a declaration
   * of intent and will gate future parallel execution support.
   */
  maxConcurrentRequests?: number;
}

/**
 * Hard polling: the platform ignores any user-supplied override.
 * Use this when the API enforces a fixed rate limit.
 */
export interface HardPollingConfig {
  defaultIntervalMs: number;
  hard: true;
}

/**
 * Flexible polling: the user may override `defaultIntervalMs` downward
 * to `minIntervalMs` at most. The platform enforces a minimum of 1000ms
 * regardless of this value.
 */
export interface FlexiblePollingConfig {
  defaultIntervalMs: number;
  minIntervalMs?: number;
  hard: false;
}

/** Polling schedule declaration for integration plugins. */
export type PollingConfig = HardPollingConfig | FlexiblePollingConfig;

/**
 * Auth declaration for integration plugins.
 * - type: the auth scheme used
 * - secrets: the list of secrets this plugin needs access to at runtime
 */
export interface AuthDefinition {
  type: "none" | "apiKey" | "bearerToken" | "oauth2";
  secrets?: ReadonlyArray<SecretRequirement>;
  /**
   * For oauth2 type: the key used to look up this plugin's token in the TokenStore.
   * Defaults to the plugin ID if not set.
   */
  tokenKey?: string;
}

export interface IntegrationPluginManifest {
  id: string;
  name: string;
  version: string;
  kind: typeof PluginKinds.INTEGRATION;

  operations: ReadonlyArray<IntegrationOperationDefinition>;

  auth?: AuthDefinition;
  rateLimit?: RateLimitDefinition;
  polling?: PollingConfig;

  requiresCapabilities?: ReadonlyArray<Capability>;
  recommendsCapabilities?: ReadonlyArray<Capability>;
}
