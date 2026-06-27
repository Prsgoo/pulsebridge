import type { PulseRecord } from "../records/pulseRecord.js";

/**
 * Declares that a plugin accepts inbound webhook events (push-in).
 * The platform exposes a public endpoint; the plugin is responsible for
 * verifying the sender (signature/secret) inside `ingest()`.
 *
 * Experimental — the inbound surface is the platform's first unauthenticated,
 * internet-facing entry point. Treat signature verification as mandatory.
 */
export interface WebhookDefinition {
  description?: string;
  /** Record type produced by ingested events. Informational. */
  producesRecordType?: string;
}

/**
 * A raw inbound webhook request handed to `ingest()`. The body is preserved
 * byte-for-byte so the plugin can compute an HMAC over the exact payload the
 * sender signed — parsing it first would break signature verification.
 */
export interface WebhookRequest {
  /** Raw request body, exactly as received. */
  body: string;
  /** Header map with lower-cased keys. */
  headers: Readonly<Record<string, string>>;
}

/**
 * Result of an `ingest()` call. Records are appended to the store; `data` is
 * returned to the sender (some providers expect an acknowledgement body).
 */
export interface WebhookResult<TData = unknown> {
  data?: TData;
  records?: ReadonlyArray<PulseRecord>;
}
