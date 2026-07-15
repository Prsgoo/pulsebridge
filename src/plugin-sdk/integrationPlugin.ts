import type { ActionResult } from "../contracts/actions/actionDefinition.js";
import type { IntegrationPluginManifest } from "../contracts/plugins/integrationPluginManifest.js";
import type { PulseRecord } from "../contracts/records/pulseRecord.js";
import type { RuntimeContext } from "../contracts/runtime/runtimeContext.js";
import type {
  WebhookRequest,
  WebhookResult,
} from "../contracts/webhooks/webhookDefinition.js";
import type { ZodType } from "zod";

/**
 * Shared lifecycle methods that every integration plugin can implement,
 * regardless of which data modes it supports (PULL, PUSH-OUT, PUSH-IN).
 */
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

  /** Required when the manifest declares one or more `operations`. Use {@link PollIntegrationPlugin}. */
  execute?(
    operationId: string,
    context: RuntimeContext,
    params?: TParams,
  ): Promise<ReadonlyArray<PulseRecord<TRaw>>>;

  /** Required when the manifest declares one or more `actions`. Use {@link ActionIntegrationPlugin}. */
  invoke?(
    actionId: string,
    context: RuntimeContext,
    payload?: unknown,
  ): Promise<ActionResult> | ActionResult;

  /** Required when the manifest declares a `webhook`. Use {@link WebhookIntegrationPlugin}. */
  ingest?(
    context: RuntimeContext,
    request: WebhookRequest,
  ): Promise<WebhookResult> | WebhookResult;
}

/**
 * Integration plugin that polls upstream on a schedule (PULL mode).
 * Use this when your manifest declares `operations`. The platform calls
 * `execute()` on each scheduler tick for every declared operation.
 */
export interface PollIntegrationPlugin<
  TConfig = unknown,
  TParams = unknown,
  TRaw = unknown,
> extends IntegrationPlugin<TConfig, TParams, TRaw> {
  execute(
    operationId: string,
    context: RuntimeContext,
    params?: TParams,
  ): Promise<ReadonlyArray<PulseRecord<TRaw>>>;
}

/**
 * Integration plugin that performs outbound actions on demand (PUSH-OUT mode).
 * Use this when your manifest declares `actions`. The platform calls
 * `invoke()` when a host or rule engine triggers the action.
 */
export interface ActionIntegrationPlugin<
  TConfig = unknown,
> extends IntegrationPlugin<TConfig> {
  invoke(
    actionId: string,
    context: RuntimeContext,
    payload?: unknown,
  ): Promise<ActionResult> | ActionResult;
}

/**
 * Integration plugin that receives inbound webhook events (PUSH-IN mode).
 * Use this when your manifest declares a `webhook`. The platform calls
 * `ingest()` when the webhook endpoint receives a request.
 */
export interface WebhookIntegrationPlugin<
  TConfig = unknown,
> extends IntegrationPlugin<TConfig> {
  ingest(
    context: RuntimeContext,
    request: WebhookRequest,
  ): Promise<WebhookResult> | WebhookResult;
}
