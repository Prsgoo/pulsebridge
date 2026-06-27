import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { PluginStateManager } from "./pluginStateManager.js";

export interface BackoffManagerOptions {
  maxConsecutiveFailures: number | undefined;
  maxDegradedBackoffMs: number;
  stateManager: PluginStateManager;
  logger: PulseLogger;
}

/**
 * Manages per-plugin exponential backoff and circuit-breaker state for both
 * integrations and processors.
 */
export class BackoffManager {
  private readonly consecutiveFailures = new Map<string, number>();
  private readonly degradedBackoffUntil = new Map<string, number>();
  private readonly rateLimitBackoffUntil = new Map<string, number>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly processorConsecutiveFailures = new Map<string, number>();
  private readonly processorDegradedBackoffUntil = new Map<string, number>();

  private readonly maxConsecutiveFailures: number | undefined;
  private readonly maxDegradedBackoffMs: number;
  private readonly stateManager: PluginStateManager;

  constructor(options: BackoffManagerOptions) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures;
    this.maxDegradedBackoffMs = options.maxDegradedBackoffMs;
    this.stateManager = options.stateManager;
  }

  isRateLimited(pluginId: string): boolean {
    const until = this.rateLimitBackoffUntil.get(pluginId);
    return until !== undefined && Date.now() < until;
  }

  rateLimitBackoffRemaining(pluginId: string): number {
    return (this.rateLimitBackoffUntil.get(pluginId) ?? 0) - Date.now();
  }

  setRateLimitBackoff(pluginId: string, untilMs: number): void {
    this.rateLimitBackoffUntil.set(pluginId, untilMs);
  }

  /** Timestamp of the most recent outbound request, used to pace requestsPerMinute. */
  getLastRequestAt(pluginId: string): number | undefined {
    return this.lastRequestAt.get(pluginId);
  }

  setLastRequestAt(pluginId: string, timestamp: number): void {
    this.lastRequestAt.set(pluginId, timestamp);
  }

  isDegradedBackoff(pluginId: string): boolean {
    const until = this.degradedBackoffUntil.get(pluginId);
    return until !== undefined && Date.now() < until;
  }

  degradedBackoffRemaining(pluginId: string): number {
    return (this.degradedBackoffUntil.get(pluginId) ?? 0) - Date.now();
  }

  getConsecutiveFailures(pluginId: string): number {
    return this.consecutiveFailures.get(pluginId) ?? 0;
  }

  /**
   * Sets a fixed degraded backoff without incrementing consecutive failures.
   * Used for transient errors that should not trigger the circuit breaker.
   */
  setTransientBackoff(pluginId: string, durationMs: number): void {
    this.degradedBackoffUntil.set(pluginId, Date.now() + durationMs);
  }

  clearIntegrationBackoff(pluginId: string): void {
    this.consecutiveFailures.delete(pluginId);
    this.degradedBackoffUntil.delete(pluginId);
  }

  applyIntegrationBackoff(
    pluginId: string,
    errorMessage: string,
    baseBackoffMs: number,
  ): "circuit_tripped" | "backoff_applied" {
    return this.applyBackoff(
      pluginId,
      errorMessage,
      this.consecutiveFailures,
      this.degradedBackoffUntil,
      baseBackoffMs,
    );
  }

  isProcessorDegradedBackoff(pluginId: string): boolean {
    const until = this.processorDegradedBackoffUntil.get(pluginId);
    return until !== undefined && Date.now() < until;
  }

  processorBackoffRemaining(pluginId: string): number {
    return (this.processorDegradedBackoffUntil.get(pluginId) ?? 0) - Date.now();
  }

  getProcessorConsecutiveFailures(pluginId: string): number {
    return this.processorConsecutiveFailures.get(pluginId) ?? 0;
  }

  clearProcessorBackoff(pluginId: string): void {
    this.processorConsecutiveFailures.delete(pluginId);
    this.processorDegradedBackoffUntil.delete(pluginId);
  }

  applyProcessorBackoff(
    pluginId: string,
    errorMessage: string,
    baseBackoffMs: number,
  ): "circuit_tripped" | "backoff_applied" {
    return this.applyBackoff(
      pluginId,
      errorMessage,
      this.processorConsecutiveFailures,
      this.processorDegradedBackoffUntil,
      baseBackoffMs,
    );
  }

  private applyBackoff(
    pluginId: string,
    errorMessage: string,
    consecutiveMap: Map<string, number>,
    backoffMap: Map<string, number>,
    baseBackoffMs: number,
  ): "circuit_tripped" | "backoff_applied" {
    const failures = (consecutiveMap.get(pluginId) ?? 0) + 1;
    consecutiveMap.set(pluginId, failures);

    if (
      this.maxConsecutiveFailures !== undefined &&
      failures >= this.maxConsecutiveFailures
    ) {
      consecutiveMap.delete(pluginId);
      backoffMap.delete(pluginId);
      this.stateManager.disablePlugin(
        pluginId,
        `Circuit breaker tripped after ${failures} consecutive failures. Last error: ${errorMessage}`,
      );
      return "circuit_tripped";
    }

    const backoffMs = Math.min(
      baseBackoffMs * Math.pow(2, failures - 1),
      this.maxDegradedBackoffMs,
    );
    backoffMap.set(pluginId, Date.now() + backoffMs);
    return "backoff_applied";
  }
}
