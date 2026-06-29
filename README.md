# PulseBridge

> A plugin-based integration runtime for Node.js — poll external APIs, receive webhooks, and trigger actions, all normalized into canonical records your application can read anywhere.

[![npm version](https://img.shields.io/npm/v/pulsebridge.svg)](https://www.npmjs.com/package/pulsebridge)
[![node](https://img.shields.io/node/v/pulsebridge.svg)](https://www.npmjs.com/package/pulsebridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Types: included](https://img.shields.io/badge/types-included-blue.svg)](#)

PulseBridge is a **library, not a server**. You initialize it once at your application's entry point; it then runs autonomously in the background — scheduling integrations, persisting their data as canonical records, and running reactive processors that turn those records into ready-to-serve views.

## Features

- **Three interaction modes** — scheduled polling (pull), inbound webhooks (push-in), and on-demand actions (push-out), all behind a single plugin contract.
- **Canonical records** — every source normalizes to a typed `PulseRecord<T>`; processors react to record updates and emit named views.
- **Encrypted secrets at rest** — AES-256-GCM with a host-supplied master key and strict per-plugin namespacing. The core never reads `process.env`.
- **Resilient by default** — a typed error model with exponential backoff, rate-limit handling, and an optional per-plugin circuit breaker.
- **Pluggable persistence** — in-memory for dev and tests, Redis for production; bring your own by implementing the store interfaces.
- **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM / NodeNext, types bundled.

## Install

```bash
npm install pulsebridge
```

Requires **Node.js ≥ 20**. Redis support is an optional peer dependency:

```bash
npm install ioredis  # only when using RedisRecordStore / RedisViewStore
```

> **Zod** v4 is a direct dependency. If your plugin uses `configSchema`, import `z` from `"zod"`. A project already on Zod v3 will have both coexist in `node_modules` — import from `"zod"` consistently so TypeScript resolves the right `ZodType`.

## Quick start

A plugin is a plain object implementing the `IntegrationPlugin` contract — no base class, no decorators:

```ts
import { PulseBridgeCore, PluginKinds } from "pulsebridge";
import type {
  IntegrationPlugin,
  RuntimeContext,
  PulseRecord,
} from "pulsebridge";

const weather: IntegrationPlugin = {
  manifest: {
    id: "weather",
    name: "Weather",
    version: "1.0.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "current",
        name: "Current conditions",
        recordType: "weather.current",
      },
    ],
    polling: { defaultIntervalMs: 60_000, hard: false },
    auth: { type: "apiKey", secrets: [{ key: "WEATHER_KEY", required: true }] },
  },

  async execute(_operationId, ctx: RuntimeContext): Promise<PulseRecord[]> {
    const key = ctx.secrets.get("WEATHER_KEY");
    const res = await fetch(`https://api.example.com/now?key=${key}`);
    return [
      {
        type: "weather.current",
        timestamp: new Date().toISOString(),
        source: "weather",
        data: await res.json(),
      },
    ];
  },
};

const platform = new PulseBridgeCore({
  masterKey: process.env.PB_MASTER_KEY, // encrypts secrets at rest
});

await platform.registerIntegration(weather);
// Hand the plugin only the keys it declares in its manifest.
await platform.provision("weather", { WEATHER_KEY: process.env.WEATHER_KEY! });

await platform.start(); // boots per-plugin scheduler, runs in the background
await platform.waitForReady(); // resolves once the initial pass completes
```

Read data from anywhere in your application — this never triggers a live API call:

```ts
const records = await platform.getRecordsByType("weather.current");
const view = await platform.getView("my-view");
```

## How it works

```
Integration plugins   poll external APIs on a configurable interval
        ↓
Canonical records     normalized PulseRecord<T> objects written to the store
        ↓
Processor plugins     run reactively whenever their consumed record types update
        ↓
Views                 PulseViewRecord<T> objects available via getView()
```

## Interaction modes

A plugin can connect to a system three ways — all declared in one manifest, all sharing the same scoped-secret and error model:

| Mode        | Direction | Plugin method | Triggered by               | Core API                                       |
| ----------- | --------- | ------------- | -------------------------- | ---------------------------------------------- |
| **Poll**    | pull      | `execute()`   | the scheduler, on interval | automatic                                      |
| **Action**  | push-out  | `invoke()`    | the host, on demand        | `platform.invokeAction(id, actionId, payload)` |
| **Webhook** | push-in   | `ingest()`    | an external sender         | `platform.ingest(id, { body, headers })`       |

Actions return an `ActionResult` — a response payload plus optional records to persist (additive; never replaces a poll bucket). Webhooks receive the **raw request bytes** so the plugin can verify the sender's signature before trusting the body, and return a `WebhookResult`.

> The webhook surface is the platform's first internet-facing, unauthenticated entry point. Signature/secret verification inside `ingest()` is mandatory — the core hands you the raw payload precisely so you can compute an HMAC over exactly what the sender signed.

## Official plugins

A growing set of ready-made integrations lives in the [pulsebridge-plugins](https://github.com/Prsgoo/pulsebridge-plugins) monorepo. Install any over npm:

```bash
npm install @prsgoo/integration-openweather
```

They conform to the same contract as any third-party plugin. Scaffold your own self-contained package:

```bash
npm create pulsebridge-plugin@latest
```

## Plugin types

### Integration plugins

Connect to one external system. Declare auth requirements, polling interval, and operations in a manifest. Implement `execute()` to fetch and normalize data into canonical `PulseRecord<T>` objects.

```ts
import type {
  IntegrationPlugin,
  RuntimeContext,
  PulseRecord,
} from "pulsebridge";
import { PluginKinds } from "pulsebridge";

export class MyIntegration implements IntegrationPlugin {
  readonly manifest = {
    id: "@example/my-integration",
    kind: PluginKinds.INTEGRATION,
    operations: [{ id: "fetch-data" }],
    // hard: false → user can override the interval (clamped to minIntervalMs)
    // hard: true  → interval is fixed (API rate-limit constraint)
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
import { PluginKinds } from "pulsebridge";

export class MyProcessor implements ProcessorPlugin {
  readonly manifest = {
    id: "@example/my-processor",
    kind: PluginKinds.PROCESSOR,
    consumes: ["weather.current"], // record types this processor reacts to
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
    consumes: [], // receives all record types
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

  // Encrypted secret storage (defaults to InMemorySecretBackend)
  secretBackend: new RedisSecretBackend({ client: redisClient }),
  // Master key that encrypts secrets at rest (host-supplied)
  masterKey: process.env.PB_MASTER_KEY,

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
await platform.registerIntegration(new MyIntegration(), undefined, {
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

| Class                 | When to throw                         | Platform response                                                                   |
| --------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `PluginAuthError`     | Credentials rejected by the API       | Sets status `auth_error`                                                            |
| `ReauthRequiredError` | Token expired / session invalid       | Calls `reauth()`, sets `needs_reauth` if not implemented                            |
| `RateLimitError`      | HTTP 429 or equivalent                | Backs off for `retryAfterMs` (or `rateLimitDefaultBackoffMs`, or `2× pollInterval`) |
| `PluginInputError`    | Bad action payload / unsigned webhook | Surfaced to the caller; does not degrade the polling channel                        |

Accessing a secret key not declared in the plugin manifest throws `ScopedSecretAccessError` (a subclass of `PluginAuthError`), handled identically to an auth error — no exponential backoff, status set to `auth_error`.

Unexpected errors trigger exponential backoff (doubles per consecutive failure, capped at `maxDegradedBackoffMs`). If `maxConsecutiveFailures` is set, the plugin is permanently disabled after that many consecutive failures.

## Secrets

The host stores secret values through `provision()`; the core encrypts them at rest and hands each plugin a scoped, read-only view containing only the keys it declared in its manifest:

```ts
// Declared in manifest:
auth: {
  secrets: [{ key: "MY_KEY", required: true }];
}

// Host provisions the value (sourced however it likes — env, form, vault):
await platform.provision("my-plugin-id", { MY_KEY: process.env.MY_KEY });

// Available in execute():
const value = context.secrets.get("MY_KEY"); // ok
context.secrets.get("OTHER_KEY"); // throws ScopedSecretAccessError
```

Secrets are namespaced by plugin id — strict isolation, no cross-plugin access. The core never reads `process.env`. Storage of the encrypted blobs is pluggable via `secretBackend`:

| Class                   | Use case                      |
| ----------------------- | ----------------------------- |
| `InMemorySecretBackend` | Tests and local dev (default) |
| `RedisSecretBackend`    | Persistence across restarts   |

Encryption is AES-256-GCM, keyed from the host-supplied `masterKey`. Without a master key, plugins that declare required secrets go to `auth_error` while the rest keep running.

## Persistence

| Store                                       | Use case                                      |
| ------------------------------------------- | --------------------------------------------- |
| `InMemoryRecordStore` / `InMemoryViewStore` | Tests, examples, single-process apps          |
| `RedisRecordStore` / `RedisViewStore`       | Production; enables multi-process read access |

Both implement the `RecordStore` / `ViewStore` interfaces — you can provide your own.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
