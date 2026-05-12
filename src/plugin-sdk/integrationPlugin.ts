import type { IntegrationPluginManifest } from "../contracts/plugins/integrationPluginManifest.js";
import type { PulseRecord } from "../contracts/records/pulseRecord.js";
import type { RuntimeContext } from "../contracts/runtime/runtimeContext.js";
import type { ZodType } from "zod";

export interface IntegrationPlugin<
  TConfig = unknown,
  TParams = unknown,
  TRaw = unknown,
> {
  readonly manifest: IntegrationPluginManifest;

  /**
   * Optional Zod schema for the plugin config.
   * When present, the platform validates config against this schema at
   * registration time and throws if validation fails.
   */
  readonly configSchema?: ZodType<TConfig>;

  configure?(config: TConfig): Promise<void> | void;

  /** Called once by the platform after registration and before first execution. */
  init?(context: RuntimeContext): Promise<void> | void;

  /** Called once by the platform on graceful shutdown (`stop()`). */
  destroy?(): Promise<void> | void;

  /**
   * Called by the platform when the plugin's status is `needs_reauth`.
   * Implementations should refresh credentials (e.g. exchange a refresh token)
   * and update the secret store so the next `execute()` call succeeds.
   *
   * On success: the platform clears `needs_reauth` and resumes normal execution.
   * On failure: the platform sets the status to `auth_error` and stops scheduling the plugin.
   * When not implemented: the platform warns and skips execution until the host app
   * manually calls `enablePlugin()` after fixing credentials.
   */
  reauth?(context: RuntimeContext): Promise<void> | void;

  execute(
    operationId: string,
    context: RuntimeContext,
    params?: TParams,
  ): Promise<ReadonlyArray<PulseRecord<TRaw>>>;
}
