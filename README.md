# PulseBridge

A plugin-based integration runtime for Node.js. Connect external systems, normalize their data into canonical records, and process those records through composable plugins — all running autonomously in the background of your application.

## Install

```bash
npm install pulsebridge@alpha
```

Requires Node.js ≥ 20. Redis support is an optional peer dependency:

```bash
npm install ioredis  # only if using RedisRecordStore / RedisViewStore
```

**Zod v4** is bundled as a direct dependency. If your plugin uses `configSchema`, import `z` from `"zod"` and you'll get Zod v4. If your project already uses Zod v3, both will coexist in `node_modules` — just make sure you import from `"zod"` consistently in your plugin code so TypeScript resolves the right `ZodType`.

## Quick start

```ts
import { PulseBridgeCore, InMemorySecretStore } from "pulsebridge";
import { OpenSkyPlugin } from "@pulsebridge/integration-opensky";
import { PlanesFeedProcessor } from "@pulsebridge/processor-planes-feed";

const platform = new PulseBridgeCore({
  secrets: new InMemorySecretStore({ OPENSKY_KEY: process.env.OPENSKY_KEY }),
});

await platform.registerIntegration(new OpenSkyPlugin());
await platform.registerProcessor(new PlanesFeedProcessor());

await platform.start(); // boots per-plugin scheduler, runs in background
// ...
await platform.stop(); // drains in-flight executions, calls plugin destroy hooks
```

Read data from anywhere in your application — never triggers a live API call:

```ts
const view = await platform.getView("planes-feed");
const records = await platform.getRecordsByType("PLANES");
```

## How it works

PulseBridge is a **library, not a server**. You initialize it once at your application's entry point; it runs autonomously in the background.

```
Integration plugins        poll external APIs on a configurable interval
        ↓
Canonical records          normalized PulseRecord<T> objects written to the store
        ↓
Processor plugins          run reactively whenever their consumed record types update
        ↓
Views                      PulseViewRecord<T> objects available via getView()
```

## Plugin types

### Integration plugins

Connect to one external system. Declare their auth requirements, polling interval, and operations in a manifest. Implement `execute()` to fetch and normalize data into canonical `PulseRecord<T>` objects.

```ts
import type { IntegrationPlugin, RuntimeContext, PulseRecord } from "pulsebridge";
import { PluginKinds } from "pulsebridge";

export class MyIntegration implements IntegrationPlugin {
  readonly manifest = {
    id: "@example/my-integration",
    kind: PluginKinds.INTEGRATION,
    operations: [{ id: "fetch-data" }],
    // hard: false → user can override the interval (clamped to minIntervalMs)
    // hard: true  → interval is fixed (API rate limit constraint)
    polling: { defaultIntervalMs: 60_000, hard: false, minIntervalMs: 10_000 },
    auth: {
      type: "apiKey" as const,
      secrets: [{ key: "MY_API_KEY", required: true }],
    },
  };

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<PulseRecord[]> {
    const key = context.secrets.get("MY_API_KEY");
    // fetch, normalize, return
    return [];
  }
}
```

### Processor plugins

Consume canonical records and produce a named view. Run automatically whenever their consumed record types are updated. Declare `produces` so chained processors can depend on this processor's view.

```ts
import type {
  ProcessorPlugin,
  PulseRecord,
  PulseViewRecord,
  RuntimeContext,
} from "pulsebridge";
import { PluginKinds, RecordTypes } from "pulsebridge";

export class MyProcessor implements ProcessorPlugin {
  readonly manifest = {
    id: "@example/my-processor",
    kind: PluginKinds.PROCESSOR,
    consumes: [RecordTypes.PLANES],
    produces: ["my-view"], // declares the view name this processor emits
    providesCapabilities: [],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    _ctx: RuntimeContext,
  ): Promise<PulseViewRecord> {
    return {
      view: "my-view",
      generatedAt: new Date().toISOString(),
      items: records.map((r) => r.data),
    };
  }
}
```

### Processor chaining

A processor can depend on views produced by other processors using `consumesViews`. The platform uses `produces` and `consumesViews` to build a dependency graph and execute processors in the correct order.

```ts
export class SummaryProcessor implements ProcessorPlugin {
  readonly manifest = {
    id: "@example/summary-processor",
    kind: PluginKinds.PROCESSOR,
    consumes: [],          // receives all record types
    consumesViews: ["my-view"], // waits for MyProcessor to run first
    produces: ["summary"],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    _ctx: RuntimeContext,
    views?: ReadonlyArray<PulseViewRecord>, // contains "my-view" result
  ): Promise<PulseViewRecord> {
    // ...
  }
}
```

Processors that declare neither `produces` nor `consumesViews` run in the first pass. Chained processors run after their dependencies, all in topological order. The platform logs a warning if it detects a cycle.

## Configuration

```ts
const platform = new PulseBridgeCore({
  // Custom logger (defaults to console)
  logger: myLogger,

  // Secret store (defaults to InMemorySecretStore)
  secrets: new InMemorySecretStore({ API_KEY: "..." }),

  // OAuth2 token store — required for plugins that use auth.type "oauth2"
  tokens: new InMemoryTokenStore(),

  // Pluggable persistence (defaults to in-memory)
  store: {
    records: new RedisRecordStore({ client: redisClient }),
    views: new RedisViewStore({ client: redisClient }),
  },

  // Max time (ms) for a single integration execute() or reauth() call (default: 30_000)
  executionTimeoutMs: 15_000,

  // Max time (ms) for a single processor process() call (default: 30_000)
  processorTimeoutMs: 10_000,

  // Max exponential backoff duration for degraded plugins (default: 300_000 — 5 min)
  maxDegradedBackoffMs: 60_000,

  // Default rate-limit backoff when RateLimitError.retryAfterMs is not set
  // Falls back to 2× effectivePollInterval when unset
  rateLimitDefaultBackoffMs: 60_000,

  // Circuit breaker: permanently disable after N consecutive unexpected failures
  // When unset, retries indefinitely with exponential backoff
  maxConsecutiveFailures: 5,
});
```

### Overriding poll intervals

```ts
// Accepted only when manifest.polling.hard is false; clamped to manifest.polling.minIntervalMs
await platform.registerIntegration(new OpenSkyPlugin(), undefined, {
  pollIntervalMs: 30_000,
});
```

## Plugin status

The platform tracks the status of each plugin. Listen for transitions:

```ts
platform.on(
  "plugin:status-changed",
  ({ pluginId, previousStatus, newStatus }) => {
    console.log(`${pluginId}: ${previousStatus} → ${newStatus}`);
  },
);
```

Status values: `enabled` · `disabled` · `degraded` · `auth_error` · `needs_reauth` · `misconfigured` · `rate_limited`

```ts
// Inspect at any time
platform.getPluginState("my-plugin-id");
platform.listPluginStates();
platform.getHealth(); // { status: "healthy" | "degraded" | "stopped", running, plugins }

// Manual control
platform.disablePlugin("my-plugin-id", "optional reason");
platform.enablePlugin("my-plugin-id"); // also clears backoff state
```

## Error handling

Plugins signal errors by throwing typed classes exported from `pulsebridge`:

| Class | When to throw | Platform response |
| --- | --- | --- |
| `PluginAuthError` | Credentials rejected by the API | Sets status `auth_error` |
| `ReauthRequiredError` | Token expired / session invalid | Calls `reauth()`, sets `needs_reauth` if not implemented |
| `RateLimitError` | HTTP 429 or equivalent | Backs off for `retryAfterMs` (or `rateLimitDefaultBackoffMs`, or `2× pollInterval`) |

Accessing a secret key not declared in the plugin manifest throws `ScopedSecretAccessError` (a subclass of `PluginAuthError`), which the platform handles identically to an auth error — no exponential backoff, sets status `auth_error`.

Unexpected errors trigger exponential backoff (doubles per consecutive failure, capped at `maxDegradedBackoffMs`). If `maxConsecutiveFailures` is set, the plugin is permanently disabled after that many consecutive failures.

## Secrets

Secrets are passed to plugins through a scoped context — plugins can only access keys they declared in their manifest:

```ts
// Declared in manifest:
auth: {
  secrets: [{ key: "MY_KEY", required: true }];
}

// Available in execute():
const value = context.secrets.get("MY_KEY"); // ok
context.secrets.get("OTHER_KEY");            // throws ScopedSecretAccessError
```

Three built-in implementations:

| Class | Use case |
| --- | --- |
| `InMemorySecretStore` | Tests and local dev |
| `EnvSecretStore` | Reads directly from `process.env` |
| `ScopedSecretStore` | Internal — wraps global store per plugin; not used directly |

## Persistence

| Store | Use case |
| --- | --- |
| `InMemoryRecordStore` / `InMemoryViewStore` | Tests, examples, single-process apps |
| `RedisRecordStore` / `RedisViewStore` | Production; enables multi-process read access |

Both implement the `RecordStore` / `ViewStore` interfaces — you can provide your own.

## Plugin discovery

Auto-register plugins from a directory or from installed npm packages:

```ts
// Scan a local directory — imports each file, checks default/named exports for a manifest
const result = await platform.discover("./plugins");

// Scan node_modules for packages with keyword "pulsebridge-plugin" in package.json
const result = await platform.discoverInstalledPlugins();

console.log(result.registered); // plugin IDs that were registered
console.log(result.failed);     // [{ path, error }] for anything that failed to load
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
