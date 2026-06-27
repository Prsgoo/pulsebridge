/**
 * Shared view type constants. Plugin packages may define their own view types
 * independently; this object exists as a stable extension point.
 */
export const ViewTypes = {} as const;

export type ViewType = (typeof ViewTypes)[keyof typeof ViewTypes];
