/**
 * Simple key-value store for plugin state that needs to survive across
 * processor executions. Plugins are responsible for namespacing their own
 * keys (e.g. using their plugin ID as a prefix).
 *
 * Values are always strings — plugins serialize/deserialize as needed
 * (e.g. JSON.stringify / JSON.parse).
 */
export interface StateStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
