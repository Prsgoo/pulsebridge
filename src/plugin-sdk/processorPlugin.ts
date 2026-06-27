import type { PulseRecord } from "../contracts/records/pulseRecord.js";
import type { PulseViewRecord } from "../contracts/records/pulseViewRecord.js";
import type { RuntimeContext } from "../contracts/runtime/runtimeContext.js";
import type { ProcessorPluginManifest } from "../contracts/plugins/processorPluginManifest.js";
import type { ZodType } from "zod";

export interface ProcessorPlugin<
  TConfig = unknown,
  TInputEvent extends PulseRecord = PulseRecord,
  TOutput extends PulseViewRecord = PulseViewRecord,
> {
  readonly manifest: ProcessorPluginManifest;

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

  process(
    events: ReadonlyArray<TInputEvent>,
    context: RuntimeContext,
    views?: ReadonlyArray<PulseViewRecord>,
  ): Promise<TOutput | null>;
}
