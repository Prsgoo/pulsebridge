export interface PulseViewRecord<TItem = unknown> {
  view: string;
  generatedAt: string;
  items: ReadonlyArray<TItem>;
}
