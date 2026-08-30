/**
 * @elurjs/query/devtools — dev-only entry point.
 *
 * Registers a plugin on the elur DevTools backend hook
 * (`window.__ELUR_DEVTOOLS_HOOK__`) exposing the query cache, in-flight
 * requests and command queues. Only loaded when explicitly imported (the
 * Vite plugin injects it automatically in dev mode); never bundled into
 * production apps.
 */
import {
    _debugQueryInternals,
    clearQueryCache,
    invalidateQueries,
} from "./query.js";
import { _debugCommandInternals } from "./command.js";

export interface QueryCacheEntrySnapshot {
    key: string;
    fetchedAt: number;
    ageMs: number;
    subscribers: number;
    /** Truncated JSON preview of the cached data. */
    dataPreview: string;
    /** JSON-safe representation for expandable browser inspectors. */
    data: unknown;
}

export interface CommandSnapshot {
    key: string;
    hasQueue: boolean;
    hasInflightLatest: boolean;
    replayLocked: boolean;
}

export interface QueryDevtoolsSnapshot {
    cacheTime: number;
    activeQueryCount: number;
    inflight: string[];
    cache: QueryCacheEntrySnapshot[];
    commands: CommandSnapshot[];
}

export type QueryDevtoolsCommand =
    | { type: "refetch"; key: string }
    | { type: "invalidate"; key: string }
    | { type: "clear"; key: string }
    | { type: "clear-all" };

function preview(value: unknown): string {
    try {
        const json = JSON.stringify(value);
        if (json === undefined) return String(value);
        return json.length > 200 ? json.slice(0, 200) + "…" : json;
    } catch {
        return "[unserializable]";
    }
}

function inspectable(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "undefined") return "undefined";
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "symbol" || typeof value === "function") return String(value);
    if (value instanceof Date) return value.toISOString();
    if (depth >= 8) return "[Max depth]";
    if (seen.has(value)) return "[Circular]";

    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const items = value.slice(0, 50).map((item) => inspectable(item, depth + 1, seen));
            if (value.length > 50) items.push(`[… ${value.length - 50} more items]`);
            return items;
        }
        const output: Record<string, unknown> = {};
        const keys = Object.keys(value as Record<string, unknown>);
        for (const key of keys.slice(0, 50)) {
            try {
                output[key] = inspectable(
                    (value as Record<string, unknown>)[key],
                    depth + 1,
                    seen,
                );
            } catch {
                output[key] = "[Unreadable]";
            }
        }
        if (keys.length > 50) output["…"] = `${keys.length - 50} more keys`;
        return output;
    } finally {
        seen.delete(value);
    }
}

/** Builds a JSON-safe snapshot of the query/command internals. */
export function getQueryDevtoolsSnapshot(): QueryDevtoolsSnapshot {
    const queries = _debugQueryInternals();
    const commands = _debugCommandInternals();
    const now = Date.now();

    const commandKeys = new Set<string>([
        ...commands.queues.keys(),
        ...commands.latestControllers.keys(),
        ...commands.replayLocks,
    ]);

    return {
        cacheTime: queries.cacheTime,
        activeQueryCount: queries.activeQueryCount,
        inflight: Array.from(queries.inflight.keys()),
        cache: Array.from(queries.cache.entries()).map(([key, entry]) => ({
            key,
            fetchedAt: entry.fetchedAt,
            ageMs: now - entry.fetchedAt,
            subscribers: entry.subscribers,
            dataPreview: entry.data === undefined ? "(empty)" : preview(entry.data),
            data: inspectable(entry.data),
        })),
        commands: Array.from(commandKeys).map((key) => ({
            key,
            hasQueue: commands.queues.has(key),
            hasInflightLatest: commands.latestControllers.has(key),
            replayLocked: commands.replayLocks.has(key),
        })),
    };
}

export async function handleQueryDevtoolsCommand(command: QueryDevtoolsCommand): Promise<void> {
    if (command.type === "clear-all") {
        clearQueryCache();
        return;
    }
    if (command.type === "clear") {
        clearQueryCache(command.key);
        return;
    }
    if (command.type === "invalidate" || command.type === "refetch") {
        invalidateQueries(command.key);
        const prefix = `${command.key}::`;
        const matchingRequests = Array.from(_debugQueryInternals().inflight.entries())
            .filter(([key]) => key === command.key || key.startsWith(prefix))
            .map(([, request]) => request);
        await Promise.allSettled(matchingRequests);
    }
}

const descriptor = {
    id: "@elurjs/query",
    label: "Query",
    getSnapshot: getQueryDevtoolsSnapshot,
    onCommand: (command: unknown) => {
        if (!command || typeof command !== "object" || typeof (command as { type?: unknown }).type !== "string") {
            return;
        }
        return handleQueryDevtoolsCommand(command as QueryDevtoolsCommand);
    },
};

declare global {
    interface Window {
        __ELUR_DEVTOOLS_HOOK__?: {
            version: number;
            registerPlugin(plugin: {
                id: string;
                label?: string;
                getSnapshot?(): unknown;
                onCommand?(command: unknown): void | Promise<void>;
            }): () => void;
        };
        __ELUR_DEVTOOLS_PENDING_PLUGINS__?: Array<typeof descriptor>;
    }
}

if (typeof window !== "undefined") {
    const hook = window.__ELUR_DEVTOOLS_HOOK__;
    if (hook) hook.registerPlugin(descriptor);
    else (window.__ELUR_DEVTOOLS_PENDING_PLUGINS__ ??= []).push(descriptor);
}
