import { ScopedSecretAccessError } from "../errors/pulseErrors.js";
import type { SecretRequirement, SecretStore } from "./secretStore.js";

export class ScopedSecretStore implements SecretStore {
  constructor(
    private readonly store: SecretStore,
    private readonly allowedKeys: ReadonlySet<string>,
  ) {}

  get(key: string): string | undefined {
    if (!this.allowedKeys.has(key)) {
      throw new ScopedSecretAccessError(key);
    }
    return this.store.get(key);
  }

  has(key: string): boolean {
    if (!this.allowedKeys.has(key)) {
      return false;
    }
    return this.store.has(key);
  }
}

/**
 * Helper to build a ScopedSecretStore from a list of SecretRequirements.
 */
export function createScopedSecretStore(
  store: SecretStore,
  requirements: ReadonlyArray<SecretRequirement>,
): ScopedSecretStore {
  const allowedKeys = new Set(requirements.map((r) => r.key));
  return new ScopedSecretStore(store, allowedKeys);
}
