/**
 * Tests for PulseBridgeCore.discover() — dynamic plugin discovery.
 * Uses a real temp directory with actual ESM module files to avoid mocking import().
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PulseBridgeCore } from "../pulseBridgeCore.js";
import { PulseBridgeError } from "../../contracts/errors/pulseErrors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(suffix: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `pulsebridge-discover-test-${suffix}-${Date.now()}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PulseBridgeCore – discover()", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("registers an integration plugin found in the directory", async () => {
    const dir = await makeTempDir("integration");
    tempDirs.push(dir);

    // Write a minimal ESM plugin module. Note: we use .mjs to avoid CJS/ESM issues in temp dirs.
    const pluginContent = `
export const plugin = {
  manifest: {
    id: "discovered-integration",
    name: "Discovered Integration",
    version: "1.0.0",
    kind: "integration",
    operations: [{ id: "fetch", name: "Fetch", recordType: "test.record", schemaVersion: "1.0" }],
  },
  execute: async () => [],
};
export default plugin;
`;
    await writeFile(join(dir, "plugin.mjs"), pluginContent, "utf8");

    const core = new PulseBridgeCore();
    const result = await core.discover(dir);

    expect(result.registered).toContain("discovered-integration");
    expect(result.failed).toHaveLength(0);
    expect(core.getIntegrationManifest("discovered-integration")).toBeDefined();
  });

  it("registers a processor plugin found in the directory", async () => {
    const dir = await makeTempDir("processor");
    tempDirs.push(dir);

    const pluginContent = `
export const plugin = {
  manifest: {
    id: "discovered-processor",
    name: "Discovered Processor",
    version: "1.0.0",
    kind: "processor",
    consumes: [],
    produces: ["test.view"],
    providesCapabilities: [],
  },
  process: async () => null,
};
export default plugin;
`;
    await writeFile(join(dir, "processor.mjs"), pluginContent, "utf8");

    const core = new PulseBridgeCore();
    const result = await core.discover(dir);

    expect(result.registered).toContain("discovered-processor");
    expect(result.failed).toHaveLength(0);
    expect(core.getProcessorManifest("discovered-processor")).toBeDefined();
  });

  it("records failures for modules that cannot be imported", async () => {
    const dir = await makeTempDir("bad-module");
    tempDirs.push(dir);

    // Write a file with a syntax error to force import failure
    await writeFile(join(dir, "broken.mjs"), "export const x = {{{;", "utf8");

    const core = new PulseBridgeCore();
    const result = await core.discover(dir);

    expect(result.registered).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toContain("broken.mjs");
  });

  it("skips exports that do not look like plugins", async () => {
    const dir = await makeTempDir("non-plugin");
    tempDirs.push(dir);

    // Export something with no manifest
    await writeFile(
      join(dir, "util.mjs"),
      `export const helper = { name: "not a plugin" };`,
      "utf8",
    );

    const core = new PulseBridgeCore();
    const result = await core.discover(dir);

    expect(result.registered).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("throws PulseBridgeError when the directory does not exist", async () => {
    const core = new PulseBridgeCore();
    const nonExistentDir = resolve(
      tmpdir(),
      "pulsebridge-nonexistent-dir-xyz123",
    );

    await expect(core.discover(nonExistentDir)).rejects.toThrow(
      PulseBridgeError,
    );
    await expect(core.discover(nonExistentDir)).rejects.toThrow(
      "Plugin discovery failed",
    );
  });

  it("returns empty results for an empty directory", async () => {
    const dir = await makeTempDir("empty");
    tempDirs.push(dir);

    const core = new PulseBridgeCore();
    const result = await core.discover(dir);

    expect(result.registered).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});
