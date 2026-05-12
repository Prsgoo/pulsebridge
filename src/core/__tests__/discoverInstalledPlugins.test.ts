/**
 * Tests for PulseBridgeCore.discoverInstalledPlugins() — npm-based plugin discovery.
 *
 * Uses real temp directories that mimic node_modules structures to avoid mocking
 * import(). Each test constructs the minimal package layout needed to exercise
 * a specific behavior.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { PulseBridgeCore } from "../pulseBridgeCore.js";
import { PulseBridgeError } from "../../contracts/errors/pulseErrors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempNodeModules(suffix: string): Promise<string> {
  const nmDir = join(tmpdir(), `pulsebridge-nm-test-${suffix}-${Date.now()}`);
  await mkdir(nmDir, { recursive: true });
  return nmDir;
}

/** Writes a package directory with a package.json and an ESM entry file. */
async function writePackage(
  nmDir: string,
  pkgName: string,
  pkgJson: object,
  entryContent: string,
  entryFile = "index.mjs",
): Promise<string> {
  const pkgDir = join(nmDir, pkgName);
  const entryAbsPath = join(pkgDir, entryFile);
  await mkdir(dirname(entryAbsPath), { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify(pkgJson),
    "utf-8",
  );
  await writeFile(entryAbsPath, entryContent, "utf-8");
  return pkgDir;
}

const INTEGRATION_PLUGIN = `
export const plugin = {
  manifest: {
    id: "npm-integration",
    name: "NPM Integration",
    version: "1.0.0",
    kind: "integration",
    operations: [{ id: "fetch", name: "Fetch", recordType: "test.record" }],
  },
  execute: async () => [],
};
export default plugin;
`;

const PROCESSOR_PLUGIN = `
export const plugin = {
  manifest: {
    id: "npm-processor",
    name: "NPM Processor",
    version: "1.0.0",
    kind: "processor",
    consumes: [],
    produces: ["test.view"],
    providesCapabilities: [],
  },
  process: async () => ({ view: "test.view", generatedAt: new Date().toISOString(), items: [] }),
};
export default plugin;
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PulseBridgeCore – discoverInstalledPlugins()", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  // ── Keyword filtering ──────────────────────────────────────────────────────

  it("registers an integration plugin from a package with the marker keyword", async () => {
    const nmDir = await makeTempNodeModules("integration");
    tempDirs.push(nmDir);

    await writePackage(
      nmDir,
      "pulsebridge-integration-test",
      {
        name: "pulsebridge-integration-test",
        keywords: ["pulsebridge-plugin"],
        main: "index.mjs",
      },
      INTEGRATION_PLUGIN,
    );

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toContain("npm-integration");
    expect(result.failed).toHaveLength(0);
    expect(core.getIntegrationManifest("npm-integration")).toBeDefined();
  });

  it("registers a processor plugin from a package with the marker keyword", async () => {
    const nmDir = await makeTempNodeModules("processor");
    tempDirs.push(nmDir);

    await writePackage(
      nmDir,
      "pulsebridge-processor-test",
      {
        name: "pulsebridge-processor-test",
        keywords: ["pulsebridge-plugin"],
        main: "index.mjs",
      },
      PROCESSOR_PLUGIN,
    );

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toContain("npm-processor");
    expect(result.failed).toHaveLength(0);
    expect(core.getProcessorManifest("npm-processor")).toBeDefined();
  });

  it("skips packages that do not declare the marker keyword", async () => {
    const nmDir = await makeTempNodeModules("no-keyword");
    tempDirs.push(nmDir);

    await writePackage(
      nmDir,
      "some-unrelated-package",
      { name: "some-unrelated-package", keywords: ["utility"] },
      INTEGRATION_PLUGIN,
    );

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toHaveLength(0);
  });

  it("skips packages with no keywords field at all", async () => {
    const nmDir = await makeTempNodeModules("no-keywords-field");
    tempDirs.push(nmDir);

    await writePackage(
      nmDir,
      "keywordless-package",
      { name: "keywordless-package" },
      INTEGRATION_PLUGIN,
    );

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toHaveLength(0);
  });

  // ── Accidental-match protection ────────────────────────────────────────────

  it("warns but does not fail when a package has the keyword but no valid plugin exports", async () => {
    const nmDir = await makeTempNodeModules("accidental-match");
    tempDirs.push(nmDir);

    await writePackage(
      nmDir,
      "accidental-match-pkg",
      {
        name: "accidental-match-pkg",
        keywords: ["pulsebridge-plugin"],
        main: "index.mjs",
      },
      // Exports something that is not a plugin
      `export const helper = { name: "not a plugin" };`,
    );

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toHaveLength(0);
    expect(result.failed).toHaveLength(0); // warn, not fail
  });

  // ── Scoped packages ────────────────────────────────────────────────────────

  it("discovers plugins inside scoped package directories (@scope/pkg)", async () => {
    const nmDir = await makeTempNodeModules("scoped");
    tempDirs.push(nmDir);

    const pkgDir = join(nmDir, "@acme", "pulsebridge-weather");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@acme/pulsebridge-weather",
        keywords: ["pulsebridge-plugin"],
        main: "index.mjs",
      }),
      "utf-8",
    );
    await writeFile(join(pkgDir, "index.mjs"), INTEGRATION_PLUGIN, "utf-8");

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toContain("npm-integration");
    expect(core.getIntegrationManifest("npm-integration")).toBeDefined();
  });

  // ── Entry point resolution ─────────────────────────────────────────────────

  it("resolves entry point from exports['.'].import field", async () => {
    const nmDir = await makeTempNodeModules("exports-import");
    tempDirs.push(nmDir);

    await writePackage(
      nmDir,
      "pulsebridge-exports-test",
      {
        name: "pulsebridge-exports-test",
        keywords: ["pulsebridge-plugin"],
        exports: { ".": { import: "./dist/index.mjs" } },
      },
      INTEGRATION_PLUGIN,
      "dist/index.mjs",
    );

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toContain("npm-integration");
  });

  it("resolves entry point from exports['.'] string shorthand", async () => {
    const nmDir = await makeTempNodeModules("exports-dot-string");
    tempDirs.push(nmDir);

    await writePackage(
      nmDir,
      "pulsebridge-dot-test",
      {
        name: "pulsebridge-dot-test",
        keywords: ["pulsebridge-plugin"],
        exports: { ".": "./index.mjs" },
      },
      INTEGRATION_PLUGIN,
    );

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toContain("npm-integration");
  });

  it("falls back to index.js when no main or exports is declared", async () => {
    const nmDir = await makeTempNodeModules("fallback-index");
    tempDirs.push(nmDir);

    const pkgDir = join(nmDir, "pulsebridge-fallback-test");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pulsebridge-fallback-test",
        keywords: ["pulsebridge-plugin"],
      }),
      "utf-8",
    );
    // Write as index.js (no .mjs) — but use .mjs because CJS/ESM resolution in temp dir
    // We name it index.mjs and adjust the package to specify it via main
    await writeFile(join(pkgDir, "index.js"), INTEGRATION_PLUGIN, "utf-8");

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    // index.js fallback is reached — plugin should be registered
    expect(result.registered).toContain("npm-integration");
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it("records failures for packages whose entry point throws on import", async () => {
    const nmDir = await makeTempNodeModules("broken-import");
    tempDirs.push(nmDir);

    await writePackage(
      nmDir,
      "pulsebridge-broken",
      {
        name: "pulsebridge-broken",
        keywords: ["pulsebridge-plugin"],
        main: "index.mjs",
      },
      "export const x = {{{;", // syntax error
    );

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe("pulsebridge-broken");
  });

  it("skips directories without a package.json silently", async () => {
    const nmDir = await makeTempNodeModules("no-pkg-json");
    tempDirs.push(nmDir);

    // Create a directory with no package.json
    const pkgDir = join(nmDir, "not-a-package");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "index.mjs"), INTEGRATION_PLUGIN, "utf-8");

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("throws PulseBridgeError when the node_modules directory does not exist", async () => {
    const core = new PulseBridgeCore();
    const nonExistent = join(tmpdir(), "pulsebridge-nonexistent-nm-xyz123");

    await expect(core.discoverInstalledPlugins(nonExistent)).rejects.toThrow(
      PulseBridgeError,
    );
    await expect(core.discoverInstalledPlugins(nonExistent)).rejects.toThrow(
      "discoverInstalledPlugins failed",
    );
  });

  it("returns empty results for an empty node_modules directory", async () => {
    const nmDir = await makeTempNodeModules("empty");
    tempDirs.push(nmDir);

    const core = new PulseBridgeCore();
    const result = await core.discoverInstalledPlugins(nmDir);

    expect(result.registered).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});
