# Changelog

All notable changes to `pulsebridge` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [0.1.0] — 2026-06-29

Initial public release.

### Added

- **`PulseBridgeCore` runtime** — register integration and processor plugins, run them on a per-plugin scheduler, and read normalized data anywhere via `getRecordsByType()` / `getView()`. Reads never trigger a live API call.
- **Three interaction modes** — scheduled polling (`execute()`), on-demand actions (`invokeAction()` → plugin `invoke()`), and inbound webhooks (`ingest()`), all behind a single plugin contract.
- **Canonical records & reactive processors** — sources normalize to `PulseRecord<T>`; processors react when their consumed record types update and emit named `PulseViewRecord<T>` views, with `produces` / `consumesViews` topological ordering.
- **Encrypted secret provisioning** — `provision()` / `deprovision()` with AES-256-GCM at rest, a host-supplied master key, and strict per-plugin secret scoping. The core never reads `process.env`.
- **Resilient execution** — typed error model (`PluginAuthError`, `ReauthRequiredError`, `RateLimitError`, `PluginInputError`, `ScopedSecretAccessError`, …), exponential degraded backoff, rate-limit handling, an optional per-plugin circuit breaker, execution timeouts, and a graceful shutdown drain.
- **On-demand reconfigure & refresh** — `configureIntegration()` reconfigures a single plugin in place; `refreshIntegration()` forces an immediate repoll of one plugin without waiting for its next scheduled tick.
- **Plugin status & health** — `plugin:status-changed` / `view:updated` events, `getPluginState()`, `listPluginStates()`, `getHealth()`, and manual `enablePlugin()` / `disablePlugin()`.
- **Pluggable persistence** — in-memory and Redis (`ioredis`, optional peer dependency) record / view / secret / token stores behind swappable interfaces.
- **Strict TypeScript / ESM** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, NodeNext; type declarations bundled.
