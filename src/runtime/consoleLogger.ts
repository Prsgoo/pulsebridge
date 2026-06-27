import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";

export class ConsoleLogger implements PulseLogger {
  debug(message: string, meta?: Record<string, unknown>): void {
    console.debug(message, ...this.args(meta));
  }

  info(message: string, meta?: Record<string, unknown>): void {
    console.info(message, ...this.args(meta));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(message, ...this.args(meta));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(message, ...this.args(meta));
  }

  private args(
    meta: Record<string, unknown> | undefined,
  ): [] | [Record<string, unknown>] {
    return meta !== undefined ? [meta] : [];
  }
}
