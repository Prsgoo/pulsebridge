# Changelog

All notable changes to `pulsebridge` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [0.1.0-alpha.0] — unreleased

### Added

- **Reauth flow** — `IntegrationPlugin` gains an optional `reauth?(context)` method. When a plugin's status is `needs_reauth`, the platform calls `reauth()` before the next execution attempt. On success the plugin resumes; on failure status is set to `auth_error`.
- **`RateLimitError`** — typed error class for HTTP 429 / rate limit responses. Accepts an optional `retryAfterMs` hint.
- **Rate limit backoff** — `RateLimitError` triggers a backoff for `retryAfterMs` (or `2× pollInterval` if not provided). `runOnce()` bypasses it.
- **Degraded backoff** — unexpected errors trigger exponential backoff (doubles per consecutive failure, capped at 5 minutes). Cleared on next successful execution.
- **Concurrent execution guard** — scheduler skips a tick if the previous execution for that plugin is still in progress.
- **Execution timeout** — configurable `executionTimeoutMs` (default 30 s) on `PulseBridgeCoreOptions`. Aborts `execute()` or `reauth()` if it exceeds the limit and marks the plugin `degraded`.
- **Graceful shutdown drain** — `stop()` waits for all in-flight executions before calling plugin `destroy()` hooks.
- **Parallel startup** — integrations execute concurrently on `start()`.
- **Store write resilience** — a failure writing to the record store sets the plugin to `degraded` without crashing the process.
- **`plugin:status-changed` event** — `PulseBridgeCore` extends `EventEmitter` and emits this event on every plugin status transition, with `pluginId`, `previousStatus`, and `newStatus`.
- **`lastError` cleared on recovery** — successful execution and `enablePlugin()` clear `lastError` so stale errors don't persist after recovery.

### Changed

- Package consolidated from separate `@pulsebridge/*` workspace packages into a single `pulsebridge` package.
- `PulseBridgeCoreOptions` gains `executionTimeoutMs?: number`.
- `enablePlugin()` now clears `lastError`.
- `setPluginStatus()` accepts `clearLastError?: true`.

---

## [0.9.1] — 2026-03-01

### Fixed

- `RedisRecordStore` / `RedisViewStore`: `JSON.parse` wrapped in `try/catch` to guard against corrupt store data.
- `PulseBridgeCore`: degraded state no longer incorrectly persisted across `resolveStateFields` calls; `warnMissingRecommendations` no longer throws on undefined manifest fields.

---

## [0.9.0] — 2026-02-15

### Added

- **Pluggable persistence** — `RecordStore` and `ViewStore` interfaces extracted to contracts; `PulseBridgeCoreOptions.store` accepts any implementation.
- **`RedisRecordStore`** / **`RedisViewStore`** — production store backed by `ioredis` (optional peer dependency).
- **`InMemoryRecordStore`** / **`InMemoryViewStore`** — lightweight in-process implementations for tests and examples. `setByPlugin()` isolates each integration's records to prevent parallel write collisions.

---

## [0.8.1] — 2026-02-01

### Fixed

- Edge cases in processor degraded state, `resolveStateFields`, and `warnMissingRecommendations` resolved in an audit pass.

---

## [0.8.0] — 2026-01-15

### Added

- **Typed error hierarchy** — `PulseBridgeError`, `PluginAuthError`, `ReauthRequiredError`.
- **`needs_reauth` status** — platform detects `ReauthRequiredError` thrown from `execute()` and sets plugin status accordingly.
- **Plugin `init` / `destroy` lifecycle** — `init` called after registration; `destroy` called on graceful `stop()`.
- **Zod config validation** — `IntegrationPlugin.configSchema` and `ProcessorPlugin.configSchema` validated at registration time.
- **`exports` field** — `package.json` uses the `exports` map with `types` and `import` conditions.

---

## [0.7.0] — 2025-12-15

### Added

- **Execution engine** — `start()` / `stop()` lifecycle with a per-plugin `setInterval` scheduler.
- **Polling configuration** — `manifest.polling` with `defaultIntervalMs`, optional `minIntervalMs`, and `hard` flag. User overrides are clamped to `minIntervalMs`.
- **Reactive processor triggering** — processors re-run automatically when any of their consumed record types are updated.
- **`runOnce()`** — fires all integrations then all processors once; bypasses rate limiting.
- **Rate limit guard** — prevents a plugin from executing more frequently than its declared interval.
- **`recommendsCapabilities`** — non-blocking capability hint; logs a warning when the recommended processor is absent.

---

## [0.6.0] — 2025-11-01

### Added

- Vitest test suite, ESLint, Prettier, GitHub Actions CI.
- Commitlint and Husky hooks.

---

## [0.5.0] — 2025-10-01

### Added

- **Secret-aware runtime** — `SecretStore`, `InMemorySecretStore`, `ScopedSecretStore`.
- Auth secret declaration in integration manifests (`manifest.auth.secrets`).
- Platform validates required secrets before each execution; sets `auth_error` on missing secrets.
- `PluginState` with `status`, `lastRunAt`, `lastError`, `disabledReason`.
- `enablePlugin()` / `disablePlugin()` on `PulseBridgeCore`.
