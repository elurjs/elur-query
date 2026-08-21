# Changelog

## 1.5.0

### Added

- **Single-Flight Request Deduplication**: when two or more components mount the same query key simultaneously with an empty cache, only one fetch is fired. All subscribers share the same in-flight promise. Applies to both base keys and param-scoped keys.
- **`keepPreviousData` option** for `createQuery`: retains the previous data visible while a new fetch is in progress (e.g. after params change), eliminating UI flicker.
- **`placeholderData` option** for `createQuery`: shows a static value or function-derived value while a fetch is pending and no cached data is available. `keepPreviousData` takes priority when previous data exists.
- **`serializeParams` option** for `createQuery`, `getQueryData`, `setQueryData`, `updateQueryData` and `clearQueryCache`: allows a custom serializer for params used to build the effective cache key.
- **`dispose()` method** on both `createQuery` and `createCommand` results: explicitly removes global listeners, cancels in-flight requests, unregisters from global registries, and stops param signal tracking. Idempotent.

### Fixed

- **Memory leak in `createCommand`**: the `window.addEventListener("online", ...)` listener registered by `queueOffline` mode was never removed. `dispose()` now calls `removeEventListener` and cleans up `_globalCommandQueues`, `_globalLatestControllers`, and `_globalReplayLocks`.
- **`_stableStringify` robustness**:
  - `Date` is now serialized via `.toISOString()` (always UTC, timezone-safe).
  - `Map` entries are sorted deterministically regardless of insertion order.
  - `Set` values are sorted deterministically regardless of insertion order.
  - Circular references now throw a `TypeError` instead of causing a stack overflow (uses a `WeakSet` for tracking).
- **`invalidateQueries` and `clearQueryCache`** now clear in-flight requests so subscribers start a fresh fetch instead of sharing a stale promise.

## 1.4.2

### Added

- `QueryResult.key` exposes the effective cache key used by a query instance (including serialized params when applicable).
- `QueryCacheOptions` with optional `params` support for `getQueryData`, `setQueryData`, `updateQueryData` and `clearQueryCache`, so cache helpers target the correct param-scoped key (`baseKey::<serializedParams>`).

### Fixed

- `clearQueryCache(key)` now removes all param-scoped variants of `key`, consistent with `invalidateQueries`.

## 1.4.1

### Fixed

- `invalidateQueries(key)` now invalidates all param-scoped cache variants of `key` (`key::<serialized-params>`), not just the exact base key. This fixes stale data after mutations when `createQuery` uses `params`.

## 1.4.0

### Added

- Reactive params support for `createQuery` (TanStack Query style).
  - New `QueryOptions.params?: () => P` function that reads signals and rebuilds the cache key automatically when they change.
  - `createQuery` fetcher signature is now `asyncFn: (params: P) => Promise<T>`.
  - Effective cache key is `key::<stable-serialized-params>`; each distinct params value is cached independently.
  - In-flight responses for stale params are ignored to prevent race conditions.
- Added `_stableStringify` helper for deterministic params serialization.

## 1.3.0

- Command utilities (`createCommand`) with modes `latest`, `queue`, `parallel`, `queueOffline`.
- Offline command queue adapter contract.
- Optimistic rollback helpers (`onMutate`, `onError`, `onSettled`).
- Cache read/write helpers: `getQueryData`, `setQueryData`, `updateQueryData`, `invalidateQueries`, `clearQueryCache`.
