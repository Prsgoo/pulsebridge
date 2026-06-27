import type { RuntimeContext } from "../contracts/runtime/runtimeContext.js";
import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { SecretStore } from "../contracts/secrets/secretStore.js";
import type { StateStore } from "../contracts/storage/stateStore.js";
import type { TokenStore } from "../contracts/tokens/tokenStore.js";
import { InMemorySecretStore } from "../contracts/secrets/inMemorySecretStore.js";
import { ConsoleLogger } from "./consoleLogger.js";

export interface CreateRuntimeContextOptions {
  logger?: PulseLogger;
  secrets?: SecretStore;
  tokens?: TokenStore;
  stateStore?: StateStore;
}

export function createRuntimeContext(
  options: CreateRuntimeContextOptions = {},
): RuntimeContext {
  const logger = options.logger ?? new ConsoleLogger();
  const secrets = options.secrets ?? new InMemorySecretStore();

  return {
    logger,
    secrets,
    ...(options.tokens !== undefined ? { tokens: options.tokens } : {}),
    ...(options.stateStore !== undefined
      ? { stateStore: options.stateStore }
      : {}),
    now(): Date {
      return new Date();
    },
  };
}
