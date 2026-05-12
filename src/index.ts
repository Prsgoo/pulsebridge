// Public surface of the `pulsebridge` package.
// Consumers import everything from this single entry point.

// ── contracts ────────────────────────────────────────────────────────────────
export * from "./contracts/constants/capabilities.js";
export * from "./contracts/constants/pluginKinds.js";
export * from "./contracts/constants/pluginStatuses.js";
export * from "./contracts/constants/recordTypes.js";
export * from "./contracts/constants/viewTypes.js";

export * from "./contracts/errors/pulseErrors.js";

export * from "./contracts/integrations/integrationOperationDefinition.js";

export * from "./contracts/plugins/integrationPluginManifest.js";
export * from "./contracts/plugins/processorPluginManifest.js";

export * from "./contracts/records/pulseRecord.js";
export * from "./contracts/records/pulseViewRecord.js";

export * from "./contracts/runtime/pulseLogger.js";
export * from "./contracts/runtime/runtimeContext.js";

export * from "./contracts/secrets/envSecretStore.js";
export * from "./contracts/secrets/inMemorySecretStore.js";
export * from "./contracts/secrets/scopedSecretStore.js";
export * from "./contracts/secrets/secretStore.js";

export * from "./contracts/state/pluginState.js";

export * from "./contracts/tokens/inMemoryTokenStore.js";
export * from "./contracts/tokens/tokenStore.js";

export * from "./contracts/storage/recordStore.js";
export * from "./contracts/storage/stateStore.js";
export * from "./contracts/storage/viewStore.js";

// ── plugin-sdk ────────────────────────────────────────────────────────────────
export * from "./plugin-sdk/integrationPlugin.js";
export * from "./plugin-sdk/processorPlugin.js";

// ── store-redis ───────────────────────────────────────────────────────────────
export * from "./store-redis/createRedisClient.js";
export * from "./store-redis/redisRecordStore.js";
export * from "./store-redis/redisStateStore.js";
export * from "./store-redis/redisViewStore.js";

// ── core runtime ──────────────────────────────────────────────────────────────
export * from "./runtime/consoleLogger.js";

export * from "./storage/inMemoryRecordStore.js";
export * from "./storage/inMemoryStateStore.js";
export * from "./storage/inMemoryViewStore.js";

export * from "./validation/capabilityValidator.js";

export * from "./core/pulseBridgeCore.js";
