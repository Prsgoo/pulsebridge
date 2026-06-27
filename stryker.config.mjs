// @ts-check

/** @type {import("@stryker-mutator/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: ["src/**/*.ts", "!src/**/__tests__/**", "!src/index.ts"],
  thresholds: { high: 80, low: 70, break: 70 },
  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
};
