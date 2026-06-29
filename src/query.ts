import { signal, effect, type Signal } from "@deijose/nix-js";

export type QueryStatus = "pending" | "success" | "error";

export interface QueryResult<T> {
    readonly status: Signal<QueryStatus>;
    readonly data: Signal<T | undefined>;
    readonly error: Signal<unknown>;
    refetch(): void;
}

export interface QueryOptions<P = void> {
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
 * Object keys are sorted so `{ a, b }` and `{ b, a }` produce the same key.
 */
function _stableStringify(value: unknown): string {
    if (value === undefined) return "";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(_stableStringify).join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${_stableStringify(obj[k])}`).join(",")}}`;
}

function _isFresh(key: string, staleTime: number): boolean {
    const entry = _queryCache.get(key);
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < staleTime;
}

const _queryRegistry = new Map<string, Set<() => void>>();
const _querySyncRegistry = new Map<string, Set<QuerySyncHandler>>();

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
 */
export function clearQueryCache(key?: string): void {
    if (key !== undefined) {
        _queryCache.delete(key);
        _notifyQuerySync(key);
    } else {
        const keys = Array.from(_queryCache.keys());
        _queryCache.clear();
        for (const k of keys) _notifyQuerySync(k);
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
 */
export function getQueryData<T>(key: string): T | undefined {
    const entry = _getCacheEntry<T>(key);
    return entry?.data;
}

/**
 * Writes data directly into query cache and updates active query signals.
 */
export function setQueryData<T>(key: string, data: T): void {
    _setCacheEntry(key, data);
    _notifyQuerySync(key);
}

/**
 * Atomically updates cached data from previous value and updates active query signals.
 */
export function updateQueryData<T>(
    key: string,
    updater: (current: T | undefined) => T
): T {
    const next = updater(getQueryData<T>(key));
    setQueryData(key, next);
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
    options: QueryOptions<P> = {}
): QueryResult<T> {
    const { staleTime = 0, refetchOnMount = "always", params } = options;

    const status = signal<QueryStatus>("pending");
    const data = signal<T | undefined>(undefined);
    const error = signal<unknown>(undefined);

    let currentKey = key;
    let currentParams = undefined as P;
    let unbind: (() => void) | null = null;

    const _fetch = (k: string, p: P): void => {
        asyncFn(p).then(
            (result) => {
                // Ignore responses from a key that is no longer current
                // (e.g. params changed while a request was in flight).
                if (k !== currentKey) return;
                _setCacheEntry(k, result);
                data.value = result;
                error.value = undefined;
                status.value = "success";
            },
            (err) => {
                if (k !== currentKey) return;
                error.value = err;
                status.value = "error";
            }
        );
    };

    const _run = (k: string, p: P): void => {
        if (status.peek() === "pending") {
            data.value = undefined;
            error.value = undefined;
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
            status.value = "pending";
            error.value = undefined;
            data.value = undefined;
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
            status.value = "pending";
            data.value = undefined;
            error.value = undefined;
        }

        const fresh = _isFresh(k, staleTime);
        if (!cached) {
            _run(k, p);
        } else if (refetchOnMount === false) {
            // skip
        } else if (refetchOnMount === "stale" && fresh) {
            // skip
        } else if (refetchOnMount === "always" && fresh && staleTime > 0) {
            // skip
        } else {
            _fetch(k, p);
        }
    };

    if (params) {
        const dispose = effect(() => {
            const p = params();
            const k = `${key}::${_stableStringify(p)}`;
            // No change in effective key — dedupe, keep current binding.
            if (unbind && k === currentKey) return;
            if (unbind) unbind();
            currentKey = k;
            currentParams = p;
            unbind = _bind(k, p);
            _activate(k, p);
        });
        _queryEffectCleanup.register(status as object, dispose);
    } else {
        currentKey = key;
        currentParams = undefined as P;
        unbind = _bind(key, currentParams);
        _activate(key, currentParams);
    }

    return {
        status,
        data,
        error,
        refetch: () => {
            _queryCache.delete(currentKey);
            _run(currentKey, currentParams);
        },
    };
}
