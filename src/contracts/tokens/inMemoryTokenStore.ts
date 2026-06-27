import type { OAuthToken, TokenStore } from "./tokenStore.js";

export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, OAuthToken>();

  get(key: string): OAuthToken | undefined {
    return this.tokens.get(key);
  }

  set(key: string, token: OAuthToken): void {
    this.tokens.set(key, token);
  }

  delete(key: string): void {
    this.tokens.delete(key);
  }

  has(key: string): boolean {
    return this.tokens.has(key);
  }
}
