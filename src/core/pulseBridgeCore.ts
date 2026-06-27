import { EventEmitter } from "node:events";

import type { ActionResult } from "../contracts/actions/actionDefinition.js";
import type {
  WebhookRequest,
  WebhookResult,
} from "../contracts/webhooks/webhookDefinition.js";
import type { IntegrationPluginManifest } from "../contracts/plugins/integrationPluginManifest.js";
import type { PluginState } from "../contracts/state/pluginState.js";
import type { PluginStatus } from "../contracts/constants/pluginStatuses.js";
import type { ProcessorPluginManifest } from "../contracts/plugins/processorPluginManifest.js";
import type { PulseRecord } from "../contracts/records/pulseRecord.js";
import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { PulseViewRecord } from "../contracts/records/pulseViewRecord.js";
import type { RecordStore } from "../contracts/storage/recordStore.js";
import type { RuntimeContext } from "../contracts/runtime/runtimeContext.js";
import type { SecretBackend } from "../contracts/secrets/secretBackend.js";
import type { TokenStore } from "../contracts/tokens/tokenStore.js";
import type { StateStore } from "../contracts/storage/stateStore.js";
import type { ViewStore } from "../contracts/storage/viewStore.js";
import type { IntegrationPlugin } from "../plugin-sdk/integrationPlugin.js";
import type { ProcessorPlugin } from "../plugin-sdk/processorPlugin.js";

import { PluginStatuses } from "../contracts/constants/pluginStatuses.js";
import { EncryptedSecretVault } from "../contracts/secrets/encryptedSecretVault.js";
import { InMemorySecretBackend } from "../contracts/secrets/inMemorySecretBackend.js";
import { PulseBridgeError } from "../contracts/errors/pulseErrors.js";
import { createRuntimeContext } from "../runtime/createRuntimeContext.js";
import { InMemoryRecordStore } from "../storage/inMemoryRecordStore.js";
import { InMemoryStateStore } from "../storage/inMemoryStateStore.js";
import { InMemoryViewStore } from "../storage/inMemoryViewStore.js";
import { validateCapabilities } from "../validation/capabilityValidator.js";
import { PluginRegistry, type ConfigSchema } from "./pluginRegistry.js";
import {
  PluginStateManager,
  type SetPluginStatusOptions,
} from "./pluginStateManager.js";
import { BackoffManager } from "./backoffManager.js";
import { IntegrationExecutor } from "./integrationExecutor.js";
import { PluginScheduler } from "./pluginScheduler.js";

export interface PluginStatusChangedEvent {
  pluginId: string;
  previousStatus: PluginState["status"] | undefined;
  newStatus: PluginState["status"];
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface PulseBridgeCore {
  on(
    event: "plugin:status-changed",
    listener: (event: PluginStatusChangedEvent) => void,
  ): this;
  off(
    event: "plugin:status-changed",
    listener: (event: PluginStatusChangedEvent) => void,
  ): this;
  once(
    event: "plugin:status-changed",
    listener: (event: PluginStatusChangedEvent) => void,
  ): this;
  emit(
    event: "plugin:status-changed",
    payload: PluginStatusChangedEvent,
  ): boolean;

  on(event: "view:updated", listener: (view: PulseViewRecord) => void): this;
  off(event: "view:updated", listener: (view: PulseViewRecord) => void): this;
  once(event: "view:updated", listener: (view: PulseViewRecord) => void): this;
  emit(event: "view:updated", view: PulseViewRecord): boolean;
}

export interface PlatformHealth {
  status: "healthy" | "degraded" | "stopped";
  running: boolean;
  plugins: ReadonlyArray<PluginState>;
}

/** Provisioning status of a single secret a plugin declares. Never carries the value. */
export interface PluginSecretStatus {
  key: string;
  required: boolean;
  description?: string;
  /** Whether a non-empty value is currently stored for this key. */
  set: boolean;
}

/** Per-plugin view of which declared secrets are set, for hosts to render a provisioning UI. */
export interface PluginProvisioningSpec {
  pluginId: string;
  secrets: ReadonlyArray<PluginSecretStatus>;
}

export interface PulseBridgeCoreOptions {
  logger?: PulseLogger;
  /**
   * Storage backend for encrypted secret blobs. Secrets are always encrypted at
   * rest by the core before they reach the backend, so the backend only ever
   * holds opaque ciphertext. Use InMemorySecretBackend for development,
   * RedisSecretBackend for persistence across restarts.
   * @default InMemorySecretBackend
   */
  secretBackend?: SecretBackend;
  /**
   * Bootstrap secret used to encrypt/decrypt the secret store (AES-256-GCM).
   * Supplied by the host (env var, OS keychain, KMS). Without it, plugins that
   * declare required secrets fail closed with `auth_error`. Must be stable —
   * losing it makes previously stored secrets unreadable.
   */
  masterKey?: string;
  store?: {
    records: RecordStore;
    views: ViewStore;
  };
  /**
   * Maximum time in milliseconds to wait for a single plugin `execute()` or
   * `reauth()` call before aborting it and marking the plugin as `degraded`.
   * @default 30_000
   */
  executionTimeoutMs?: number;
  /**
   * Maximum backoff duration (ms) applied to a degraded plugin after consecutive
   * unexpected failures. Backoff grows exponentially up to this cap.
   * @default 300_000 (5 minutes)
   */
  maxDegradedBackoffMs?: number;
  /**
   * Maximum backoff duration (ms) applied to a rate-limited plugin when no
   * `retryAfterMs` is provided by the thrown `RateLimitError`.
   * Falls back to `2 × effectivePollInterval` when unset.
   */
  rateLimitDefaultBackoffMs?: number;
  /**
   * OAuth2 token store. When provided, it is available to all plugins via
   * `context.tokens`. Plugins that implement OAuth2 flows should store tokens
   * here keyed by their plugin ID so the platform can track expiry.
   */
  tokens?: TokenStore;
  /**
   * Maximum time in milliseconds to wait for a single processor `process()`
   * call before aborting it and marking the plugin as `degraded`.
   * @default 30_000
   */
  processorTimeoutMs?: number;
  /**
   * Number of consecutive unexpected failures after which the platform
   * permanently disables the plugin (circuit breaker). The plugin will not
   * retry until manually re-enabled via `enablePlugin()`.
   * When unset, the platform retries indefinitely with exponential backoff.
   */
  maxConsecutiveFailures?: number;
  /**
   * Key-value store for stateful processor plugins. Processors that need to
   * persist state between executions (e.g. previous prices for delta tracking)
   * read and write through this store via `context.stateStore`.
   * Use InMemoryStateStore for development, RedisStateStore for production.
   * @default InMemoryStateStore
   */
  stateStore?: StateStore;
}

export interface IntegrationRegistrationOptions {
  /** Override the plugin's declared poll interval (only respected when manifest.polling.hard is false). */
  pollIntervalMs?: number;
}

const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
const MAX_DEGRADED_BACKOFF_MS = 300_000;

const HEALTHY_STATUSES = new Set<PluginStatus>([
  PluginStatuses.ENABLED,
  PluginStatuses.DISABLED,
]);

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PulseBridgeCore extends EventEmitter {
  private readonly registry: PluginRegistry;
  private readonly stateManager: PluginStateManager;
  private readonly backoffManager: BackoffManager;
  private readonly scheduler: PluginScheduler;

  private readonly recordStore: RecordStore;
  private readonly viewStore: ViewStore;
  private readonly context: RuntimeContext;
  private readonly vault: EncryptedSecretVault;
  private readonly integrationExecutor: IntegrationExecutor;

  constructor(options: PulseBridgeCoreOptions = {}) {
    super();
    this.vault = new EncryptedSecretVault(
      options.secretBackend ?? new InMemorySecretBackend(),
      options.masterKey,
    );
    this.recordStore = options.store?.records ?? new InMemoryRecordStore();
    this.viewStore = options.store?.views ?? new InMemoryViewStore();

    const tokenStore = options.tokens;
    const stateStore = options.stateStore ?? new InMemoryStateStore();
    this.context = createRuntimeContext({
      ...(options.logger ? { logger: options.logger } : {}),
      ...(tokenStore ? { tokens: tokenStore } : {}),
      stateStore,
    });

    this.stateManager = new PluginStateManager((event, payload) =>
      this.emit(event, payload),
    );
    this.registry = new PluginRegistry(this.context.logger);

    this.backoffManager = new BackoffManager({
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      maxDegradedBackoffMs:
        options.maxDegradedBackoffMs ?? MAX_DEGRADED_BACKOFF_MS,
      stateManager: this.stateManager,
      logger: this.context.logger,
    });

    this.integrationExecutor = new IntegrationExecutor({
      registry: this.registry,
      stateManager: this.stateManager,
      backoffManager: this.backoffManager,
      recordStore: this.recordStore,
      vault: this.vault,
      tokenStore,
      executionTimeoutMs:
        options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      rateLimitDefaultBackoffMs: options.rateLimitDefaultBackoffMs,
      context: this.context,
    });

    this.scheduler = new PluginScheduler({
      registry: this.registry,
      stateManager: this.stateManager,
      backoffManager: this.backoffManager,
      integrationExecutor: this.integrationExecutor,
      recordStore: this.recordStore,
      viewStore: this.viewStore,
      context: this.context,
      processorTimeoutMs:
        options.processorTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      onViewUpdated: (view) => this.emit("view:updated", view),
    });
  }

  async registerProcessor<TConfig = unknown>(
    processorPlugin: ProcessorPlugin<TConfig>,
    config?: TConfig,
  ): Promise<void> {
    const pluginId = processorPlugin.manifest.id;

    if (this.registry.hasProcessor(pluginId)) {
      throw new PulseBridgeError(
        `Processor plugin '${pluginId}' is already registered.`,
      );
    }

    if (config !== undefined) {
      await this.applyConfig(
        pluginId,
        processorPlugin.configSchema,
        config,
        (id, cfg) => this.registry.setProcessorConfig(id, cfg),
        processorPlugin.configure?.bind(processorPlugin),
      );
    }

    this.registry.setProcessor(pluginId, processorPlugin);
    this.stateManager.enablePlugin(pluginId);

    if (processorPlugin.init) {
      await processorPlugin.init(this.context);
    }
  }

  async registerIntegration<TConfig = unknown>(
    integrationPlugin: IntegrationPlugin<TConfig>,
    config?: TConfig,
    options?: IntegrationRegistrationOptions,
  ): Promise<void> {
    const pluginId = integrationPlugin.manifest.id;

    if (this.registry.hasIntegration(pluginId)) {
      throw new PulseBridgeError(
        `Integration plugin '${pluginId}' is already registered.`,
      );
    }

    if (config !== undefined) {
      await this.applyConfig(
        pluginId,
        integrationPlugin.configSchema,
        config,
        (id, cfg) => this.registry.setIntegrationConfig(id, cfg),
        integrationPlugin.configure?.bind(integrationPlugin),
      );
    }

    if (options?.pollIntervalMs !== undefined) {
      const polling = integrationPlugin.manifest.polling;
      const minAllowed =
        polling && !polling.hard ? (polling.minIntervalMs ?? 1_000) : 1_000;
      const MAX_REASONABLE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
      if (options.pollIntervalMs < minAllowed) {
        this.context.logger.warn(
          "Requested pollIntervalMs is below the plugin minimum — will be clamped.",
          { pluginId, requested: options.pollIntervalMs, minimum: minAllowed },
        );
      } else if (options.pollIntervalMs > MAX_REASONABLE_INTERVAL_MS) {
        this.context.logger.warn(
          "Requested pollIntervalMs exceeds 24 hours — verify this is intentional.",
          { pluginId, requested: options.pollIntervalMs },
        );
      }
      this.registry.setIntervalOverride(pluginId, options.pollIntervalMs);
    }

    this.registry.setIntegration(pluginId, integrationPlugin);
    this.stateManager.enablePlugin(pluginId);

    for (const operation of integrationPlugin.manifest.operations) {
      this.registry.addOperation(pluginId, { operationId: operation.id });
    }

    if (
      integrationPlugin.manifest.rateLimit?.maxConcurrentRequests !==
        undefined &&
      integrationPlugin.manifest.rateLimit.maxConcurrentRequests > 1
    ) {
      this.context.logger.info(
        "Plugin declares maxConcurrentRequests > 1; operations execute sequentially in this version.",
        {
          pluginId,
          maxConcurrentRequests:
            integrationPlugin.manifest.rateLimit.maxConcurrentRequests,
        },
      );
    }

    if (integrationPlugin.init) {
      await integrationPlugin.init(this.context);
    }
  }

  /** Passes `config` to the processor plugin's `configure()` method if it has one. */
  async configureProcessor<TConfig = unknown>(
    pluginId: string,
    config: TConfig,
  ): Promise<void> {
    const processorPlugin = this.registry.getProcessor(pluginId);
    if (!processorPlugin) {
      throw new PulseBridgeError(
        `Processor plugin '${pluginId}' is not registered.`,
      );
    }
    await this.applyConfig(
      pluginId,
      processorPlugin.configSchema,
      config,
      (id, cfg) => this.registry.setProcessorConfig(id, cfg),
      processorPlugin.configure?.bind(processorPlugin),
    );
  }

  async configureIntegration<TConfig = unknown>(
    pluginId: string,
    config: TConfig,
  ): Promise<void> {
    const integrationPlugin = this.registry.getIntegration(pluginId);
    if (!integrationPlugin) {
      throw new PulseBridgeError(
        `Integration plugin '${pluginId}' is not registered.`,
      );
    }
    await this.applyConfig(
      pluginId,
      integrationPlugin.configSchema,
      config,
      (id, cfg) => this.registry.setIntegrationConfig(id, cfg),
      integrationPlugin.configure?.bind(integrationPlugin),
    );
  }

  /**
   * Forces an immediate poll of a single integration plugin and triggers its
   * processors, without waiting for the next scheduled tick. Intended for the
   * host to call after applying new config via configureIntegration() (e.g. a
   * value pushed from a client). Other plugins and in-memory state are
   * untouched. A disabled plugin is a no-op.
   *
   * @param pluginId - The integration plugin to repoll.
   * @throws PulseBridgeError if no integration with this id is registered.
   */
  async refreshIntegration(pluginId: string): Promise<void> {
    if (!this.registry.getIntegration(pluginId)) {
      throw new PulseBridgeError(
        `Integration plugin '${pluginId}' is not registered.`,
      );
    }
    await this.scheduler.refreshPlugin(pluginId);
  }

  enablePlugin(pluginId: string): void {
    this.backoffManager.clearIntegrationBackoff(pluginId);
    this.backoffManager.clearProcessorBackoff(pluginId);
    this.stateManager.enablePlugin(pluginId);
  }

  disablePlugin(pluginId: string, reason?: string): void {
    this.stateManager.disablePlugin(pluginId, reason);
  }

  setPluginStatus(
    pluginId: string,
    status: PluginState["status"],
    options: SetPluginStatusOptions = {},
  ): void {
    this.stateManager.setPluginStatus(pluginId, status, options);
  }

  /** Returns true if the plugin is not explicitly disabled.
   *  Returns true for unknown plugin IDs — unregistered plugins are not considered disabled. */
  isPluginEnabled(pluginId: string): boolean {
    return this.stateManager.isPluginEnabled(pluginId);
  }

  /**
   * Returns the config registered for a processor plugin, cast to TConfig.
   * No runtime validation is performed — the caller is responsible for passing
   * the correct type parameter matching what was originally registered.
   */
  getProcessorConfig<TConfig = unknown>(pluginId: string): TConfig | undefined {
    return this.registry.getProcessorConfig(pluginId) as TConfig | undefined;
  }

  /**
   * Returns the config registered for an integration plugin, cast to TConfig.
   * No runtime validation is performed — the caller is responsible for passing
   * the correct type parameter matching what was originally registered.
   */
  getIntegrationConfig<TConfig = unknown>(
    pluginId: string,
  ): TConfig | undefined {
    return this.registry.getIntegrationConfig(pluginId) as TConfig | undefined;
  }

  getProcessorManifest(pluginId: string): ProcessorPluginManifest | undefined {
    return this.registry.getProcessor(pluginId)?.manifest;
  }

  getIntegrationManifest(
    pluginId: string,
  ): IntegrationPluginManifest | undefined {
    return this.registry.getIntegration(pluginId)?.manifest;
  }

  listProcessorManifests(): ReadonlyArray<ProcessorPluginManifest> {
    return Array.from(this.registry.processorValues()).map((p) => p.manifest);
  }

  listIntegrationManifests(): ReadonlyArray<IntegrationPluginManifest> {
    return Array.from(this.registry.integrationValues()).map((p) => p.manifest);
  }

  getPluginState(pluginId: string): PluginState | undefined {
    return this.stateManager.getPluginState(pluginId);
  }

  listPluginStates(): ReadonlyArray<PluginState> {
    return this.stateManager.listPluginStates();
  }

  validateCapabilities(): void {
    const result = validateCapabilities(
      this.listIntegrationManifests(),
      this.listProcessorManifests(),
    );

    if (!result.valid) {
      throw new PulseBridgeError(
        `Missing required capabilities: ${result.missingCapabilities.join(", ")}`,
      );
    }

    this.registry.warnMissingRecommendationsForAll();
  }

  /**
   * Stores secret values for a plugin, encrypted at rest. Keys must be declared
   * in the plugin's `manifest.auth.secrets` — unknown keys are rejected so a
   * plugin can never be handed a secret it did not ask for. Empty values are
   * rejected. Requires a master key.
   */
  async provision(
    pluginId: string,
    values: Record<string, string>,
  ): Promise<void> {
    const manifest = this.registry.getIntegration(pluginId)?.manifest;
    if (!manifest) {
      throw new PulseBridgeError(
        `Integration plugin '${pluginId}' is not registered.`,
      );
    }

    const declared = new Set((manifest.auth?.secrets ?? []).map((s) => s.key));
    for (const [key, value] of Object.entries(values)) {
      if (!declared.has(key)) {
        throw new PulseBridgeError(
          `Plugin '${pluginId}' does not declare secret '${key}'.`,
        );
      }
      if (value.trim() === "") {
        throw new PulseBridgeError(
          `Secret '${key}' for plugin '${pluginId}' must not be empty.`,
        );
      }
    }

    for (const [key, value] of Object.entries(values)) {
      await this.vault.set(pluginId, key, value);
    }
  }

  /**
   * Removes one or all stored secrets for a plugin. Lenient — clearing an unset
   * key or an unregistered plugin's namespace is a no-op, so it is safe to call
   * during plugin teardown.
   */
  async deprovision(pluginId: string, key?: string): Promise<void> {
    if (key === undefined) {
      await this.vault.deleteNamespace(pluginId);
    } else {
      await this.vault.delete(pluginId, key);
    }
  }

  /**
   * Returns which of a plugin's declared secrets are currently set — never the
   * values. Returns undefined for an unregistered plugin.
   */
  async getProvisioningSpec(
    pluginId: string,
  ): Promise<PluginProvisioningSpec | undefined> {
    const manifest = this.registry.getIntegration(pluginId)?.manifest;
    if (!manifest) return undefined;
    return this.buildProvisioningSpec(manifest);
  }

  /** Returns provisioning specs for every registered integration plugin. */
  async listProvisioningSpecs(): Promise<
    ReadonlyArray<PluginProvisioningSpec>
  > {
    const specs: PluginProvisioningSpec[] = [];
    for (const plugin of this.registry.integrationValues()) {
      specs.push(await this.buildProvisioningSpec(plugin.manifest));
    }
    return specs;
  }

  /**
   * Starts the per-plugin scheduler. Each integration's effective poll interval
   * is captured once at startup — calling `configureIntegration()` after `start()`
   * will not change the running timer. Stop and restart to apply new intervals.
   */
  async start(): Promise<void> {
    this.validateCapabilities();
    return this.scheduler.start();
  }

  /**
   * Resolves when the initial integration pass (fired at start) has completed.
   * Useful in tests and startup probes that need data to be available immediately
   * after boot, without waiting for the first scheduled tick.
   */
  waitForReady(): Promise<void> {
    return this.scheduler.initialPassPromise;
  }

  async stop(): Promise<void> {
    return this.scheduler.stop();
  }

  get isRunning(): boolean {
    return this.scheduler.isRunning;
  }

  async getRecords(): Promise<ReadonlyArray<PulseRecord>> {
    return this.recordStore.getAll();
  }

  async getRecordsByType(
    recordType: string,
  ): Promise<ReadonlyArray<PulseRecord>> {
    return this.recordStore.getByType(recordType);
  }

  async getView(viewName: string): Promise<PulseViewRecord | undefined> {
    return this.viewStore.get(viewName);
  }

  async getViews(): Promise<ReadonlyArray<PulseViewRecord>> {
    return this.viewStore.getAll();
  }

  /**
   * Invokes an outbound action on a plugin (push-out). The plugin validates the
   * payload and may mutate its upstream system. Throws `PluginInputError` for a
   * bad payload or an unknown action; auth/transient/rate-limit errors for a
   * genuine endpoint failure (which also degrade the plugin's action channel).
   */
  async invokeAction(
    pluginId: string,
    actionId: string,
    payload?: unknown,
  ): Promise<ActionResult> {
    if (!this.registry.hasIntegration(pluginId)) {
      throw new PulseBridgeError(
        `Integration plugin '${pluginId}' is not registered.`,
      );
    }
    return this.integrationExecutor.invokeAction(pluginId, actionId, payload);
  }

  /**
   * Ingests an inbound webhook event for a plugin (push-in). The plugin verifies
   * the sender from the raw request before trusting it. Throws `PluginInputError`
   * for an invalid/unsigned request; endpoint failures degrade the webhook channel.
   */
  async ingest(
    pluginId: string,
    request: WebhookRequest,
  ): Promise<WebhookResult> {
    if (!this.registry.hasIntegration(pluginId)) {
      throw new PulseBridgeError(
        `Integration plugin '${pluginId}' is not registered.`,
      );
    }
    return this.integrationExecutor.ingestWebhook(pluginId, request);
  }

  getHealth(): PlatformHealth {
    const plugins = this.listPluginStates();
    const degradedCount = plugins.filter(
      (p) => !this.isPluginHealthy(p),
    ).length;
    const status: PlatformHealth["status"] = !this.scheduler.isRunning
      ? "stopped"
      : degradedCount > 0
        ? "degraded"
        : "healthy";
    return { status, running: this.scheduler.isRunning, plugins };
  }

  /**
   * A plugin is healthy only when its polling status is healthy AND every
   * non-polling channel (actions, webhooks) is `ok`. "Healthy" means every
   * channel works — a failing action channel degrades the plugin even while
   * polling continues normally.
   */
  private isPluginHealthy(state: PluginState): boolean {
    if (!HEALTHY_STATUSES.has(state.status)) return false;
    const channels = state.channels;
    if (!channels) return true;
    return Object.values(channels).every(
      (channel) => channel === undefined || channel.status === "ok",
    );
  }

  private async buildProvisioningSpec(
    manifest: IntegrationPluginManifest,
  ): Promise<PluginProvisioningSpec> {
    const declared = manifest.auth?.secrets ?? [];
    const hasKey = this.vault.hasMasterKey;
    const secrets: PluginSecretStatus[] = [];
    for (const req of declared) {
      const set = hasKey ? await this.vault.has(manifest.id, req.key) : false;
      secrets.push({
        key: req.key,
        required: req.required,
        ...(req.description !== undefined
          ? { description: req.description }
          : {}),
        set,
      });
    }
    return { pluginId: manifest.id, secrets };
  }

  /** Validates config, marks plugin misconfigured on failure, then stores and applies it. */
  private async applyConfig<TConfig>(
    pluginId: string,
    schema: ConfigSchema | undefined,
    config: TConfig,
    setConfig: (id: string, cfg: unknown) => void,
    configure: ((config: TConfig) => Promise<void> | void) | undefined,
  ): Promise<void> {
    let parsed: TConfig;
    try {
      parsed = this.registry.validatePluginConfig(
        pluginId,
        schema,
        config,
      ) as TConfig;
    } catch (err) {
      this.stateManager.setPluginStatus(
        pluginId,
        PluginStatuses.MISCONFIGURED,
        {
          lastError:
            err instanceof PulseBridgeError ? err.message : String(err),
        },
      );
      throw err;
    }
    setConfig(pluginId, parsed);
    if (configure) {
      await configure(parsed);
    }
  }
}
