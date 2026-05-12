import type { PulseLogger } from "./pulseLogger.js";
import type { SecretStore } from "../secrets/secretStore.js";
import type { StateStore } from "../storage/stateStore.js";
import type { TokenStore } from "../tokens/tokenStore.js";

export interface RuntimeContext {
  logger: PulseLogger;
  now(): Date;
  /**
   * Scoped secret access for the currently executing plugin.
   * Only keys declared in the plugin's auth.secrets manifest are accessible.
   */
  secrets: SecretStore;
  /**
   * OAuth2 token store shared by all plugins. Plugins that perform OAuth2 flows
   * should persist tokens here keyed by their plugin ID so the platform can
   * track expiry and trigger proactive reauth before tokens expire.
   * Present only when a TokenStore was passed to PulseBridgeCoreOptions.
   */
  tokens?: TokenStore;
  /**
   * Key-value store for plugin state that must survive across individual
   * processor executions within a single run. Plugins should namespace their
   * own keys (e.g. prefix with the plugin ID) to avoid collisions.
   * Use RedisStateStore to persist state across process restarts.
   * Present only when a StateStore was passed to PulseBridgeCoreOptions.
   */
  stateStore?: StateStore;
}
