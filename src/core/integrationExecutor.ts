import type { ActionResult } from "../contracts/actions/actionDefinition.js";
import type {
  WebhookRequest,
  WebhookResult,
} from "../contracts/webhooks/webhookDefinition.js";
import type {
  ChannelHealth,
  ChannelStatus,
} from "../contracts/state/pluginState.js";
import type { PluginChannel } from "./pluginStateManager.js";
import type { PulseRecord } from "../contracts/records/pulseRecord.js";
import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { RecordStore } from "../contracts/storage/recordStore.js";
import type { RuntimeContext } from "../contracts/runtime/runtimeContext.js";
import type { SecretStore } from "../contracts/secrets/secretStore.js";
import type { EncryptedSecretVault } from "../contracts/secrets/encryptedSecretVault.js";
import type { TokenStore } from "../contracts/tokens/tokenStore.js";
import type { IntegrationPlugin } from "../plugin-sdk/integrationPlugin.js";
import type { AuthDefinition } from "../contracts/plugins/integrationPluginManifest.js";
import type { PluginStateManager } from "./pluginStateManager.js";
import type { PluginRegistry, RegisteredOperation } from "./pluginRegistry.js";
import type { BackoffManager } from "./backoffManager.js";
import { PluginStatuses } from "../contracts/constants/pluginStatuses.js";
import { InMemorySecretStore } from "../contracts/secrets/inMemorySecretStore.js";
import { createScopedSecretStore } from "../contracts/secrets/scopedSecretStore.js";
import {
  PluginAuthError,
  PluginInputError,
  RateLimitError,
  ReauthRequiredError,
  TransientError,
} from "../contracts/errors/pulseErrors.js";
import { withTimeout } from "./withTimeout.js";

const MIN_INTERVAL_MS = 1_000;
const TRANSIENT_DEFAULT_BACKOFF_MS = 30_000;

export interface IntegrationExecutorOptions {
  registry: PluginRegistry;
  stateManager: PluginStateManager;
  backoffManager: BackoffManager;
  recordStore: RecordStore;
  vault: EncryptedSecretVault;
  tokenStore: TokenStore | undefined;
  executionTimeoutMs: number;
  rateLimitDefaultBackoffMs: number | undefined;
  context: RuntimeContext;
}

/**
 * Executes a single integration plugin run: guards, secret checks, reauth,
 * operation loop, and record persistence.
 */
export class IntegrationExecutor {
  private readonly registry: PluginRegistry;
  private readonly stateManager: PluginStateManager;
  private readonly backoffManager: BackoffManager;
  private readonly recordStore: RecordStore;
  private readonly vault: EncryptedSecretVault;
  private readonly tokenStore: TokenStore | undefined;
  private readonly executionTimeoutMs: number;
  private readonly rateLimitDefaultBackoffMs: number | undefined;
  private readonly context: RuntimeContext;
  private readonly logger: PulseLogger;

  private readonly executingPlugins = new Set<string>();
  private readonly lastExecutionAt = new Map<string, number>();

  constructor(options: IntegrationExecutorOptions) {
    this.registry = options.registry;
    this.stateManager = options.stateManager;
    this.backoffManager = options.backoffManager;
    this.recordStore = options.recordStore;
    this.vault = options.vault;
    this.tokenStore = options.tokenStore;
    this.executionTimeoutMs = options.executionTimeoutMs;
    this.rateLimitDefaultBackoffMs = options.rateLimitDefaultBackoffMs;
    this.context = options.context;
    this.logger = options.context.logger;
  }

  execute(
    pluginId: string,
    options: { forceRun?: boolean } = {},
  ): Promise<string[]> {
    if (!this.stateManager.isPluginEnabled(pluginId)) {
      this.logger.info("Skipping disabled integration plugin.", { pluginId });
      return Promise.resolve([]);
    }

    if (this.executingPlugins.has(pluginId)) {
      this.logger.debug(
        "Skipping plugin — previous execution still in progress.",
        { pluginId },
      );
      return Promise.resolve([]);
    }

    if (!options.forceRun && this.isWithinMinInterval(pluginId)) {
      this.logger.debug(
        "Skipping integration plugin — within minimum poll interval.",
        { pluginId },
      );
      return Promise.resolve([]);
    }

    if (!options.forceRun && this.backoffManager.isRateLimited(pluginId)) {
      this.logger.debug(
        "Skipping integration plugin — rate limit backoff in effect.",
        {
          pluginId,
          backoffRemainingMs:
            this.backoffManager.rateLimitBackoffRemaining(pluginId),
        },
      );
      return Promise.resolve([]);
    }

    if (!options.forceRun && this.backoffManager.isDegradedBackoff(pluginId)) {
      this.logger.debug("Skipping degraded plugin — backoff in effect.", {
        pluginId,
        backoffRemainingMs:
          this.backoffManager.degradedBackoffRemaining(pluginId),
      });
      return Promise.resolve([]);
    }

    this.lastExecutionAt.set(pluginId, Date.now());
    this.executingPlugins.add(pluginId);

    return this.runCore(pluginId).finally(() => {
      this.executingPlugins.delete(pluginId);
    });
  }

  private isWithinMinInterval(pluginId: string): boolean {
    const lastRun = this.lastExecutionAt.get(pluginId);
    if (lastRun === undefined) return false;
    return Date.now() - lastRun < this.registry.getEffectiveInterval(pluginId);
  }

  private async runCore(pluginId: string): Promise<string[]> {
    const integration = this.registry.getIntegration(pluginId);
    if (!integration) return [];

    const authDef = integration.manifest.auth;

    if (!(await this.checkMissingSecrets(pluginId, authDef))) return [];

    const scopedContext: RuntimeContext = {
      ...this.context,
      secrets: await this.buildScopedSecrets(pluginId, authDef),
    };

    if (this.tokenStore && authDef?.type === "oauth2") {
      const tokenKey = authDef.tokenKey ?? pluginId;
      const token = this.tokenStore.get(tokenKey);
      if (token?.expiresAt && new Date(token.expiresAt) <= this.context.now()) {
        this.stateManager.setPluginStatus(
          pluginId,
          PluginStatuses.NEEDS_REAUTH,
          { lastError: "OAuth2 token expired" },
        );
        this.logger.info("OAuth2 token expired — triggering reauth.", {
          pluginId,
          tokenKey,
        });
      }
    }

    const currentStatus = this.stateManager.getPluginState(pluginId)?.status;
    if (currentStatus === PluginStatuses.NEEDS_REAUTH) {
      const ok = await this.handleReauth(pluginId, integration, scopedContext);
      if (!ok) return [];
    }

    const operations = this.registry.getOperations(pluginId);
    const { records, updatedTypes, failed } = await this.executeOperations(
      pluginId,
      integration,
      operations,
      scopedContext,
    );

    if (!failed) {
      this.backoffManager.clearIntegrationBackoff(pluginId);
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.ENABLED, {
        lastRunAt: this.context.now().toISOString(),
        clearLastError: true,
      });

      const stored = await this.persistRecords(pluginId, records);
      if (!stored) return [];
    }

    return failed ? [] : updatedTypes;
  }

  /**
   * Builds the per-run secret store the plugin sees in `context.secrets`. Each
   * declared key is read from the vault under the plugin's own namespace and
   * snapshotted into a flat store, then scoped to the declared keys so an
   * undeclared access still throws. Returns an empty (deny-all) store when no
   * master key is configured.
   */
  private async buildScopedSecrets(
    pluginId: string,
    authDef: AuthDefinition | undefined,
  ): Promise<SecretStore> {
    const declared = authDef?.secrets ?? [];
    const snapshot: Record<string, string> = {};

    if (this.vault.hasMasterKey) {
      for (const req of declared) {
        const value = await this.vault.get(pluginId, req.key);
        if (value !== undefined) snapshot[req.key] = value;
      }
    }

    return createScopedSecretStore(new InMemorySecretStore(snapshot), declared);
  }

  private async checkMissingSecrets(
    pluginId: string,
    authDef: AuthDefinition | undefined,
  ): Promise<boolean> {
    if (authDef?.type === "oauth2" && !this.context.tokens) {
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.AUTH_ERROR, {
        lastRunAt: this.context.now().toISOString(),
        lastError:
          "oauth2 auth requires a TokenStore configured on PulseBridgeCore",
      });
      this.logger.warn(
        "Skipping plugin — oauth2 auth requires a TokenStore but none is configured.",
        { pluginId },
      );
      return false;
    }

    if (!authDef?.secrets) return true;

    const requiredKeys = authDef.secrets
      .filter((req) => req.required)
      .map((req) => req.key);

    if (!this.vault.hasMasterKey) {
      if (requiredKeys.length > 0) {
        return this.failMissingSecrets(
          pluginId,
          `No master key configured to read required secrets: ${requiredKeys.join(", ")}`,
          requiredKeys.join(", "),
        );
      }
      return true;
    }

    const missingRequired: string[] = [];
    for (const key of requiredKeys) {
      if (!(await this.vault.has(pluginId, key))) missingRequired.push(key);
    }

    if (missingRequired.length > 0) {
      const missingKeys = missingRequired.join(", ");
      return this.failMissingSecrets(
        pluginId,
        `Missing required secrets: ${missingKeys}`,
        missingKeys,
      );
    }

    const missingOptional: string[] = [];
    for (const req of authDef.secrets) {
      if (req.required) continue;
      if (!(await this.vault.has(pluginId, req.key)))
        missingOptional.push(req.key);
    }
    if (missingOptional.length > 0) {
      this.logger.debug(
        "Plugin has declared optional secrets that are not configured.",
        { pluginId, missingOptionalSecrets: missingOptional.join(", ") },
      );
    }

    return true;
  }

  private failMissingSecrets(
    pluginId: string,
    lastError: string,
    missingSecrets: string,
  ): boolean {
    this.stateManager.setPluginStatus(pluginId, PluginStatuses.AUTH_ERROR, {
      lastRunAt: this.context.now().toISOString(),
      lastError,
    });
    this.logger.warn("Skipping plugin due to missing secrets.", {
      pluginId,
      missingSecrets,
    });
    return false;
  }

  private async handleReauth(
    pluginId: string,
    integration: IntegrationPlugin,
    scopedContext: RuntimeContext,
  ): Promise<boolean> {
    const reauth = integration.reauth;
    if (!reauth) {
      this.logger.warn(
        "Plugin requires re-authentication but does not implement reauth(). Skipping until manually re-enabled.",
        { pluginId },
      );
      return false;
    }

    try {
      await withTimeout(
        (signal) => Promise.resolve(reauth({ ...scopedContext, signal })),
        this.executionTimeoutMs,
        `${pluginId}.reauth`,
      );
      this.backoffManager.clearIntegrationBackoff(pluginId);
      this.stateManager.enablePlugin(pluginId);
      this.logger.info("Plugin re-authentication succeeded.", { pluginId });
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Reauth failed";
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.AUTH_ERROR, {
        lastRunAt: this.context.now().toISOString(),
        lastError: errorMessage,
      });
      this.logger.error("Plugin re-authentication failed.", {
        pluginId,
        error: errorMessage,
      });
      return false;
    }
  }

  private async executeOperations(
    pluginId: string,
    integration: IntegrationPlugin,
    operations: ReadonlyArray<RegisteredOperation>,
    scopedContext: RuntimeContext,
  ): Promise<{
    records: PulseRecord[];
    updatedTypes: string[];
    failed: boolean;
  }> {
    const collectedRecords: PulseRecord[] = [];
    const updatedTypes = new Set<string>();
    let failed = false;

    const rateLimit = integration.manifest.rateLimit;
    const minGapMs = rateLimit?.requestsPerMinute
      ? Math.ceil(60_000 / rateLimit.requestsPerMinute)
      : 0;

    for (const operation of operations) {
      if (minGapMs > 0) {
        const last = this.backoffManager.getLastRequestAt(pluginId);
        if (last !== undefined) {
          const elapsed = Date.now() - last;
          if (elapsed < minGapMs) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, minGapMs - elapsed),
            );
          }
        }
      }
      this.backoffManager.setLastRequestAt(pluginId, Date.now());

      try {
        const records = await withTimeout(
          (signal) =>
            integration.execute(
              operation.operationId,
              { ...scopedContext, signal },
              operation.params,
            ),
          this.executionTimeoutMs,
          `${pluginId}.${operation.operationId}`,
        );

        for (const record of records) {
          collectedRecords.push(record);
          updatedTypes.add(record.type);
        }
      } catch (error) {
        failed = true;
        this.handleOperationError(pluginId, operation.operationId, error);
        break;
      }
    }

    return {
      records: collectedRecords,
      updatedTypes: Array.from(updatedTypes),
      failed,
    };
  }

  private handleOperationError(
    pluginId: string,
    operationId: string,
    error: unknown,
  ): void {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown integration error";
    const runAt = this.context.now().toISOString();

    if (error instanceof RateLimitError) {
      const backoffMs =
        error.retryAfterMs ??
        this.rateLimitDefaultBackoffMs ??
        this.registry.getEffectiveInterval(pluginId) * 2;
      this.backoffManager.setRateLimitBackoff(pluginId, Date.now() + backoffMs);
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.RATE_LIMITED, {
        lastRunAt: runAt,
        lastError: errorMessage,
      });
      this.logger.warn("Integration is rate limited — backing off.", {
        pluginId,
        operationId,
        backoffMs,
      });
    } else if (error instanceof ReauthRequiredError) {
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.NEEDS_REAUTH, {
        lastRunAt: runAt,
        lastError: errorMessage,
      });
      this.logger.warn("Integration requires re-authentication.", {
        pluginId,
        operationId,
      });
    } else if (error instanceof PluginAuthError) {
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.AUTH_ERROR, {
        lastRunAt: runAt,
        lastError: errorMessage,
      });
      this.logger.warn("Integration authentication failed.", {
        pluginId,
        operationId,
        error: errorMessage,
      });
    } else if (error instanceof TransientError) {
      const backoffMs = error.retryAfterMs ?? TRANSIENT_DEFAULT_BACKOFF_MS;
      this.backoffManager.setTransientBackoff(pluginId, backoffMs);
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.DEGRADED, {
        lastRunAt: runAt,
        lastError: errorMessage,
      });
      this.logger.warn(
        "Integration hit a transient error — retrying after short backoff.",
        { pluginId, operationId, error: errorMessage, backoffMs },
      );
    } else {
      const outcome = this.backoffManager.applyIntegrationBackoff(
        pluginId,
        errorMessage,
        Math.max(this.registry.getEffectiveInterval(pluginId), MIN_INTERVAL_MS),
      );
      if (outcome === "backoff_applied") {
        this.stateManager.setPluginStatus(pluginId, PluginStatuses.DEGRADED, {
          lastRunAt: runAt,
          lastError: errorMessage,
        });
        this.logger.error("Integration execution failed.", {
          pluginId,
          operationId,
          error: errorMessage,
          consecutiveFailures:
            this.backoffManager.getConsecutiveFailures(pluginId),
          backoffMs: this.backoffManager.degradedBackoffRemaining(pluginId),
        });
      } else {
        this.logger.error(
          "Integration circuit breaker tripped — plugin disabled until manually re-enabled.",
          { pluginId, operationId },
        );
      }
    }
  }

  /**
   * Invokes an outbound action (push-out). Runs under the same timeout and
   * scoped-secret model as polling, but failures are recorded on the plugin's
   * action *channel* — they never trip the polling circuit breaker. A client
   * fault (`PluginInputError`) is re-thrown without touching channel health.
   * Returns the plugin's `ActionResult`; any `records` it returns are appended.
   */
  async invokeAction(
    pluginId: string,
    actionId: string,
    payload?: unknown,
  ): Promise<ActionResult> {
    const integration = this.registry.getIntegration(pluginId);
    if (!integration?.invoke) {
      throw new PluginInputError(
        `Plugin '${pluginId}' does not support actions.`,
      );
    }
    const declared = integration.manifest.actions ?? [];
    if (!declared.some((action) => action.id === actionId)) {
      throw new PluginInputError(
        `Plugin '${pluginId}' does not declare action '${actionId}'.`,
      );
    }

    const invoke = integration.invoke.bind(integration);
    const result = await this.runChannel(pluginId, "action", (context) =>
      Promise.resolve(invoke(actionId, context, payload)),
    );
    await this.appendChannelRecords(pluginId, result.records);
    return result;
  }

  /**
   * Handles an inbound webhook (push-in). The plugin verifies the sender from
   * the raw request before trusting it. Same fault model as actions: signature
   * or body problems are `PluginInputError` (re-thrown, no health change);
   * genuine endpoint failures degrade the webhook channel. Appends any records.
   */
  async ingestWebhook(
    pluginId: string,
    request: WebhookRequest,
  ): Promise<WebhookResult> {
    const integration = this.registry.getIntegration(pluginId);
    if (!integration?.ingest) {
      throw new PluginInputError(
        `Plugin '${pluginId}' does not accept webhooks.`,
      );
    }

    const ingest = integration.ingest.bind(integration);
    const result = await this.runChannel(pluginId, "webhook", (context) =>
      Promise.resolve(ingest(context, request)),
    );
    await this.appendChannelRecords(pluginId, result.records);
    return result;
  }

  /**
   * Shared execution wrapper for action/webhook channels: builds scoped secrets,
   * runs the plugin call under the execution timeout, and maps the outcome onto
   * the channel's health. Re-throws so the caller (server) can map to HTTP.
   */
  private async runChannel<T extends ActionResult | WebhookResult>(
    pluginId: string,
    channel: PluginChannel,
    run: (context: RuntimeContext) => Promise<T>,
  ): Promise<T> {
    const integration = this.registry.getIntegration(pluginId);
    const authDef = integration?.manifest.auth;
    const scopedContext: RuntimeContext = {
      ...this.context,
      secrets: await this.buildScopedSecrets(pluginId, authDef),
    };

    try {
      const result = await withTimeout(
        (signal) => run({ ...scopedContext, signal }),
        this.executionTimeoutMs,
        `${pluginId}.${channel}`,
      );
      this.stateManager.setChannelHealth(pluginId, channel, {
        status: "ok",
        lastAt: this.context.now().toISOString(),
      });
      return result;
    } catch (error) {
      if (error instanceof PluginInputError) throw error;
      this.recordChannelFault(pluginId, channel, error);
      throw error;
    }
  }

  private recordChannelFault(
    pluginId: string,
    channel: PluginChannel,
    error: unknown,
  ): void {
    const lastError =
      error instanceof Error ? error.message : "Unknown channel error";
    const health: ChannelHealth = {
      status: this.channelStatusFor(error),
      lastError,
      lastAt: this.context.now().toISOString(),
    };
    this.stateManager.setChannelHealth(pluginId, channel, health);
    this.logger.warn("Plugin channel failed.", {
      pluginId,
      channel,
      status: health.status,
      error: lastError,
    });
  }

  private channelStatusFor(error: unknown): ChannelStatus {
    if (error instanceof RateLimitError) return "rate_limited";
    if (error instanceof ReauthRequiredError) return "needs_reauth";
    if (error instanceof PluginAuthError) return "auth_error";
    return "degraded";
  }

  private async appendChannelRecords(
    pluginId: string,
    records: ReadonlyArray<PulseRecord> | undefined,
  ): Promise<void> {
    if (!records || records.length === 0) return;
    try {
      await this.recordStore.append(records);
    } catch (error) {
      this.logger.error("Failed to append channel records to store.", {
        pluginId,
        error: error instanceof Error ? error.message : "Store write failed",
      });
    }
  }

  private async persistRecords(
    pluginId: string,
    records: PulseRecord[],
  ): Promise<boolean> {
    try {
      await this.recordStore.setByPlugin(pluginId, records);
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Store write failed";
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.DEGRADED, {
        lastRunAt: this.context.now().toISOString(),
        lastError: errorMessage,
      });
      this.logger.error(
        "Failed to write records to store — integration output discarded.",
        { pluginId, error: errorMessage },
      );
      return false;
    }
  }
}
