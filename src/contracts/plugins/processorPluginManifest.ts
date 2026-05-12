import type { Capability } from "../constants/capabilities.js";
import type { PluginKinds } from "../constants/pluginKinds.js";

export interface ProcessorPluginManifest {
  id: string;
  name: string;
  version: string;
  kind: typeof PluginKinds.PROCESSOR;

  /**
   * Record types this processor consumes. The platform filters incoming records
   * to only those whose `type` matches an entry in this array before calling `process()`.
   *
   * An empty array (`consumes: []`) disables filtering — the processor will receive
   * every record type present in the store.
   */
  consumes: ReadonlyArray<string>;
  produces?: ReadonlyArray<string>;

  /**
   * View names produced by other processors that this processor depends on.
   * When set, the platform fetches these views from the view store and passes them
   * as the third argument to `process()`. Processors with `consumesViews` are
   * always executed after processors that do not declare this field.
   */
  consumesViews?: ReadonlyArray<string>;

  providesCapabilities?: ReadonlyArray<Capability>;
  recommendsCapabilities?: ReadonlyArray<Capability>;
}
