/**
 * Shared record type constants. Plugin packages may define their own record types
 * independently; this object exists as a stable extension point.
 */
export const RecordTypes = {} as const;

export type RecordType = (typeof RecordTypes)[keyof typeof RecordTypes];
