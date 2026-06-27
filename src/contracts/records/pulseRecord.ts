export interface PulseRecord<TData = unknown> {
  type: string;
  timestamp: string;
  source: string;
  entityKey?: string;
  data: TData;
}
