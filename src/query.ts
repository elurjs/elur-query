import { signal, effect, type Signal } from "@elurjs/core";

export type QueryStatus = "pending" | "success" | "error";

export interface QueryResult<T> {
    readonly key: string;
    readonly status: Signal<QueryStatus>;
    readonly data: Signal<T | undefined>;
    readonly error: Signal<unknown>;
    refetch(): void;
    /** Remove from global registries and stop tracking param signals. */
    dispose(): void;
}

export interface QueryOptions<P = void, T = unknown> {
    /**
     * Time in ms that cached data is considered fresh.
     * While fresh, mounting will not trigger a background refetch.
     * @default 0
     */
    staleTime?: number;
    /**
     * - "always" — background refetch on every mount (default).
     * - "stale"  — refetch only when data has exceeded `staleTime`.
     * - `false`   — never refetch on mount; only via `refetch()` or `invalidateQueries()`.
     * @default "always"
     */
    refetchOnMount?: "always" | "stale" | false;
    /**
     * Reactive params source. Read signals inside this function; whenever any
     * of them changes, the query recomputes its cache key and refetches
     * automatically (TanStack-Query style). The returned value is passed to
     * the fetcher and serialized into the effective cache key, so different
     * params are cached independently.
     * @default undefined
     */
    params?: () => P;
    /**
     * Custom serializer for params used to build the effective cache key.
     * When omitted, a built-in deterministic serializer is used that handles
     * plain objects, arrays, Date, Map, Set and detects circular references.
     * Provide your own to support exotic types or to optimize for hot paths.
     */
    serializeParams?: (params: unknown) => string;
    /**
     * When `true`, the previous data remains visible while a new fetch is in
     * progress (e.g. after params change). Eliminates UI flicker.
     * @default false
     */
    keepPreviousData?: boolean;
    /**
     * Data to show while a fetch is pending and no cached data is available.
     * Can be a static value or a function receiving the previous data.
     * @default undefined
     */
    placeholderData?: T | ((previousData: T | undefined) => T | undefined);
}

export interface QueryCacheOptions {
    /**
     * Params value used to build the effective cache key (`baseKey::<serializedParams>`).
     * When omitted, the helpers operate on the exact base key.
     */
    params?: unknown;
    /**
     * Custom serializer matching the one used by `createQuery`.
     * Ensures imperative helpers target the same effective key.
     */
    serializeParams?: (params: unknown) => string;
}

interface CacheEntry<T = unknown> {
    data?: T;
    fetchedAt: number;
    subscribers: number;
}

type QuerySyncHandler = () => void;

const _queryCache = new Map<string, CacheEntry>();

const DEFAULT_CACHE_TIME = 5 * 60 * 1000;
let _gcTimer: ReturnType<typeof setInterval> | null = null;
let _cacheTime = DEFAULT_CACHE_TIME;

function _startGC(): void {
    if (_gcTimer !== null) return;
    _gcTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of _queryCache) {
            if (entry.subscribers <= 0 && now - entry.fetchedAt > _cacheTime) {
                _queryCache.delete(key);
            }
        }
        if (_queryCache.size === 0 && _gcTimer !== null) {
            clearInterval(_gcTimer);
            _gcTimer = null;
        }
    }, 60_000);
}

function _getCacheEntry<T>(key: string): CacheEntry<T> | undefined {
    const entry = _queryCache.get(key);
    if (entry && entry.fetchedAt > 0) return entry as CacheEntry<T>;
    return undefined;
}

function _setCacheEntry<T>(key: string, data: T): void {
    const existing = _queryCache.get(key);
    _queryCache.set(key, {
        data,
        fetchedAt: Date.now(),
        subscribers: existing?.subscribers ?? 0,
    });
    _startGC();
}

/**
 * Deterministic serialization of params used to build the effective cache key.
 *
 * - Object keys are sorted so `{ a, b }` and `{ b, a }` produce the same key.
 * - `Date` is serialized via `.toISOString()` (always UTC, timezone-safe).
 * - `Map` and `Set` are serialized with sorted entries so equal structures
 *   produce the same key regardless of insertion order.
 * - Circular references throw a `TypeError` instead of causing a stack overflow.
 */
function _stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
    if (value === undefined) return "";
    if (value === null) return "null";
    if (typeof value !== "object") return JSON.stringify(value);

    // Date — timezone-safe: toISOString() always returns UTC.
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }

    // Map — stable: entries sorted by serialized key.
    if (value instanceof Map) {
        const entries = Array.from(value.entries()).sort(([a], [b]) => {
            const sa = _stableStringify(a, seen);
            const sb = _stableStringify(b, seen);
            return sa < sb ? -1 : sa > sb ? 1 : 0;
        });
        return `Map([${entries
            .map(([k, v]) => `[${_stableStringify(k, seen)},${_stableStringify(v, seen)}]`)
            .join(",")}])`;
    }

    // Set — stable: values sorted by serialized form.
    if (value instanceof Set) {
        const arr = Array.from(value).sort((a, b) => {
            const sa = _stableStringify(a, seen);
            const sb = _stableStringify(b, seen);
            return sa < sb ? -1 : sa > sb ? 1 : 0;
        });
        return `Set([${arr.map((v) => _stableStringify(v, seen)).join(",")}])`;
    }

    // Circular reference guard — throw instead of stack overflow.
    if (seen.has(value as object)) {
        throw new TypeError("Cannot serialize circular structure in query params");
    }
    seen.add(value as object);

    try {
        if (Array.isArray(value)) {
            return `[${value.map((v) => _stableStringify(v, seen)).join(",")}]`;
        }
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        return `{${keys
            .map((k) => `${JSON.stringify(k)}:${_stableStringify(obj[k], seen)}`)
            .join(",")}}`;
    } finally {
        seen.delete(value as object);
    }
}

function _effectiveKey(key: string, options?: QueryCacheOptions): string {
    if (!options || options.params === undefined) return key;
    const serialize = options.serializeParams ?? _stableStringify;
    return `${key}::${serialize(options.params)}`;
}

function _isFresh(key: string, staleTime: number): boolean {
    const entry = _queryCache.get(key);
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < staleTime;
}

const _queryRegistry = new Map<string, Set<() => void>>();
const _querySyncRegistry = new Map<string, Set<QuerySyncHandler>>();

/**
 * Single-flight request deduplication: when two components mount the same
 * query key simultaneously with an empty cache, only one fetch is fired.
 * Both subscribers share the same promise.
 */
const _inflightRequests = new Map<string, Promise<unknown>>();

function _getInflight<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = _inflightRequests.get(key);
    if (existing) return existing as Promise<T>;
    const p = factory();
    _inflightRequests.set(key, p);
    p.then(
        () => {
            if (_inflightRequests.get(key) === p) _inflightRequests.delete(key);
        },
        () => {
            if (_inflightRequests.get(key) === p) _inflightRequests.delete(key);
        }
    );
    return p;
}

function _clearInflight(key: string, prefix: string): void {
    for (const k of Array.from(_inflightRequests.keys())) {
        if (k === key || k.startsWith(prefix)) {
            _inflightRequests.delete(k);
        }
    }
}

const _queryLifecycleCleanup = new FinalizationRegistry<{
    key: string;
    run: () => void;
    sync: QuerySyncHandler;
}>(({ key, run, sync }) => {
    const handlers = _queryRegistry.get(key);
    if (handlers) {
        handlers.delete(run);
        if (handlers.size === 0) _queryRegistry.delete(key);
    }

    const syncHandlers = _querySyncRegistry.get(key);
    if (syncHandlers) {
        syncHandlers.delete(sync);
        if (syncHandlers.size === 0) _querySyncRegistry.delete(key);
    }
});

function _notifyQuerySync(key: string): void {
    const handlers = _querySyncRegistry.get(key);
    if (!handlers) return;
    for (const fn of handlers) {
        fn();
    }
}

/**
 * Clears one or all entries from the global query cache.
 * Passing no argument clears everything.
 *
 * When a base key is provided, all param-scoped variants (`key::<params>`)
 * are also removed so the clear behaves consistently with `invalidateQueries`.
 */
export function clearQueryCache(key?: string): void {
    if (key !== undefined) {
        const prefix = `${key}::`;
        const matchingKeys: string[] = [];
        for (const k of _queryCache.keys()) {
            if (k === key || k.startsWith(prefix)) matchingKeys.push(k);
        }
        for (const k of matchingKeys) {
            _queryCache.delete(k);
            _notifyQuerySync(k);
        }
        _clearInflight(key, prefix);
    } else {
        const keys = Array.from(_queryCache.keys());
        _queryCache.clear();
        for (const k of keys) _notifyQuerySync(k);
        _inflightRequests.clear();
        if (_gcTimer !== null) {
            clearInterval(_gcTimer);
            _gcTimer = null;
        }
    }
}

/**
 * Sets how long cache entries with zero subscribers are kept alive.
 * @param ms Milliseconds. Pass `Infinity` to keep entries forever.
 */
export function setQueryCacheTime(ms: number): void {
    _cacheTime = ms;
}

/**
 * Reads the current cached data for a key (if present).
 * Pass `{ params }` to target the effective cache key used by queries with reactive params.
 */
export function getQueryData<T>(key: string, options?: QueryCacheOptions): T | undefined {
    const entry = _getCacheEntry<T>(_effectiveKey(key, options));
    return entry?.data;
}

/**
 * Writes data directly into query cache and updates active query signals.
 * Pass `{ params }` to target the effective cache key used by queries with reactive params.
 */
export function setQueryData<T>(key: string, data: T, options?: QueryCacheOptions): void {
    const effectiveKey = _effectiveKey(key, options);
    _setCacheEntry(effectiveKey, data);
    _notifyQuerySync(effectiveKey);
}

/**
 * Atomically updates cached data from previous value and updates active query signals.
 * Pass `{ params }` to target the effective cache key used by queries with reactive params.
 */
export function updateQueryData<T>(
    key: string,
    updater: (current: T | undefined) => T,
    options?: QueryCacheOptions
): T {
    const next = updater(getQueryData<T>(key, options));
    setQueryData(key, next, options);
    return next;
}

/**
 * Forces all active `createQuery()` instances with the given key to re-fetch.
 * Clears the cached data so subsequent mounts also fetch fresh data.
 * Instances that have been garbage-collected are pruned automatically.
 *
 * When queries are created with `params`, their effective cache key is
 * `<baseKey>::<serializedParams>`. Invalidating the base key (e.g.
 * `invalidateQueries("events/checklist")`) also invalidates every param
 * variant of that key so mutations don't have to know the current params.
 */
export function invalidateQueries(key: string): void {
    const prefix = `${key}::`;
    const matchingKeys: string[] = [];
    for (const k of _queryCache.keys()) {
        if (k === key || k.startsWith(prefix)) matchingKeys.push(k);
    }
    for (const k of matchingKeys) {
        _queryCache.delete(k);
        _notifyQuerySync(k);
    }
    // Clear in-flight requests so subscribers start a fresh fetch instead of
    // sharing a stale promise that was started before the invalidation.
    _clearInflight(key, prefix);
    for (const [k, handlers] of _queryRegistry) {
        if (k === key || k.startsWith(prefix)) {
            for (const run of handlers) run();
        }
    }
}

const _queryEffectCleanup = new FinalizationRegistry<() => void>((dispose) => {
    dispose();
});

/**
 * Key-based async data fetching with global cache and invalidation.
 * Returns reactive signals for pending/success/error flows.
 *
 * When `options.params` is provided, the query tracks the signals read inside
 * it and automatically recomputes its cache key + refetches whenever they
 * change. Each distinct params value is cached independently and the fetcher
 * receives the current params.
 */
export function createQuery<T, P = void>(
    key: string,
    asyncFn: (params: P) => Promise<T>,
    options: QueryOptions<P, T> = {}
): QueryResult<T> {
    const {
        staleTime = 0,
        refetchOnMount = "always",
        params,
        serializeParams,
        keepPreviousData = false,
        placeholderData,
    } = options;

    const _serialize = serializeParams ?? _stableStringify;

    const status = signal<QueryStatus>("pending");
    const data = signal<T | undefined>(undefined);
    const error = signal<unknown>(undefined);

    let currentKey = key;
    let currentParams = undefined as P;
    let unbind: (() => void) | null = null;
    let effectDispose: (() => void) | null = null;
    let disposed = false;

    const _resolvePlaceholder = (): T | undefined => {
        if (typeof placeholderData === "function") {
            return (placeholderData as (prev: T | undefined) => T | undefined)(data.peek());
        }
        return placeholderData as T | undefined;
    };

    const _fetch = (k: string, p: P): void => {
        // Single-flight: share the in-flight promise across subscribers.
        _getInflight<T>(k, () => asyncFn(p)).then(
            (result) => {
                // Ignore responses from a key that is no longer current
                // (e.g. params changed while a request was in flight).
                if (k !== currentKey || disposed) return;
                _setCacheEntry(k, result);
                data.value = result;
                error.value = undefined;
                status.value = "success";
            },
            (err) => {
                if (k !== currentKey || disposed) return;
                error.value = err;
                status.value = "error";
            }
        );
    };

    const _run = (k: string, p: P): void => {
        if (status.peek() === "pending") {
            error.value = undefined;
            if (keepPreviousData && data.peek() !== undefined) {
            } else if (placeholderData !== undefined) {
                data.value = _resolvePlaceholder();
            } else {
                data.value = undefined;
            }
        }
        _fetch(k, p);
    };

    const _bind = (k: string, p: P): (() => void) => {
        const run = (): void => _run(k, p);

        if (!_queryRegistry.has(k)) _queryRegistry.set(k, new Set());
        const handlers = _queryRegistry.get(k)!;
        handlers.add(run);

        const sync: QuerySyncHandler = () => {
            const next = _getCacheEntry<T>(k);
            if (next && next.data !== undefined) {
                status.value = "success";
                data.value = next.data;
                error.value = undefined;
                return;
            }
            if (keepPreviousData && data.peek() !== undefined) {
                status.value = "pending";
                error.value = undefined;
            } else if (placeholderData !== undefined) {
                status.value = "pending";
                error.value = undefined;
                data.value = _resolvePlaceholder();
            } else {
                status.value = "pending";
                error.value = undefined;
                data.value = undefined;
            }
        };

        if (!_querySyncRegistry.has(k)) _querySyncRegistry.set(k, new Set());
        const syncHandlers = _querySyncRegistry.get(k)!;
        syncHandlers.add(sync);

        _queryLifecycleCleanup.register(status as object, { key: k, run, sync });

        return () => {
            handlers.delete(run);
            if (handlers.size === 0) _queryRegistry.delete(k);
            syncHandlers.delete(sync);
            if (syncHandlers.size === 0) _querySyncRegistry.delete(k);
        };
    };

    const _activate = (k: string, p: P): void => {
        const cached = _getCacheEntry<T>(k);
        if (cached) {
            status.value = "success";
            data.value = cached.data;
            error.value = undefined;
        } else {
            if (keepPreviousData && data.peek() !== undefined) {
                status.value = "pending";
                error.value = undefined;
            } else if (placeholderData !== undefined) {
                status.value = "pending";
                error.value = undefined;
                data.value = _resolvePlaceholder();
            } else {
                status.value = "pending";
                data.value = undefined;
                error.value = undefined;
            }
        }

        const fresh = _isFresh(k, staleTime);
        if (!cached) {
            // _activate already set up placeholder/keepPreviousData above,
            // so call _fetch directly instead of _run (which would re-apply).
            _fetch(k, p);
        } else if (refetchOnMount === false) {
        } else if (refetchOnMount === "stale" && fresh) {
        } else if (refetchOnMount === "always" && fresh && staleTime > 0) {
        } else {
            _fetch(k, p);
        }
    };

    if (params) {
        effectDispose = effect(() => {
            const p = params();
            const k = `${key}::${_serialize(p)}`;
            // No change in effective key — dedupe, keep current binding.
            if (unbind && k === currentKey) return;
            if (unbind) unbind();
            currentKey = k;
            currentParams = p;
            unbind = _bind(k, p);
            _activate(k, p);
        });
        _queryEffectCleanup.register(status as object, effectDispose);
    } else {
        currentKey = key;
        currentParams = undefined as P;
        unbind = _bind(key, currentParams);
        _activate(key, currentParams);
    }

    const _dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (unbind) {
            unbind();
            unbind = null;
        }
        if (effectDispose) {
            effectDispose();
            effectDispose = null;
        }
    };

    return {
        key: currentKey,
        status,
        data,
        error,
        refetch: () => {
            _queryCache.delete(currentKey);
            _inflightRequests.delete(currentKey);
            _run(currentKey, currentParams);
        },
        dispose: _dispose,
    };
}

/**
 * @internal — Debug accessor for `@elurjs/query/devtools`. Not part of the
 * public API and not exported from the package index.
 */
export function _debugQueryInternals(): {
    cache: Map<string, CacheEntry>;
    inflight: Map<string, Promise<unknown>>;
    cacheTime: number;
    activeQueryCount: number;
} {
    return {
        cache: _queryCache,
        inflight: _inflightRequests,
        cacheTime: _cacheTime,
        activeQueryCount: _queryRegistry.size,
    };
}
