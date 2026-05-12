import type { SecretStore } from "./secretStore.js";

export class InMemorySecretStore implements SecretStore {
  private readonly secrets: Map<string, string>;

  constructor(initialSecrets: Record<string, string> = {}) {
    this.secrets = new Map(Object.entries(initialSecrets));
  }

  get(key: string): string | undefined {
    if (key === "") return undefined;
    const value = this.secrets.get(key);
    return value === "" ? undefined : value;
  }

  has(key: string): boolean {
    if (key === "") return false;
    return this.secrets.get(key) !== undefined && this.secrets.get(key) !== "";
  }

  /**
   * Sets a secret at runtime. Intended for test setup and initial configuration only.
   * Do not call this from application code after the platform has started.
   * @internal
   */
  set(key: string, value: string): void {
    this.secrets.set(key, value);
  }
}
