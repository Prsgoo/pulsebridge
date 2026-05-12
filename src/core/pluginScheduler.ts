import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { PulseViewRecord } from "../contracts/records/pulseViewRecord.js";
import type { RecordStore } from "../contracts/storage/recordStore.js";
import type { RuntimeContext } from "../contracts/runtime/runtimeContext.js";
import type { ViewStore } from "../contracts/storage/viewStore.js";
import type { ProcessorPlugin } from "../plugin-sdk/processorPlugin.js";
import type { PluginStateManager } from "./pluginStateManager.js";
import type { PluginRegistry } from "./pluginRegistry.js";
import type { BackoffManager } from "./backoffManager.js";
import type { IntegrationExecutor } from "./integrationExecutor.js";
import { PluginStatuses } from "../contracts/constants/pluginStatuses.js";
import { PulseBridgeError } from "../contracts/errors/pulseErrors.js";

const DEFAULT_PROCESSOR_BACKOFF_MS = 10_000;
const DESTROY_TIMEOUT_MS = 5_000;

export interface PluginSchedulerOptions {
  registry: PluginRegistry;
  stateManager: PluginStateManager;
  backoffManager: BackoffManager;
  integrationExecutor: IntegrationExecutor;
  recordStore: RecordStore;
  viewStore: ViewStore;
  context: RuntimeContext;
  processorTimeoutMs: number;
  /** Called immediately after a processor writes a new view to the store. */
  onViewUpdated?: (view: PulseViewRecord) => void;
}

/**
 * Manages the per-plugin scheduler timers, processor execution, and the
 * platform start/stop lifecycle.
 */
export class PluginScheduler {
  private readonly registry: PluginRegistry;
  private readonly stateManager: PluginStateManager;
  private readonly backoffManager: BackoffManager;
  private readonly integrationExecutor: IntegrationExecutor;
  private readonly recordStore: RecordStore;
  private readonly viewStore: ViewStore;
  private readonly context: RuntimeContext;
  private readonly logger: PulseLogger;

  private readonly processorTimeoutMs: number;
  private readonly onViewUpdated: (view: PulseViewRecord) => void;

  private readonly schedulerTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly inFlightExecutions = new Set<Promise<unknown>>();
  private readonly executingProcessors = new Set<string>();

  private running = false;
  private _initialPassPromise: Promise<void> | undefined;

  constructor(options: PluginSchedulerOptions) {
    this.registry = options.registry;
    this.stateManager = options.stateManager;
    this.backoffManager = options.backoffManager;
    this.integrationExecutor = options.integrationExecutor;
    this.recordStore = options.recordStore;
    this.viewStore = options.viewStore;
    this.context = options.context;
    this.logger = options.context.logger;
    this.processorTimeoutMs = options.processorTimeoutMs;
    this.onViewUpdated = options.onViewUpdated ?? (() => undefined);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Resolves when the initial integration pass (fired at start) has completed. */
  get initialPassPromise(): Promise<void> {
    return this._initialPassPromise ?? Promise.resolve();
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new PulseBridgeError("PulseBridgeCore is already running.");
    }
    this.running = true;

    this.logger.info("PulseBridge scheduler starting.", {
      integrationCount: this.registry.integrationCount(),
      processorCount: this.registry.processorCount(),
    });

    // Initial execution: fire all integrations in the background so start()
    // returns immediately. Slow or failing APIs no longer block boot.
    // stop() drains inFlightExecutions, so this still shuts down cleanly.
    const initialPass = (async () => {
      const results = await Promise.allSettled(
        Array.from(this.registry.integrationIds()).map((pluginId) =>
          this.integrationExecutor.execute(pluginId, { forceRun: true }),
        ),
      );
      const initialUpdatedTypes = new Set<string>();
      for (const result of results) {
        if (result.status === "fulfilled") {
          for (const t of result.value) initialUpdatedTypes.add(t);
        }
      }
      await this.triggerProcessors(Array.from(initialUpdatedTypes));
      this.logger.info("PulseBridge initial integration pass complete.");
    })();
    this._initialPassPromise = initialPass;
    this.inFlightExecutions.add(initialPass);
    initialPass.finally(() => this.inFlightExecutions.delete(initialPass));

    // Register ongoing scheduler timers.
    for (const pluginId of this.registry.integrationIds()) {
      const intervalMs = this.registry.getEffectiveInterval(pluginId);
      const timer = setInterval(() => {
        const execution = (async () => {
          const types = await this.integrationExecutor.execute(pluginId);
          await this.triggerProcessors(types);
        })();
        this.inFlightExecutions.add(execution);
        execution.finally(() => this.inFlightExecutions.delete(execution));
      }, intervalMs);
      this.schedulerTimers.set(pluginId, timer);
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    for (const timer of this.schedulerTimers.values()) {
      clearInterval(timer);
    }
    this.schedulerTimers.clear();

    await Promise.allSettled(Array.from(this.inFlightExecutions));
    this.inFlightExecutions.clear();

    const destroyResults = await Promise.allSettled([
      ...Array.from(this.registry.integrationValues()).map((p) =>
        this.safeDestroy(p.manifest.id, p.destroy?.bind(p)),
      ),
      ...Array.from(this.registry.processorValues()).map((p) =>
        this.safeDestroy(p.manifest.id, p.destroy?.bind(p)),
      ),
    ]);

    for (const result of destroyResults) {
      if (result.status === "rejected") {
        this.logger.error(
          "Plugin destroy() threw or timed out during shutdown.",
          {
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          },
        );
      }
    }

    this.logger.info("PulseBridge scheduler stopped.");
  }

  async triggerProcessors(updatedTypes: string[]): Promise<void> {
    if (updatedTypes.length === 0) return;

    const updatedSet = new Set(updatedTypes);
    const affected = Array.from(this.registry.processorValues()).filter(
      (p) =>
        p.manifest.consumes.length === 0 ||
        p.manifest.consumes.some((t) => updatedSet.has(t)),
    );

    const levels = this.topoSort(affected);
    for (const level of levels) {
      await Promise.allSettled(level.map((p) => this.executeProcessor(p)));
    }
  }

  /**
   * Topologically sorts processors using their `produces` and `consumesViews`
   * manifest fields so producers always run before consumers. Returns an
   * ordered array of execution levels; each level may run in parallel.
   *
   * Logs a warning and falls back to an arbitrary order if a cycle is detected.
   */
  private topoSort(processors: ProcessorPlugin[]): ProcessorPlugin[][] {
    if (processors.length === 0) return [];

    const idToProcessor = new Map(processors.map((p) => [p.manifest.id, p]));

    // viewName → pluginId of the processor that produces it (within this set)
    const viewToProducer = new Map<string, string>();
    for (const p of processors) {
      for (const view of p.manifest.produces ?? []) {
        viewToProducer.set(view, p.manifest.id);
      }
    }

    // Build dependency edges: inEdges[id] = set of ids this processor depends on
    const inEdges = new Map<string, Set<string>>();
    const outEdges = new Map<string, Set<string>>();
    for (const p of processors) {
      inEdges.set(p.manifest.id, new Set());
      outEdges.set(p.manifest.id, new Set());
    }
    for (const p of processors) {
      for (const view of p.manifest.consumesViews ?? []) {
        const producerId = viewToProducer.get(view);
        if (producerId && producerId !== p.manifest.id) {
          inEdges.get(p.manifest.id)?.add(producerId);
          outEdges.get(producerId)?.add(p.manifest.id);
        }
      }
    }

    // Kahn's algorithm — build execution levels
    const levels: ProcessorPlugin[][] = [];
    const remaining = new Set(processors.map((p) => p.manifest.id));

    while (remaining.size > 0) {
      const level: ProcessorPlugin[] = [];
      for (const id of remaining) {
        const unsatisfied = [...(inEdges.get(id) ?? [])].filter((d) =>
          remaining.has(d),
        );
        if (unsatisfied.length === 0) {
          const proc = idToProcessor.get(id);
          if (proc) level.push(proc);
        }
      }

      if (level.length === 0) {
        // Cycle detected — run remaining processors in arbitrary order
        this.logger.warn(
          "Circular dependency detected among chained processors — running in arbitrary order.",
          { processors: [...remaining] },
        );
        levels.push(
          [...remaining].flatMap((id) => {
            const proc = idToProcessor.get(id);
            return proc ? [proc] : [];
          }),
        );
        break;
      }

      for (const p of level) remaining.delete(p.manifest.id);
      levels.push(level);
    }

    return levels;
  }

  private async executeProcessor(processor: ProcessorPlugin): Promise<void> {
    const pluginId = processor.manifest.id;

    if (!this.stateManager.isPluginEnabled(pluginId)) {
      this.logger.info("Skipping disabled processor.", { pluginId });
      return;
    }

    if (this.backoffManager.isProcessorDegradedBackoff(pluginId)) {
      this.logger.debug("Skipping processor — in degraded backoff.", {
        pluginId,
        backoffRemainingMs:
          this.backoffManager.processorBackoffRemaining(pluginId),
      });
      return;
    }

    if (this.executingProcessors.has(pluginId)) {
      this.logger.debug(
        "Skipping processor — previous execution still in progress.",
        { pluginId },
      );
      return;
    }

    this.executingProcessors.add(pluginId);

    try {
      const allRecords = await this.recordStore.getAll();
      const consumes = processor.manifest.consumes;

      const relevantRecords =
        consumes.length === 0
          ? allRecords
          : allRecords.filter((r) => consumes.includes(r.type));

      const consumesViews = processor.manifest.consumesViews;
      const inputViews: PulseViewRecord[] = [];
      if (consumesViews && consumesViews.length > 0) {
        for (const viewName of consumesViews) {
          const view = await this.viewStore.get(viewName);
          if (view) inputViews.push(view);
        }
      }

      const output = await this.withTimeout(
        Promise.resolve(
          processor.process(
            relevantRecords,
            this.context,
            inputViews.length > 0 ? inputViews : undefined,
          ),
        ),
        this.processorTimeoutMs,
        `${pluginId}.process`,
      );
      if (output) {
        await this.viewStore.set(output);
        this.onViewUpdated?.(output);
      } else {
        this.logger.debug("Processor returned no output — view not updated.", {
          pluginId,
        });
      }
      this.backoffManager.clearProcessorBackoff(pluginId);
      this.stateManager.setPluginStatus(pluginId, PluginStatuses.ENABLED, {
        lastRunAt: this.context.now().toISOString(),
        clearLastError: true,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown processor error";

      const outcome = this.backoffManager.applyProcessorBackoff(
        pluginId,
        errorMessage,
        DEFAULT_PROCESSOR_BACKOFF_MS,
      );

      if (outcome === "backoff_applied") {
        this.stateManager.setPluginStatus(pluginId, PluginStatuses.DEGRADED, {
          lastRunAt: this.context.now().toISOString(),
          lastError: errorMessage,
        });
        this.logger.error("Processor execution failed.", {
          pluginId,
          error: errorMessage,
          consecutiveFailures:
            this.backoffManager.getProcessorConsecutiveFailures(pluginId),
          backoffMs: this.backoffManager.processorBackoffRemaining(pluginId),
        });
      } else {
        this.logger.error(
          "Processor circuit breaker tripped — plugin disabled until manually re-enabled.",
          { pluginId },
        );
      }
    } finally {
      this.executingProcessors.delete(pluginId);
    }
  }

  private safeDestroy(
    pluginId: string,
    destroy: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    if (!destroy) return Promise.resolve();
    return this.withTimeout(
      Promise.resolve(destroy()),
      DESTROY_TIMEOUT_MS,
      `${pluginId}.destroy`,
    );
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
