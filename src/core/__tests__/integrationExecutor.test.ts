/**
 * Unit tests for IntegrationExecutor — drives the executor directly with real
 * collaborators (registry, state manager, backoff manager, in-memory stores,
 * encrypted vault) and a controllable clock/logger so every guard, error path,
 * and log emission is exercised in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IntegrationExecutor } from "../integrationExecutor.js";
import { PluginRegistry } from "../pluginRegistry.js";
import { PluginStateManager } from "../pluginStateManager.js";
import { BackoffManager } from "../backoffManager.js";
import { InMemoryRecordStore } from "../../storage/inMemoryRecordStore.js";
import { EncryptedSecretVault } from "../../contracts/secrets/encryptedSecretVault.js";
import { InMemorySecretBackend } from "../../contracts/secrets/inMemorySecretBackend.js";
import { InMemorySecretStore } from "../../contracts/secrets/inMemorySecretStore.js";
import { InMemoryTokenStore } from "../../contracts/tokens/inMemoryTokenStore.js";
import {
  PluginAuthError,
  PluginInputError,
  RateLimitError,
  ReauthRequiredError,
  TransientError,
} from "../../contracts/errors/pulseErrors.js";
import type { IntegrationPlugin } from "../../plugin-sdk/integrationPlugin.js";
import type { IntegrationPluginManifest } from "../../contracts/plugins/integrationPluginManifest.js";
import type { PulseRecord } from "../../contracts/records/pulseRecord.js";
import type { PulseLogger } from "../../contracts/runtime/pulseLogger.js";
import type { RuntimeContext } from "../../contracts/runtime/runtimeContext.js";

const PLUGIN_ID = "test/integration";
const MASTER_KEY = "test-master-key-0123456789";
const RECORD_TYPE = "test.record";
const BASE_TIME = new Date("2026-01-01T00:00:00.000Z").getTime();

interface LogEntry {
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

class SpyLogger implements PulseLogger {
  readonly entries: LogEntry[] = [];

  debug(message: string, meta?: Record<string, unknown>): void {
    this.push("debug", message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.push("info", message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.push("warn", message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.push("error", message, meta);
  }

  entry(level: string, message: string): LogEntry | undefined {
    return this.entries.find((e) => e.level === level && e.message === message);
  }

  private push(
    level: string,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.entries.push(
      meta === undefined ? { level, message } : { level, message, meta },
    );
  }
}

interface PluginOverrides {
  id?: string;
  auth?: IntegrationPluginManifest["auth"];
  polling?: IntegrationPluginManifest["polling"];
  rateLimit?: IntegrationPluginManifest["rateLimit"];
  operations?: IntegrationPluginManifest["operations"];
  actions?: IntegrationPluginManifest["actions"];
  webhook?: IntegrationPluginManifest["webhook"];
  execute?: IntegrationPlugin["execute"];
  reauth?: IntegrationPlugin["reauth"];
  invoke?: IntegrationPlugin["invoke"];
  ingest?: IntegrationPlugin["ingest"];
}

function makePlugin(overrides: PluginOverrides = {}): IntegrationPlugin {
  const manifest: IntegrationPluginManifest = {
    id: overrides.id ?? PLUGIN_ID,
    name: "Test Integration",
    version: "1.0.0",
    kind: "integration",
    operations: overrides.operations ?? [
      { id: "op", name: "Op", recordType: RECORD_TYPE },
    ],
    polling: overrides.polling ?? { defaultIntervalMs: 60_000, hard: true },
    ...(overrides.auth ? { auth: overrides.auth } : {}),
    ...(overrides.rateLimit ? { rateLimit: overrides.rateLimit } : {}),
    ...(overrides.actions ? { actions: overrides.actions } : {}),
    ...(overrides.webhook ? { webhook: overrides.webhook } : {}),
  };
  return {
    manifest,
    execute: overrides.execute ?? (async () => []),
    ...(overrides.reauth ? { reauth: overrides.reauth } : {}),
    ...(overrides.invoke ? { invoke: overrides.invoke } : {}),
    ...(overrides.ingest ? { ingest: overrides.ingest } : {}),
  };
}

function makeRecord(type: string = RECORD_TYPE): PulseRecord {
  return {
    type,
    timestamp: new Date(BASE_TIME).toISOString(),
    source: PLUGIN_ID,
    data: {},
  };
}

interface SetupOptions {
  masterKey?: string;
  executionTimeoutMs?: number;
  rateLimitDefaultBackoffMs?: number;
  maxConsecutiveFailures?: number;
  withTokens?: boolean;
  recordStore?: InMemoryRecordStore;
}

function setup(opts: SetupOptions = {}) {
  const logger = new SpyLogger();
  const registry = new PluginRegistry(logger);
  const stateManager = new PluginStateManager(() => {});
  const backoffManager = new BackoffManager({
    maxConsecutiveFailures: opts.maxConsecutiveFailures,
    maxDegradedBackoffMs: 300_000,
    stateManager,
    logger,
  });
  const recordStore = opts.recordStore ?? new InMemoryRecordStore();
  const vault = new EncryptedSecretVault(
    new InMemorySecretBackend(),
    opts.masterKey,
  );
  const tokenStore = new InMemoryTokenStore();
  const context: RuntimeContext = {
    logger,
    now: () => new Date(),
    secrets: new InMemorySecretStore(),
    ...(opts.withTokens ? { tokens: tokenStore } : {}),
  };
  const executor = new IntegrationExecutor({
    registry,
    stateManager,
    backoffManager,
    recordStore,
    vault,
    tokenStore: opts.withTokens ? tokenStore : undefined,
    executionTimeoutMs: opts.executionTimeoutMs ?? 30_000,
    rateLimitDefaultBackoffMs: opts.rateLimitDefaultBackoffMs,
    context,
  });

  function register(
    plugin: IntegrationPlugin,
    operationIds: string[] = ["op"],
  ) {
    registry.setIntegration(plugin.manifest.id, plugin);
    for (const operationId of operationIds) {
      registry.addOperation(plugin.manifest.id, { operationId });
    }
  }

  return {
    logger,
    registry,
    stateManager,
    backoffManager,
    recordStore,
    vault,
    tokenStore,
    context,
    executor,
    register,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IntegrationExecutor — execute() guards", () => {
  it("skips a disabled plugin and returns an empty array", async () => {
    const h = setup();
    h.register(makePlugin());
    h.stateManager.disablePlugin(PLUGIN_ID);

    const result = await h.executor.execute(PLUGIN_ID);

    expect(result).toEqual([]);
  });

  it("logs an info message when skipping a disabled plugin", async () => {
    const h = setup();
    h.register(makePlugin());
    h.stateManager.disablePlugin(PLUGIN_ID);

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry("info", "Skipping disabled integration plugin."),
    ).toEqual({
      level: "info",
      message: "Skipping disabled integration plugin.",
      meta: { pluginId: PLUGIN_ID },
    });
  });

  it("does not call execute() on a disabled plugin", async () => {
    const h = setup();
    const execute = vi.fn(async () => []);
    h.register(makePlugin({ execute }));
    h.stateManager.disablePlugin(PLUGIN_ID);

    await h.executor.execute(PLUGIN_ID);

    expect(execute).not.toHaveBeenCalled();
  });

  it("returns an empty array for an unregistered plugin", async () => {
    const h = setup();

    const result = await h.executor.execute("unknown-plugin");

    expect(result).toEqual([]);
  });

  it("skips a plugin whose previous execution is still in flight", async () => {
    const h = setup({ executionTimeoutMs: 1_000_000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.register(
      makePlugin({
        execute: async () => {
          await gate;
          return [];
        },
      }),
    );

    const first = h.executor.execute(PLUGIN_ID, { forceRun: true });
    const second = await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(second).toEqual([]);
    release();
    await first;
  });

  it("logs a debug message when a previous execution is still in flight", async () => {
    const h = setup({ executionTimeoutMs: 1_000_000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.register(
      makePlugin({
        execute: async () => {
          await gate;
          return [];
        },
      }),
    );

    const first = h.executor.execute(PLUGIN_ID, { forceRun: true });
    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(
      h.logger.entry(
        "debug",
        "Skipping plugin — previous execution still in progress.",
      ),
    ).toEqual({
      level: "debug",
      message: "Skipping plugin — previous execution still in progress.",
      meta: { pluginId: PLUGIN_ID },
    });
    release();
    await first;
  });

  it("skips a plugin called again within its minimum poll interval", async () => {
    const h = setup();
    h.register(
      makePlugin({ polling: { defaultIntervalMs: 5_000, hard: true } }),
    );

    await h.executor.execute(PLUGIN_ID);
    vi.setSystemTime(BASE_TIME + 1_000);
    const result = await h.executor.execute(PLUGIN_ID);

    expect(result).toEqual([]);
  });

  it("logs a debug message when skipping within the minimum poll interval", async () => {
    const h = setup();
    h.register(
      makePlugin({ polling: { defaultIntervalMs: 5_000, hard: true } }),
    );

    await h.executor.execute(PLUGIN_ID);
    vi.setSystemTime(BASE_TIME + 1_000);
    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry(
        "debug",
        "Skipping integration plugin — within minimum poll interval.",
      ),
    ).toEqual({
      level: "debug",
      message: "Skipping integration plugin — within minimum poll interval.",
      meta: { pluginId: PLUGIN_ID },
    });
  });

  it("runs again once the minimum poll interval has elapsed", async () => {
    const h = setup();
    const execute = vi.fn(async () => [makeRecord()]);
    h.register(
      makePlugin({
        polling: { defaultIntervalMs: 5_000, hard: true },
        execute,
      }),
    );

    await h.executor.execute(PLUGIN_ID);
    vi.setSystemTime(BASE_TIME + 6_000);
    await h.executor.execute(PLUGIN_ID);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("forceRun bypasses the minimum poll interval", async () => {
    const h = setup();
    const execute = vi.fn(async () => [makeRecord()]);
    h.register(
      makePlugin({
        polling: { defaultIntervalMs: 5_000, hard: true },
        execute,
      }),
    );

    await h.executor.execute(PLUGIN_ID);
    vi.setSystemTime(BASE_TIME + 1_000);
    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("skips a rate-limited plugin and returns an empty array", async () => {
    const h = setup();
    h.register(makePlugin());
    h.backoffManager.setRateLimitBackoff(PLUGIN_ID, BASE_TIME + 10_000);

    const result = await h.executor.execute(PLUGIN_ID);

    expect(result).toEqual([]);
  });

  it("logs a debug message with backoff remaining when rate limited", async () => {
    const h = setup();
    h.register(makePlugin());
    h.backoffManager.setRateLimitBackoff(PLUGIN_ID, BASE_TIME + 10_000);

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry(
        "debug",
        "Skipping integration plugin — rate limit backoff in effect.",
      ),
    ).toEqual({
      level: "debug",
      message: "Skipping integration plugin — rate limit backoff in effect.",
      meta: { pluginId: PLUGIN_ID, backoffRemainingMs: 10_000 },
    });
  });

  it("forceRun bypasses an active rate-limit backoff", async () => {
    const h = setup();
    const execute = vi.fn(async () => []);
    h.register(makePlugin({ execute }));
    h.backoffManager.setRateLimitBackoff(PLUGIN_ID, BASE_TIME + 10_000);

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("skips a degraded plugin within its backoff window", async () => {
    const h = setup();
    h.register(makePlugin());
    h.backoffManager.setTransientBackoff(PLUGIN_ID, 10_000);

    const result = await h.executor.execute(PLUGIN_ID);

    expect(result).toEqual([]);
  });

  it("logs a debug message with backoff remaining when degraded", async () => {
    const h = setup();
    h.register(makePlugin());
    h.backoffManager.setTransientBackoff(PLUGIN_ID, 10_000);

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry("debug", "Skipping degraded plugin — backoff in effect."),
    ).toEqual({
      level: "debug",
      message: "Skipping degraded plugin — backoff in effect.",
      meta: { pluginId: PLUGIN_ID, backoffRemainingMs: 10_000 },
    });
  });
});

describe("IntegrationExecutor — successful run", () => {
  it("returns the updated record types", async () => {
    const h = setup();
    h.register(
      makePlugin({ execute: async () => [makeRecord("a"), makeRecord("b")] }),
      ["op"],
    );

    const result = await h.executor.execute(PLUGIN_ID);

    expect(result.sort()).toEqual(["a", "b"]);
  });

  it("deduplicates record types across records", async () => {
    const h = setup();
    h.register(
      makePlugin({ execute: async () => [makeRecord("a"), makeRecord("a")] }),
    );

    const result = await h.executor.execute(PLUGIN_ID);

    expect(result).toEqual(["a"]);
  });

  it("persists the produced records to the store", async () => {
    const h = setup();
    h.register(makePlugin({ execute: async () => [makeRecord()] }));

    await h.executor.execute(PLUGIN_ID);

    const stored = await h.recordStore.getByType(RECORD_TYPE);
    expect(stored).toHaveLength(1);
  });

  it("sets plugin status to enabled after a successful run", async () => {
    const h = setup();
    h.register(makePlugin({ execute: async () => [makeRecord()] }));

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.status).toBe("enabled");
  });

  it("records lastRunAt after a successful run", async () => {
    const h = setup();
    h.register(makePlugin({ execute: async () => [makeRecord()] }));

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.lastRunAt).toBe(
      new Date(BASE_TIME).toISOString(),
    );
  });

  it("clears a prior lastError after a successful run", async () => {
    const h = setup();
    h.register(makePlugin({ execute: async () => [makeRecord()] }));
    h.stateManager.setPluginStatus(PLUGIN_ID, "degraded", {
      lastError: "previous failure",
    });

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.lastError).toBeUndefined();
  });

  it("clears integration backoff after a successful run", async () => {
    const h = setup();
    h.register(makePlugin({ execute: async () => [makeRecord()] }));
    h.backoffManager.setTransientBackoff(PLUGIN_ID, 10_000);

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(h.backoffManager.isDegradedBackoff(PLUGIN_ID)).toBe(false);
  });

  it("passes operation params through to execute()", async () => {
    const h = setup();
    const execute = vi.fn(async () => []);
    h.registry.setIntegration(PLUGIN_ID, makePlugin({ execute }));
    h.registry.addOperation(PLUGIN_ID, {
      operationId: "op",
      params: { page: 2 },
    });

    await h.executor.execute(PLUGIN_ID);

    expect(execute).toHaveBeenCalledWith("op", expect.anything(), { page: 2 });
  });
});

describe("IntegrationExecutor — secret checks", () => {
  it("fails closed when oauth2 auth has no TokenStore configured", async () => {
    const h = setup({ withTokens: false });
    h.register(makePlugin({ auth: { type: "oauth2" } }));

    const result = await h.executor.execute(PLUGIN_ID);

    expect(result).toEqual([]);
  });

  it("sets auth_error when oauth2 auth has no TokenStore configured", async () => {
    const h = setup({ withTokens: false });
    h.register(makePlugin({ auth: { type: "oauth2" } }));

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "auth_error",
      lastError:
        "oauth2 auth requires a TokenStore configured on PulseBridgeCore",
    });
  });

  it("does not call execute() when oauth2 lacks a TokenStore", async () => {
    const h = setup({ withTokens: false });
    const execute = vi.fn(async () => []);
    h.register(makePlugin({ auth: { type: "oauth2" }, execute }));

    await h.executor.execute(PLUGIN_ID);

    expect(execute).not.toHaveBeenCalled();
  });

  it("fails with a descriptive error when no master key can read a required secret", async () => {
    const h = setup();
    h.register(
      makePlugin({
        auth: { type: "apiKey", secrets: [{ key: "API_KEY", required: true }] },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "auth_error",
      lastError: "No master key configured to read required secrets: API_KEY",
    });
  });

  it("logs the missing secret names when failing due to missing secrets", async () => {
    const h = setup();
    h.register(
      makePlugin({
        auth: { type: "apiKey", secrets: [{ key: "API_KEY", required: true }] },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry("warn", "Skipping plugin due to missing secrets."),
    ).toEqual({
      level: "warn",
      message: "Skipping plugin due to missing secrets.",
      meta: { pluginId: PLUGIN_ID, missingSecrets: "API_KEY" },
    });
  });

  it("proceeds when there is no master key but only optional secrets are declared", async () => {
    const h = setup();
    const execute = vi.fn(async () => []);
    h.register(
      makePlugin({
        auth: {
          type: "apiKey",
          secrets: [{ key: "OPTIONAL", required: false }],
        },
        execute,
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails when a master key is set but a required secret is missing", async () => {
    const h = setup({ masterKey: MASTER_KEY });
    h.register(
      makePlugin({
        auth: { type: "apiKey", secrets: [{ key: "API_KEY", required: true }] },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "auth_error",
      lastError: "Missing required secrets: API_KEY",
    });
  });

  it("logs declared optional secrets that are not configured", async () => {
    const h = setup({ masterKey: MASTER_KEY });
    await h.vault.set(PLUGIN_ID, "API_KEY", "value");
    h.register(
      makePlugin({
        auth: {
          type: "apiKey",
          secrets: [
            { key: "API_KEY", required: true },
            { key: "OPTIONAL", required: false },
          ],
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry(
        "debug",
        "Plugin has declared optional secrets that are not configured.",
      ),
    ).toEqual({
      level: "debug",
      message: "Plugin has declared optional secrets that are not configured.",
      meta: { pluginId: PLUGIN_ID, missingOptionalSecrets: "OPTIONAL" },
    });
  });

  it("hands a provisioned secret to the plugin via the scoped context", async () => {
    const h = setup({ masterKey: MASTER_KEY });
    await h.vault.set(PLUGIN_ID, "API_KEY", "the-secret");
    let seen: string | undefined;
    h.register(
      makePlugin({
        auth: { type: "apiKey", secrets: [{ key: "API_KEY", required: true }] },
        execute: async (_op, context) => {
          seen = context.secrets.get("API_KEY");
          return [];
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(seen).toBe("the-secret");
  });

  it("denies all secret access when no master key is configured", async () => {
    const h = setup();
    let seen: string | undefined = "unset";
    h.register(
      makePlugin({
        auth: {
          type: "apiKey",
          secrets: [{ key: "API_KEY", required: false }],
        },
        execute: async (_op, context) => {
          seen = context.secrets.get("API_KEY");
          return [];
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(seen).toBeUndefined();
  });
});

describe("IntegrationExecutor — OAuth2 token expiry", () => {
  it("sets needs_reauth when a stored token is already expired", async () => {
    const h = setup({ withTokens: true });
    h.tokenStore.set(PLUGIN_ID, {
      accessToken: "tok",
      expiresAt: new Date(BASE_TIME - 1_000).toISOString(),
    });
    h.register(makePlugin({ auth: { type: "oauth2" } }));

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "needs_reauth",
      lastError: "OAuth2 token expired",
    });
  });

  it("logs the expiry with the token key", async () => {
    const h = setup({ withTokens: true });
    h.tokenStore.set(PLUGIN_ID, {
      accessToken: "tok",
      expiresAt: new Date(BASE_TIME - 1_000).toISOString(),
    });
    h.register(makePlugin({ auth: { type: "oauth2" } }));

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry("info", "OAuth2 token expired — triggering reauth."),
    ).toEqual({
      level: "info",
      message: "OAuth2 token expired — triggering reauth.",
      meta: { pluginId: PLUGIN_ID, tokenKey: PLUGIN_ID },
    });
  });

  it("does not trigger reauth when the token is still valid", async () => {
    const h = setup({ withTokens: true });
    const execute = vi.fn(async () => []);
    h.tokenStore.set(PLUGIN_ID, {
      accessToken: "tok",
      expiresAt: new Date(BASE_TIME + 3_600_000).toISOString(),
    });
    h.register(makePlugin({ auth: { type: "oauth2" }, execute }));

    await h.executor.execute(PLUGIN_ID);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses the manifest tokenKey when resolving the stored token", async () => {
    const h = setup({ withTokens: true });
    h.tokenStore.set("custom-key", {
      accessToken: "tok",
      expiresAt: new Date(BASE_TIME - 1_000).toISOString(),
    });
    h.register(
      makePlugin({ auth: { type: "oauth2", tokenKey: "custom-key" } }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.status).toBe(
      "needs_reauth",
    );
  });
});

describe("IntegrationExecutor — reauth handling", () => {
  it("skips execution when status is needs_reauth and no reauth() is implemented", async () => {
    const h = setup();
    const execute = vi.fn(async () => []);
    h.register(makePlugin({ execute }));
    h.stateManager.setPluginStatus(PLUGIN_ID, "needs_reauth");

    const result = await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("warns when reauth is required but not implemented", async () => {
    const h = setup();
    h.register(makePlugin());
    h.stateManager.setPluginStatus(PLUGIN_ID, "needs_reauth");

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(
      h.logger.entry(
        "warn",
        "Plugin requires re-authentication but does not implement reauth(). Skipping until manually re-enabled.",
      ),
    ).toEqual({
      level: "warn",
      message:
        "Plugin requires re-authentication but does not implement reauth(). Skipping until manually re-enabled.",
      meta: { pluginId: PLUGIN_ID },
    });
  });

  it("resumes execution after a successful reauth()", async () => {
    const h = setup();
    const execute = vi.fn(async () => [makeRecord()]);
    h.register(makePlugin({ reauth: async () => {}, execute }));
    h.stateManager.setPluginStatus(PLUGIN_ID, "needs_reauth");

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("enables the plugin after a successful reauth()", async () => {
    const h = setup();
    h.register(makePlugin({ reauth: async () => {} }));
    h.stateManager.setPluginStatus(PLUGIN_ID, "needs_reauth");

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.status).toBe("enabled");
  });

  it("logs success after reauth()", async () => {
    const h = setup();
    h.register(makePlugin({ reauth: async () => {} }));
    h.stateManager.setPluginStatus(PLUGIN_ID, "needs_reauth");

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(
      h.logger.entry("info", "Plugin re-authentication succeeded."),
    ).toEqual({
      level: "info",
      message: "Plugin re-authentication succeeded.",
      meta: { pluginId: PLUGIN_ID },
    });
  });

  it("sets auth_error with the thrown message when reauth() fails", async () => {
    const h = setup();
    h.register(
      makePlugin({
        reauth: async () => {
          throw new Error("refresh rejected");
        },
      }),
    );
    h.stateManager.setPluginStatus(PLUGIN_ID, "needs_reauth");

    const result = await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(result).toEqual([]);
    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "auth_error",
      lastError: "refresh rejected",
    });
  });

  it("logs an error when reauth() fails", async () => {
    const h = setup();
    h.register(
      makePlugin({
        reauth: async () => {
          throw new Error("refresh rejected");
        },
      }),
    );
    h.stateManager.setPluginStatus(PLUGIN_ID, "needs_reauth");

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(h.logger.entry("error", "Plugin re-authentication failed.")).toEqual(
      {
        level: "error",
        message: "Plugin re-authentication failed.",
        meta: { pluginId: PLUGIN_ID, error: "refresh rejected" },
      },
    );
  });
});

describe("IntegrationExecutor — operation errors", () => {
  it("applies the retryAfter backoff and sets rate_limited on RateLimitError", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new RateLimitError("429", 3_000);
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.status).toBe(
      "rate_limited",
    );
    expect(h.backoffManager.rateLimitBackoffRemaining(PLUGIN_ID)).toBe(3_000);
  });

  it("falls back to the configured default backoff on RateLimitError", async () => {
    const h = setup({ rateLimitDefaultBackoffMs: 7_000 });
    h.register(
      makePlugin({
        execute: async () => {
          throw new RateLimitError("429");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.backoffManager.rateLimitBackoffRemaining(PLUGIN_ID)).toBe(7_000);
  });

  it("falls back to twice the effective interval on RateLimitError", async () => {
    const h = setup();
    h.register(
      makePlugin({
        polling: { defaultIntervalMs: 60_000, hard: true },
        execute: async () => {
          throw new RateLimitError("429");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.backoffManager.rateLimitBackoffRemaining(PLUGIN_ID)).toBe(120_000);
  });

  it("logs the backoff amount on RateLimitError", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new RateLimitError("429", 3_000);
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry("warn", "Integration is rate limited — backing off."),
    ).toMatchObject({
      meta: { pluginId: PLUGIN_ID, operationId: "op", backoffMs: 3_000 },
    });
  });

  it("sets needs_reauth on ReauthRequiredError", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new ReauthRequiredError("expired");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "needs_reauth",
      lastError: "expired",
    });
  });

  it("sets auth_error on PluginAuthError", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new PluginAuthError("bad key");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "auth_error",
      lastError: "bad key",
    });
  });

  it("applies a fixed transient backoff and sets degraded on TransientError", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new TransientError("5xx", 4_000);
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.status).toBe("degraded");
    expect(h.backoffManager.degradedBackoffRemaining(PLUGIN_ID)).toBe(4_000);
  });

  it("uses the default transient backoff when no retryAfter is given", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new TransientError("5xx");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.backoffManager.degradedBackoffRemaining(PLUGIN_ID)).toBe(30_000);
  });

  it("sets degraded and applies backoff on a generic error", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "degraded",
      lastError: "boom",
    });
  });

  it("logs the consecutive failure count on a generic error", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry("error", "Integration execution failed."),
    ).toMatchObject({
      meta: {
        pluginId: PLUGIN_ID,
        operationId: "op",
        error: "boom",
        consecutiveFailures: 1,
      },
    });
  });

  it("disables the plugin when the circuit breaker trips", async () => {
    const h = setup({ maxConsecutiveFailures: 1 });
    h.register(
      makePlugin({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.status).toBe("disabled");
  });

  it("logs the circuit-breaker trip", async () => {
    const h = setup({ maxConsecutiveFailures: 1 });
    h.register(
      makePlugin({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry(
        "error",
        "Integration circuit breaker tripped — plugin disabled until manually re-enabled.",
      ),
    ).toEqual({
      level: "error",
      message:
        "Integration circuit breaker tripped — plugin disabled until manually re-enabled.",
      meta: { pluginId: PLUGIN_ID, operationId: "op" },
    });
  });

  it("uses 'Unknown integration error' when a non-Error is thrown", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw "string failure";
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.lastError).toBe(
      "Unknown integration error",
    );
  });

  it("stops the operation loop after the first failure", async () => {
    const h = setup();
    const execute = vi.fn(async (operationId: string) => {
      if (operationId === "op1") throw new Error("boom");
      return [makeRecord()];
    });
    h.register(makePlugin({ execute }), ["op1", "op2"]);

    const result = await h.executor.execute(PLUGIN_ID);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it("does not persist records when an operation fails", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(await h.recordStore.getAll()).toHaveLength(0);
  });
});

describe("IntegrationExecutor — request pacing", () => {
  it("waits the per-request minimum gap before calling execute()", async () => {
    const h = setup();
    const calls: number[] = [];
    h.register(
      makePlugin({
        rateLimit: { requestsPerMinute: 60 },
        execute: async () => {
          calls.push(Date.now());
          return [];
        },
      }),
    );
    h.backoffManager.setLastRequestAt(PLUGIN_ID, BASE_TIME - 200);

    const pending = h.executor.execute(PLUGIN_ID, { forceRun: true });
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(calls).toHaveLength(1);
  });

  it("does not wait when no rate limit is configured", async () => {
    const h = setup();
    const execute = vi.fn(async () => []);
    h.register(makePlugin({ execute }));
    h.backoffManager.setLastRequestAt(PLUGIN_ID, BASE_TIME - 1);

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("IntegrationExecutor — persistence failures", () => {
  it("sets degraded with the store error and returns empty when persistence fails", async () => {
    const recordStore = new InMemoryRecordStore();
    vi.spyOn(recordStore, "setByPlugin").mockRejectedValue(
      new Error("redis down"),
    );
    const h = setup({ recordStore });
    h.register(makePlugin({ execute: async () => [makeRecord()] }));

    const result = await h.executor.execute(PLUGIN_ID);

    expect(result).toEqual([]);
    expect(h.stateManager.getPluginState(PLUGIN_ID)).toMatchObject({
      status: "degraded",
      lastError: "redis down",
    });
  });

  it("logs the store write failure", async () => {
    const recordStore = new InMemoryRecordStore();
    vi.spyOn(recordStore, "setByPlugin").mockRejectedValue(
      new Error("redis down"),
    );
    const h = setup({ recordStore });
    h.register(makePlugin({ execute: async () => [makeRecord()] }));

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry(
        "error",
        "Failed to write records to store — integration output discarded.",
      ),
    ).toEqual({
      level: "error",
      message:
        "Failed to write records to store — integration output discarded.",
      meta: { pluginId: PLUGIN_ID, error: "redis down" },
    });
  });
});

describe("IntegrationExecutor — additional coverage", () => {
  it("warns when oauth2 auth has no TokenStore configured", async () => {
    const h = setup({ withTokens: false });
    h.register(makePlugin({ auth: { type: "oauth2" } }));

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry(
        "warn",
        "Skipping plugin — oauth2 auth requires a TokenStore but none is configured.",
      ),
    ).toEqual({
      level: "warn",
      message:
        "Skipping plugin — oauth2 auth requires a TokenStore but none is configured.",
      meta: { pluginId: PLUGIN_ID },
    });
  });

  it("joins multiple required secret names when no master key is configured", async () => {
    const h = setup();
    h.register(
      makePlugin({
        auth: {
          type: "apiKey",
          secrets: [
            { key: "API_KEY", required: true },
            { key: "SECONDARY", required: true },
          ],
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.lastError).toBe(
      "No master key configured to read required secrets: API_KEY, SECONDARY",
    );
  });

  it("joins multiple missing required secret names when a master key is set", async () => {
    const h = setup({ masterKey: MASTER_KEY });
    h.register(
      makePlugin({
        auth: {
          type: "apiKey",
          secrets: [
            { key: "API_KEY", required: true },
            { key: "SECONDARY", required: true },
          ],
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.lastError).toBe(
      "Missing required secrets: API_KEY, SECONDARY",
    );
  });

  it("reports only the unconfigured optional secrets", async () => {
    const h = setup({ masterKey: MASTER_KEY });
    await h.vault.set(PLUGIN_ID, "API_KEY", "value");
    await h.vault.set(PLUGIN_ID, "OPT_SET", "value");
    h.register(
      makePlugin({
        auth: {
          type: "apiKey",
          secrets: [
            { key: "API_KEY", required: true },
            { key: "OPT_SET", required: false },
            { key: "OPT_ONE", required: false },
            { key: "OPT_TWO", required: false },
          ],
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry(
        "debug",
        "Plugin has declared optional secrets that are not configured.",
      )?.meta?.missingOptionalSecrets,
    ).toBe("OPT_ONE, OPT_TWO");
  });

  it("uses 'Reauth failed' when reauth() throws a non-Error", async () => {
    const h = setup();
    h.register(
      makePlugin({
        reauth: async () => {
          throw "string failure";
        },
      }),
    );
    h.stateManager.setPluginStatus(PLUGIN_ID, "needs_reauth");

    await h.executor.execute(PLUGIN_ID, { forceRun: true });

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.lastError).toBe(
      "Reauth failed",
    );
  });

  it("includes the operation label in the timeout error", async () => {
    const h = setup({ executionTimeoutMs: 50 });
    h.register(
      makePlugin({ execute: () => new Promise<PulseRecord[]>(() => {}) }),
    );

    const pending = h.executor.execute(PLUGIN_ID, { forceRun: true });
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.lastError).toBe(
      "test/integration.op timed out after 50ms",
    );
  });

  it("records the error message on a rate_limited state", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new RateLimitError("upstream said 429", 1_000);
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(h.stateManager.getPluginState(PLUGIN_ID)?.lastError).toBe(
      "upstream said 429",
    );
  });

  it("logs the operation when reauth is required mid-run", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new ReauthRequiredError("expired");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry("warn", "Integration requires re-authentication."),
    ).toEqual({
      level: "warn",
      message: "Integration requires re-authentication.",
      meta: { pluginId: PLUGIN_ID, operationId: "op" },
    });
  });

  it("logs the auth failure detail mid-run", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new PluginAuthError("bad key");
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry("warn", "Integration authentication failed."),
    ).toEqual({
      level: "warn",
      message: "Integration authentication failed.",
      meta: { pluginId: PLUGIN_ID, operationId: "op", error: "bad key" },
    });
  });

  it("logs the transient error detail and backoff", async () => {
    const h = setup();
    h.register(
      makePlugin({
        execute: async () => {
          throw new TransientError("5xx", 4_000);
        },
      }),
    );

    await h.executor.execute(PLUGIN_ID);

    expect(
      h.logger.entry(
        "warn",
        "Integration hit a transient error — retrying after short backoff.",
      ),
    ).toEqual({
      level: "warn",
      message:
        "Integration hit a transient error — retrying after short backoff.",
      meta: {
        pluginId: PLUGIN_ID,
        operationId: "op",
        error: "5xx",
        backoffMs: 4_000,
      },
    });
  });
});

describe("IntegrationExecutor — actions (push-out)", () => {
  const ACTION_ID = "do-thing";

  function registerWithInvoke(
    h: ReturnType<typeof setup>,
    invoke: IntegrationPlugin["invoke"],
  ) {
    h.registry.setIntegration(
      PLUGIN_ID,
      makePlugin({ actions: [{ id: ACTION_ID, name: "Do Thing" }], invoke }),
    );
  }

  it("returns the plugin's action result data", async () => {
    const h = setup();
    registerWithInvoke(h, async () => ({ data: { ok: true } }));

    const result = await h.executor.invokeAction(PLUGIN_ID, ACTION_ID);

    expect(result.data).toEqual({ ok: true });
  });

  it("appends records the action returns to the store", async () => {
    const h = setup();
    registerWithInvoke(h, async () => ({ records: [makeRecord("act.out")] }));

    await h.executor.invokeAction(PLUGIN_ID, ACTION_ID);

    expect(await h.recordStore.getByType("act.out")).toHaveLength(1);
  });

  it("marks the action channel ok after a successful invoke", async () => {
    const h = setup();
    registerWithInvoke(h, async () => ({ data: null }));

    await h.executor.invokeAction(PLUGIN_ID, ACTION_ID);

    expect(
      h.stateManager.getPluginState(PLUGIN_ID)?.channels?.action,
    ).toMatchObject({ status: "ok" });
  });

  it("degrades the action channel on a system fault", async () => {
    const h = setup();
    registerWithInvoke(h, async () => {
      throw new PluginAuthError("bad key");
    });

    await expect(h.executor.invokeAction(PLUGIN_ID, ACTION_ID)).rejects.toThrow(
      "bad key",
    );
    expect(
      h.stateManager.getPluginState(PLUGIN_ID)?.channels?.action,
    ).toMatchObject({ status: "auth_error", lastError: "bad key" });
  });

  it("does not change the polling status on an action system fault", async () => {
    const h = setup();
    registerWithInvoke(h, async () => {
      throw new TransientError("upstream 503");
    });

    await expect(h.executor.invokeAction(PLUGIN_ID, ACTION_ID)).rejects.toThrow(
      "upstream 503",
    );
    expect(h.stateManager.getPluginState(PLUGIN_ID)?.status).toBe("enabled");
  });

  it("leaves the action channel untouched on a client input fault", async () => {
    const h = setup();
    registerWithInvoke(h, async () => {
      throw new PluginInputError("missing field");
    });

    await expect(
      h.executor.invokeAction(PLUGIN_ID, ACTION_ID),
    ).rejects.toBeInstanceOf(PluginInputError);
    expect(
      h.stateManager.getPluginState(PLUGIN_ID)?.channels?.action,
    ).toBeUndefined();
  });

  it("throws PluginInputError for an undeclared action", async () => {
    const h = setup();
    registerWithInvoke(h, async () => ({ data: null }));

    await expect(
      h.executor.invokeAction(PLUGIN_ID, "no-such-action"),
    ).rejects.toBeInstanceOf(PluginInputError);
  });

  it("throws PluginInputError when the plugin has no invoke()", async () => {
    const h = setup();
    h.register(makePlugin());

    await expect(
      h.executor.invokeAction(PLUGIN_ID, ACTION_ID),
    ).rejects.toBeInstanceOf(PluginInputError);
  });
});

describe("IntegrationExecutor — webhooks (push-in)", () => {
  function registerWithIngest(
    h: ReturnType<typeof setup>,
    ingest: IntegrationPlugin["ingest"],
  ) {
    h.registry.setIntegration(PLUGIN_ID, makePlugin({ webhook: {}, ingest }));
  }

  it("passes the raw request through to ingest()", async () => {
    const h = setup();
    let seenBody: string | undefined;
    registerWithIngest(h, async (_ctx, request) => {
      seenBody = request.body;
      return {};
    });

    await h.executor.ingestWebhook(PLUGIN_ID, {
      body: '{"event":"grab"}',
      headers: { "x-signature": "abc" },
    });

    expect(seenBody).toBe('{"event":"grab"}');
  });

  it("appends records the webhook returns to the store", async () => {
    const h = setup();
    registerWithIngest(h, async () => ({
      records: [makeRecord("hook.event")],
    }));

    await h.executor.ingestWebhook(PLUGIN_ID, { body: "", headers: {} });

    expect(await h.recordStore.getByType("hook.event")).toHaveLength(1);
  });

  it("degrades the webhook channel on a system fault", async () => {
    const h = setup();
    registerWithIngest(h, async () => {
      throw new TransientError("downstream write failed");
    });

    await expect(
      h.executor.ingestWebhook(PLUGIN_ID, { body: "", headers: {} }),
    ).rejects.toThrow("downstream write failed");
    expect(
      h.stateManager.getPluginState(PLUGIN_ID)?.channels?.webhook,
    ).toMatchObject({ status: "degraded" });
  });

  it("leaves the webhook channel untouched on an unsigned/invalid request", async () => {
    const h = setup();
    registerWithIngest(h, async () => {
      throw new PluginInputError("signature mismatch");
    });

    await expect(
      h.executor.ingestWebhook(PLUGIN_ID, { body: "", headers: {} }),
    ).rejects.toBeInstanceOf(PluginInputError);
    expect(
      h.stateManager.getPluginState(PLUGIN_ID)?.channels?.webhook,
    ).toBeUndefined();
  });

  it("throws PluginInputError when the plugin has no ingest()", async () => {
    const h = setup();
    h.register(makePlugin());

    await expect(
      h.executor.ingestWebhook(PLUGIN_ID, { body: "", headers: {} }),
    ).rejects.toBeInstanceOf(PluginInputError);
  });
});
