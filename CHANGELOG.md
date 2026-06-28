# Changelog

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
