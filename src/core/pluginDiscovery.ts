import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { PulseLogger } from "../contracts/runtime/pulseLogger.js";
import type { IntegrationPlugin } from "../plugin-sdk/integrationPlugin.js";
import type { ProcessorPlugin } from "../plugin-sdk/processorPlugin.js";
import { PluginKinds } from "../contracts/constants/pluginKinds.js";
import { PulseBridgeError } from "../contracts/errors/pulseErrors.js";

export interface DiscoveryResult {
  registered: string[];
  failed: Array<{ path: string; error: string }>;
}

interface RegistrationCallbacks {
  registerIntegration(plugin: IntegrationPlugin): Promise<void>;
  registerProcessor(plugin: ProcessorPlugin): Promise<void>;
}

/**
 * Scans a directory for plugin modules and auto-registers any integration or
 * processor plugins found. Each file/subdirectory is imported as an ESM module;
 * default and named exports are inspected for a `manifest.kind` field.
 */
export async function discoverPlugins(
  dir: string,
  callbacks: RegistrationCallbacks,
  logger: PulseLogger,
): Promise<DiscoveryResult> {
  const absDir = resolve(dir);

  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch (err) {
    throw new PulseBridgeError(
      `Plugin discovery failed: could not read directory '${absDir}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const registered: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const entry of entries) {
    const entryPath = join(absDir, entry);
    try {
      const mod = (await import(entryPath)) as Record<string, unknown>;
      await registerPluginExports(mod, registered, callbacks);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ path: entryPath, error });
      logger.warn("Plugin discovery: failed to load module.", {
        path: entryPath,
        error,
      });
    }
  }

  logger.info("Plugin discovery complete.", {
    directory: absDir,
    registered: registered.length,
    failed: failed.length,
  });

  return { registered, failed };
}

/**
 * Scans `node_modules` for installed packages that declare the
 * `"pulsebridge-plugin"` keyword in their `package.json` and auto-registers
 * any integration or processor plugins they export.
 *
 * Packages that declare the keyword but export no valid PulseBridge plugin
 * are skipped with a warning rather than causing a failure.
 *
 * @param nodeModulesDir - Path to the `node_modules` directory to scan.
 *   Defaults to `<cwd>/node_modules`.
 */
export async function discoverInstalledPlugins(
  nodeModulesDir: string | undefined,
  callbacks: RegistrationCallbacks,
  logger: PulseLogger,
): Promise<DiscoveryResult> {
  const nmDir = nodeModulesDir
    ? resolve(nodeModulesDir)
    : resolve(process.cwd(), "node_modules");

  let topLevel: string[];
  try {
    topLevel = await readdir(nmDir);
  } catch (err) {
    throw new PulseBridgeError(
      `discoverInstalledPlugins failed: could not read '${nmDir}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Collect all package directories, including scoped packages (@scope/pkg)
  const packageDirs: string[] = [];
  for (const entry of topLevel) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      const scopeDir = join(nmDir, entry);
      try {
        const scoped = await readdir(scopeDir);
        for (const pkg of scoped) {
          if (!pkg.startsWith(".")) packageDirs.push(join(scopeDir, pkg));
        }
      } catch {
        // Unreadable scope directory — skip silently
      }
    } else {
      packageDirs.push(join(nmDir, entry));
    }
  }

  const registered: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const pkgDir of packageDirs) {
    // Read and parse package.json — skip silently if absent or malformed
    let pkgMeta: {
      name?: string;
      keywords?: unknown;
      main?: string;
      exports?: unknown;
    };
    try {
      const raw = await readFile(join(pkgDir, "package.json"), "utf-8");
      pkgMeta = JSON.parse(raw) as typeof pkgMeta;
    } catch {
      continue;
    }

    // Only process packages that opt-in with the marker keyword
    if (
      !Array.isArray(pkgMeta.keywords) ||
      !(pkgMeta.keywords as unknown[]).includes("pulsebridge-plugin")
    ) {
      continue;
    }

    const pkgName = pkgMeta.name ?? pkgDir;
    const entryPath = resolvePackageEntry(
      pkgDir,
      pkgMeta.exports,
      pkgMeta.main,
    );

    try {
      const mod = (await import(entryPath)) as Record<string, unknown>;
      const pluginsFound = await registerPluginExports(
        mod,
        registered,
        callbacks,
      );

      if (!pluginsFound) {
        logger.warn(
          "discoverInstalledPlugins: package declares 'pulsebridge-plugin' keyword but exports no valid PulseBridge plugin.",
          { package: pkgName },
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ path: pkgName, error });
      logger.warn("discoverInstalledPlugins: failed to load plugin package.", {
        package: pkgName,
        error,
      });
    }
  }

  logger.info("discoverInstalledPlugins complete.", {
    registered: registered.length,
    failed: failed.length,
  });

  return { registered, failed };
}

/**
 * Inspects all exports of a module, registers every valid plugin found,
 * and pushes each registered plugin ID into `registered`.
 * Returns true if at least one plugin was registered.
 */
async function registerPluginExports(
  mod: Record<string, unknown>,
  registered: string[],
  callbacks: RegistrationCallbacks,
): Promise<boolean> {
  // Deduplicate by object identity so default + named exports pointing to
  // the same object are only registered once.
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];
  for (const c of [mod.default, ...Object.values(mod)]) {
    if (c != null && !seen.has(c)) {
      seen.add(c);
      candidates.push(c);
    }
  }

  let anyRegistered = false;
  for (const candidate of candidates) {
    if (!isPluginLike(candidate)) continue;

    const plugin = candidate as IntegrationPlugin | ProcessorPlugin;
    const kind = plugin.manifest.kind;

    if (kind === PluginKinds.INTEGRATION) {
      await callbacks.registerIntegration(plugin as IntegrationPlugin);
      registered.push(plugin.manifest.id);
      anyRegistered = true;
    } else if (kind === PluginKinds.PROCESSOR) {
      await callbacks.registerProcessor(plugin as ProcessorPlugin);
      registered.push(plugin.manifest.id);
      anyRegistered = true;
    }
  }

  return anyRegistered;
}

/**
 * Resolves the ESM entry point for an installed npm package.
 * Resolution order: `exports["."].import` → `exports["."].default` →
 * `exports["."]` (string) → `exports` (string shorthand) → `main` → `index.js`
 */
function resolvePackageEntry(
  pkgDir: string,
  exports: unknown,
  main: string | undefined,
): string {
  if (typeof exports === "string") return join(pkgDir, exports);
  if (exports !== null && typeof exports === "object") {
    const dot = (exports as Record<string, unknown>)["."];
    if (typeof dot === "string") return join(pkgDir, dot);
    if (dot !== null && typeof dot === "object") {
      const dotMap = dot as Record<string, unknown>;
      if (typeof dotMap.import === "string") return join(pkgDir, dotMap.import);
      if (typeof dotMap.default === "string")
        return join(pkgDir, dotMap.default);
    }
  }
  if (typeof main === "string") return join(pkgDir, main);
  return join(pkgDir, "index.js");
}

function isPluginLike(
  candidate: unknown,
): candidate is { manifest: { kind: string; id: string } } {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("manifest" in candidate)
  )
    return false;
  const { manifest } = candidate as { manifest: unknown };
  if (typeof manifest !== "object" || manifest === null) return false;
  const m = manifest as Record<string, unknown>;
  return typeof m.kind === "string" && typeof m.id === "string";
}
