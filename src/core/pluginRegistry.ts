import type { IntegrationPlugin } from "../plugin-sdk/integrationPlugin.js";
import type { ProcessorPlugin } from "../plugin-sdk/processorPlugin.js";
import type { Capability } from "../contracts/constants/capabilities.js";
import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import { PulseBridgeError } from "../contracts/errors/pulseErrors.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;

export interface ConfigSchemaIssue {
  path: ReadonlyArray<string | number | symbol>;
  message: string;
}

export interface ConfigSchema {
  safeParse(input: unknown):
    | { success: true }
    | {
        success: false;
        error: {
          message: string;
          issues?: ReadonlyArray<ConfigSchemaIssue>;
        };
      };
}

export interface RegisteredOperation {
  operationId: string;
  params?: unknown;
}

/** Internal class that owns plugin registration maps and config validation. */
export class PluginRegistry {
  private readonly integrations = new Map<string, IntegrationPlugin>();
  private readonly processors = new Map<string, ProcessorPlugin>();
  private readonly integrationConfigs = new Map<string, unknown>();
  private readonly processorConfigs = new Map<string, unknown>();
  private readonly integrationIntervalOverrides = new Map<string, number>();

  /** Per-plugin list of auto-registered operations (keyed by pluginId). */
  private readonly integrationOperations = new Map<
    string,
    RegisteredOperation[]
  >();

  private readonly logger: PulseLogger;

  constructor(logger: PulseLogger) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Integration accessors
  // ---------------------------------------------------------------------------

  getIntegration(pluginId: string): IntegrationPlugin | undefined {
    return this.integrations.get(pluginId);
  }

  hasIntegration(pluginId: string): boolean {
    return this.integrations.has(pluginId);
  }

  setIntegration(pluginId: string, plugin: IntegrationPlugin): void {
    this.integrations.set(pluginId, plugin);
  }

  integrationIds(): IterableIterator<string> {
    return this.integrations.keys();
  }

  integrationEntries(): IterableIterator<[string, IntegrationPlugin]> {
    return this.integrations.entries();
  }

  integrationValues(): IterableIterator<IntegrationPlugin> {
    return this.integrations.values();
  }

  integrationCount(): number {
    return this.integrations.size;
  }

  // ---------------------------------------------------------------------------
  // Processor accessors
  // ---------------------------------------------------------------------------

  getProcessor(pluginId: string): ProcessorPlugin | undefined {
    return this.processors.get(pluginId);
  }

  hasProcessor(pluginId: string): boolean {
    return this.processors.has(pluginId);
  }

  setProcessor(pluginId: string, plugin: ProcessorPlugin): void {
    this.processors.set(pluginId, plugin);
  }

  processorIds(): IterableIterator<string> {
    return this.processors.keys();
  }

  processorValues(): IterableIterator<ProcessorPlugin> {
    return this.processors.values();
  }

  processorCount(): number {
    return this.processors.size;
  }

  // ---------------------------------------------------------------------------
  // Config accessors
  // ---------------------------------------------------------------------------

  getIntegrationConfig(pluginId: string): unknown {
    return this.integrationConfigs.get(pluginId);
  }

  setIntegrationConfig(pluginId: string, config: unknown): void {
    this.integrationConfigs.set(pluginId, config);
  }

  getProcessorConfig(pluginId: string): unknown {
    return this.processorConfigs.get(pluginId);
  }

  setProcessorConfig(pluginId: string, config: unknown): void {
    this.processorConfigs.set(pluginId, config);
  }

  // ---------------------------------------------------------------------------
  // Interval overrides
  // ---------------------------------------------------------------------------

  getIntervalOverride(pluginId: string): number | undefined {
    return this.integrationIntervalOverrides.get(pluginId);
  }

  setIntervalOverride(pluginId: string, intervalMs: number): void {
    this.integrationIntervalOverrides.set(pluginId, intervalMs);
  }

  getEffectiveInterval(pluginId: string): number {
    const polling = this.integrations.get(pluginId)?.manifest.polling;
    if (!polling) return DEFAULT_POLL_INTERVAL_MS;

    if (polling.hard) {
      return Math.max(polling.defaultIntervalMs, MIN_INTERVAL_MS);
    }

    const override = this.integrationIntervalOverrides.get(pluginId);
    if (override !== undefined) {
      return Math.max(
        override,
        polling.minIntervalMs ?? MIN_INTERVAL_MS,
        MIN_INTERVAL_MS,
      );
    }
    return Math.max(polling.defaultIntervalMs, MIN_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Operation registry
  // ---------------------------------------------------------------------------

  addOperation(pluginId: string, operation: RegisteredOperation): void {
    const existing = this.integrationOperations.get(pluginId);
    if (existing) {
      existing.push(operation);
    } else {
      this.integrationOperations.set(pluginId, [operation]);
    }
  }

  getOperations(pluginId: string): ReadonlyArray<RegisteredOperation> {
    return this.integrationOperations.get(pluginId) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  validatePluginConfig(
    pluginId: string,
    schema: ConfigSchema | undefined,
    config: unknown,
  ): void {
    if (!schema) return;
    const result = schema.safeParse(config);
    if (!result.success) {
      const { error } = result;
      const detail =
        error.issues && error.issues.length > 0
          ? error.issues
              .map(
                (i) =>
                  `  - ${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`,
              )
              .join("\n")
          : error.message;
      throw new PulseBridgeError(
        `Invalid config for plugin '${pluginId}':\n${detail}`,
      );
    }
  }

  warnMissingRecommendations(
    pluginId: string,
    recommendsCapabilities: ReadonlyArray<Capability> | undefined,
    providedCapabilities: Set<Capability>,
  ): void {
    if (!recommendsCapabilities || recommendsCapabilities.length === 0) return;

    for (const capability of recommendsCapabilities) {
      if (!providedCapabilities.has(capability)) {
        this.logger.warn(
          "Plugin recommends a capability with no registered provider.",
          { pluginId, capability },
        );
      }
    }
  }

  warnMissingRecommendationsForAll(): void {
    const providedCapabilities = new Set<Capability>(
      Array.from(this.processors.values()).flatMap(
        (p) => p.manifest.providesCapabilities ?? [],
      ),
    );

    for (const [pluginId, integration] of this.integrations) {
      this.warnMissingRecommendations(
        pluginId,
        integration.manifest.recommendsCapabilities,
        providedCapabilities,
      );
    }
    for (const [pluginId, processor] of this.processors) {
      this.warnMissingRecommendations(
        pluginId,
        processor.manifest.recommendsCapabilities,
        providedCapabilities,
      );
    }
  }
}
