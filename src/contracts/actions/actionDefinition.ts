import type { PulseRecord } from "../records/pulseRecord.js";

/**
 * Declares an outbound action a plugin can perform on demand (push-out).
 * Unlike operations (which the scheduler polls), actions are invoked
 * explicitly by the host and may mutate the upstream system.
 */
export interface ActionDefinition {
  id: string;
  name: string;
  description?: string;
  /**
   * When the action appends records to the store, the record type they carry.
   * Informational — used by hosts to surface what an action produces.
   */
  producesRecordType?: string;
}

/**
 * Result of an `invoke()` call. The plugin chooses what to return to the caller
 * and, optionally, records to append to the store as a new dataset.
 */
export interface ActionResult<TData = unknown> {
  /** Payload returned to the caller (e.g. an HTTP response body). */
  data?: TData;
  /**
   * Records appended to the store (additive — never replaces a poll bucket).
   * Use when the action's response is itself data worth persisting.
   */
  records?: ReadonlyArray<PulseRecord>;
}
