/**
 * Represents a single secret requirement declared by an integration plugin.
 */
export interface SecretRequirement {
  /** The key used to retrieve the secret (e.g. "OPENSKY_API_KEY") */
  key: string;
  /** Human-readable description of what this secret is used for */
  description?: string;
  /** Whether the secret is mandatory for the plugin to function */
  required: boolean;
}

/**
 * Interface for reading secrets at runtime.
 * Implementations must never log secret values.
 *
 * NOTE: Empty-string values are treated as absent — both `get` and `has`
 * behave as if the key is not set when the value is an empty string.
 * This ensures that environment variables set to "" do not appear as valid secrets.
 */
export interface SecretStore {
  /**
   * Retrieve a secret value by key.
   * Returns undefined if the secret is not set or is an empty string.
   */
  get(key: string): string | undefined;

  /**
   * Check whether a secret is present (without revealing its value).
   * Returns false if the value is an empty string.
   */
  has(key: string): boolean;
}
