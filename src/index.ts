// Public API — explicit exports to avoid leaking internal _debug* helpers.
// The _debugQueryInternals and _debugCommandInternals functions are only
// consumed by ./devtools.ts (which imports them directly from the source
// files) and must not be part of the public package surface.

export type { QueryStatus } from "./query.js";
export type { QueryResult, QueryOptions, QueryCacheOptions } from "./query.js";
export {
    clearQueryCache,
    setQueryCacheTime,
    getQueryData,
    setQueryData,
    updateQueryData,
    invalidateQueries,
    createQuery,
} from "./query.js";

export type {
    CommandStatus,
    CommandMode,
    CommandContext,
    RetryPolicy,
    RetryDelayPolicy,
    OfflineCommandEntry,
    CommandQueueAdapter,
    OfflineQueueOptions,
    CommandOptions,
    CommandResult,
} from "./command.js";
export { CommandQueuedError, createCommand } from "./command.js";
