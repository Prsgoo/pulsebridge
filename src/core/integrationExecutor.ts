import type { PulseRecord } from "../contracts/records/pulseRecord.js";
import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { RecordStore } from "../contracts/storage/recordStore.js";
import type { RuntimeContext } from "../contracts/runtime/runtimeContext.js";
import type { SecretStore } from "../contracts/secrets/secretStore.js";
import type { TokenStore } from "../contracts/tokens/tokenStore.js";
import type { IntegrationPlugin } from "../plugin-sdk/integrationPlugin.js";
import type { AuthDefinition } from "../contracts/plugins/integrationPluginManifest.js";
import type { PluginStateManager } from "./pluginStateManager.js";
import type { PluginRegistry, RegisteredOperation } from "./pluginRegistry.js";
import type { BackoffManager } from "./backoffManager.js";
import { PluginStatuses } from "../contracts/constants/pluginStatuses.js";
import { createScopedSecretStore } from "../contracts/secrets/scopedSecretStore.js";
import {
  PluginAuthError,
  PulseBridgeError,
  RateLimitError,
  ReauthRequiredError,
  TransientError,
} from "../contracts/errors/pulseErrors.js";

const MIN_INTERVAL_MS = 1_000;
const TRANSIENT_DEFAULT_BACKOFF_MS = 30_000;

export interface IntegrationExecutorOptions {
  registry: PluginRegistry;
  stateManager: PluginStateManager;
  backoffManager: BackoffManager;
  recordStore: RecordStore;
  globalSecretStore: SecretStore;
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
  private readonly globalSecretStore: SecretStore;
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
    this.globalSecretStore = options.globalSecretStore;
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

    if (!this.checkMissingSecrets(pluginId, authDef)) return [];

    const scopedContext: RuntimeContext = {
      ...this.context,
      secrets: createScopedSecretStore(
        this.globalSecretStore,
        authDef?.secrets ?? [],
      ),
    };

    // Token expiry check — proactively trigger reauth before a known-expired token is used.
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

  private checkMissingSecrets(
    pluginId: string,
    authDef: AuthDefinition | undefined,
  ): boolean {
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

    const missingRequired = authDef.secrets.filter(
      (req) => req.required && !this.globalSecretStore.has(req.key),
    );

    if (missingRequired.length > 0) {
      const missingKeys = missingRequired.map((r) => r.key).join(", ");
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.AUTH_ERROR, {
        lastRunAt: this.context.now().toISOString(),
        lastError: `Missing required secrets: ${missingKeys}`,
      });
      this.logger.warn("Skipping plugin due to missing secrets.", {
        pluginId,
        missingSecrets: missingKeys,
      });
      return false;
    }

    const missingOptional = authDef.secrets.filter(
      (req) => !req.required && !this.globalSecretStore.has(req.key),
    );
    if (missingOptional.length > 0) {
      this.logger.debug(
        "Plugin has declared optional secrets that are not configured.",
        {
          pluginId,
          missingOptionalSecrets: missingOptional.map((r) => r.key).join(", "),
        },
      );
    }

    return true;
  }

  private async handleReauth(
    pluginId: string,
    integration: IntegrationPlugin,
    scopedContext: RuntimeContext,
  ): Promise<boolean> {
    if (!integration.reauth) {
      this.logger.warn(
        "Plugin requires re-authentication but does not implement reauth(). Skipping until manually re-enabled.",
        { pluginId },
      );
      return false;
    }

    try {
      await this.withTimeout(
        Promise.resolve(integration.reauth(scopedContext)),
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
        const last = this.backoffManager.getLastRateLimitAt(pluginId);
        if (last !== undefined) {
          const elapsed = Date.now() - last;
          if (elapsed < minGapMs) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, minGapMs - elapsed),
            );
          }
        }
      }
      this.backoffManager.setLastRateLimitAt(pluginId, Date.now());

      try {
        const records = await this.withTimeout(
          integration.execute(
            operation.operationId,
            scopedContext,
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

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new PulseBridgeError(`${label} timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
