/**
 * An OAuth2 token held by the platform on behalf of an integration plugin.
 */
export interface OAuthToken {
  accessToken: string;
  /** ISO-8601 date-time string. When present, the platform will proactively trigger reauth() before this time. */
  expiresAt?: string;
  /** Opaque refresh token — stored but never logged. */
  refreshToken?: string;
  scope?: string;
}

/**
 * Stores and retrieves OAuth tokens keyed by an arbitrary string (typically the plugin ID).
 * Implementations must never log token values.
 */
export interface TokenStore {
  get(key: string): OAuthToken | undefined;
  set(key: string, token: OAuthToken): void;
  delete(key: string): void;
  has(key: string): boolean;
}
