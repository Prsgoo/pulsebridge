import type { SecretStore } from "./secretStore.js";

/**
 * Reads secrets from environment variables (`process.env`).
 * Suitable for production deployments where secrets are injected via the environment.
 */
export class EnvSecretStore implements SecretStore {
  get(key: string): string | undefined {
    const val = process.env[key];
    return val !== undefined && val !== "" ? val : undefined;
  }

  has(key: string): boolean {
    const val = process.env[key];
    return val !== undefined && val !== "";
  }
}
