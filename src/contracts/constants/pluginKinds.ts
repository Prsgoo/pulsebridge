export const PluginKinds = {
  INTEGRATION: "integration",
  PROCESSOR: "processor",
} as const;

export type PluginKind = (typeof PluginKinds)[keyof typeof PluginKinds];
