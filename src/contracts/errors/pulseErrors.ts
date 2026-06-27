/**
 * Base class for all PulseBridge platform errors.
 * Extend this to create typed, catchable error subclasses.
 */
export class PulseBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PulseBridgeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a plugin cannot authenticate — e.g. a secret is invalid or
 * the credential was rejected by the upstream API.
 *
 * Distinct from a missing-secret check (which is caught by the platform
 * before execute() is called). This error comes from inside execute() when
 * the API itself rejects the credential.
 *
 * The platform sets the plugin status to `auth_error` on receipt.
 */
export class PluginAuthError extends PulseBridgeError {
  constructor(message: string) {
    super(message);
    this.name = "PluginAuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by a plugin when its credentials are expired or require
 * interactive re-authorization (e.g. an OAuth2 token has expired).
 *
 * The platform sets the plugin status to `needs_reauth` on receipt and
 * will call `plugin.reauth()` if the method is implemented.
 */
export class ReauthRequiredError extends PulseBridgeError {
  constructor(message: string = "Plugin requires re-authentication.") {
    super(message);
    this.name = "ReauthRequiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by a plugin when the upstream API returns a rate limit response
 * (e.g. HTTP 429). The platform sets the plugin status to `rate_limited`
 * and applies a backoff before the next scheduled execution.
 *
 * Optionally, `retryAfterMs` can indicate how long to wait before retrying.
 */
export class RateLimitError extends PulseBridgeError {
  readonly retryAfterMs: number | undefined;

  constructor(message: string = "Rate limit exceeded.", retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by a plugin when the upstream API fails with a transient error —
 * e.g. HTTP 5xx, a network hiccup, or a temporary service outage.
 *
 * Unlike a generic error, this signals "retry soon, this is not a bug."
 * The platform keeps the plugin in `degraded` status but applies a short,
 * fixed backoff instead of the full poll-interval-based exponential backoff,
 * and does NOT increment the consecutive-failure counter (so the circuit
 * breaker is not affected).
 *
 * Optionally, `retryAfterMs` overrides the platform's default retry window.
 */
export class TransientError extends PulseBridgeError {
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string = "Transient upstream error.",
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TransientError";
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by a plugin from `invoke()` or `ingest()` when the caller's input is
 * invalid — a malformed body, a missing field, or a payload that fails the
 * plugin's own validation. This is a *client* fault: the request itself is
 * wrong, retrying with the same input will not help.
 *
 * The platform maps this to an HTTP 4xx and does NOT change the plugin's health
 * — a bad request body says nothing about whether the endpoint is reachable.
 */
export class PluginInputError extends PulseBridgeError {
  constructor(message: string = "Invalid request payload.") {
    super(message);
    this.name = "PluginInputError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by `ScopedSecretStore` when a plugin attempts to access a secret
 * key that was not declared in its manifest's `auth.secrets`.
 *
 * The platform catches this as a `PluginAuthError` and sets the plugin
 * status to `auth_error` rather than marking it `degraded`.
 */
export class ScopedSecretAccessError extends PluginAuthError {
  constructor(key: string) {
    super(
      `Plugin is not authorized to access secret "${key}". Declare it in your auth.secrets manifest.`,
    );
    this.name = "ScopedSecretAccessError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a secret operation requires the master key but the core was
 * constructed without one. Secrets are always encrypted at rest, so reading
 * or writing them is impossible until the host supplies a master key.
 *
 * The core fails closed on `start()` if any enabled plugin declares a required
 * secret while no master key is configured.
 */
export class MasterKeyRequiredError extends PulseBridgeError {
  constructor(
    message: string = "A master key is required to read or write secrets, but none was configured.",
  ) {
    super(message);
    this.name = "MasterKeyRequiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a stored secret cannot be decrypted — the master key is wrong,
 * the ciphertext is malformed, or the data was tampered with (GCM auth tag
 * mismatch). The message never contains the plaintext or the key.
 */
export class SecretDecryptionError extends PulseBridgeError {
  constructor(
    message: string = "Failed to decrypt secret (wrong master key or corrupted data).",
  ) {
    super(message);
    this.name = "SecretDecryptionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
