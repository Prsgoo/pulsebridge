import { describe, it, expect } from "vitest";
import { validateCapabilities } from "../capabilityValidator.js";
import type { Capability } from "../../contracts/constants/capabilities.js";
import type { IntegrationPluginManifest } from "../../contracts/plugins/integrationPluginManifest.js";
import type { ProcessorPluginManifest } from "../../contracts/plugins/processorPluginManifest.js";

const makeIntegration = (
  requiresCapabilities: Capability[] = [],
): IntegrationPluginManifest => ({
  id: "test-integration",
  name: "Test Integration",
  version: "1.0.0",
  kind: "integration",
  operations: [],
  requiresCapabilities,
});

const makeProcessor = (
  providesCapabilities: Capability[] = [],
): ProcessorPluginManifest => ({
  id: "test-processor",
  name: "Test Processor",
  version: "1.0.0",
  kind: "processor",
  consumes: [],
  produces: [],
  providesCapabilities,
});

describe("validateCapabilities", () => {
  it("returns valid when no integrations are registered", () => {
    const result = validateCapabilities([], [makeProcessor(["planes.feed"])]);
    expect(result.valid).toBe(true);
    expect(result.missingCapabilities).toHaveLength(0);
  });

  it("returns valid when no capabilities are required", () => {
    const result = validateCapabilities([makeIntegration([])], []);
    expect(result.valid).toBe(true);
    expect(result.missingCapabilities).toHaveLength(0);
  });

  it("returns valid when all required capabilities are provided", () => {
    const result = validateCapabilities(
      [makeIntegration(["planes.feed"])],
      [makeProcessor(["planes.feed"])],
    );
    expect(result.valid).toBe(true);
    expect(result.missingCapabilities).toHaveLength(0);
  });

  it("returns valid when no integrations and no processors are registered", () => {
    const result = validateCapabilities([], []);
    expect(result.valid).toBe(true);
    expect(result.missingCapabilities).toHaveLength(0);
  });

  it("returns invalid when a required capability is not provided", () => {
    const result = validateCapabilities(
      [makeIntegration(["planes.feed"])],
      [makeProcessor(["planes.merge"])],
    );
    expect(result.valid).toBe(false);
    expect(result.missingCapabilities).toContain("planes.feed");
  });

  it("returns all missing capabilities when multiple are absent", () => {
    const result = validateCapabilities(
      [makeIntegration(["planes.feed", "planes.merge"])],
      [makeProcessor([])],
    );
    expect(result.valid).toBe(false);
    expect(result.missingCapabilities).toHaveLength(2);
    expect(result.missingCapabilities).toContain("planes.feed");
    expect(result.missingCapabilities).toContain("planes.merge");
  });

  it("returns invalid when required capabilities are missing and no processors are registered", () => {
    const result = validateCapabilities([makeIntegration(["planes.feed"])], []);
    expect(result.valid).toBe(false);
    expect(result.missingCapabilities).toContain("planes.feed");
  });

  it("accounts for capabilities provided across multiple processors", () => {
    const result = validateCapabilities(
      [makeIntegration(["planes.feed", "planes.merge"])],
      [
        makeProcessor(["planes.feed"]),
        { ...makeProcessor(["planes.merge"]), id: "second-processor" },
      ],
    );
    expect(result.valid).toBe(true);
    expect(result.missingCapabilities).toHaveLength(0);
  });

  it("ignores integration manifests with no runtime field", () => {
    const integration: IntegrationPluginManifest = {
      id: "test-integration",
      name: "Test Integration",
      version: "1.0.0",
      kind: "integration",
      operations: [],
    };
    const result = validateCapabilities([integration], []);
    expect(result.valid).toBe(true);
  });
});
