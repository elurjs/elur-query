# Nix Query

[![npm version](https://img.shields.io/npm/v/@deijose/nix-query.svg)](https://www.npmjs.com/package/@deijose/nix-query)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

CQRS-style data utilities for Nix.js.

- Queries (read): `createQuery`
- Commands (write): `createCommand`

## Installation

```bash
npm install @deijose/nix-js @deijose/nix-query
```

## Query Example

```ts
import { html, NixComponent } from "@deijose/nix-js";
import { createQuery } from "@deijose/nix-query";

class PostsPage extends NixComponent {
  private q = createQuery("posts", () => fetch("/api/posts").then((r) => r.json()));

  render() {
    return html`
      ${() => this.q.status.value === "pending" && html`<p>Loading...</p>`}
      ${() => this.q.status.value === "error" && html`<p>Error</p>`}
      ${() =>
        this.q.status.value === "success" &&
        html`<pre>${() => JSON.stringify(this.q.data.value, null, 2)}</pre>`}
    `;
  }
}

```

### Reactive Params (auto-refetch)

Pass `params` to derive the cache key from reactive signals. Read any signals
inside the function: whenever they change, the query recomputes its key and
refetches automatically. Each distinct params value is cached independently,
so revisiting previous params serves cached data instantly.

```ts
import { signal } from "@deijose/nix-js";
import { createQuery } from "@deijose/nix-query";

const search = signal("");
const page = signal(1);

const posts = createQuery(
  "posts",
  // The fetcher receives the current params.
  ({ q, page }) =>
    fetch(`/api/posts?q=${encodeURIComponent(q)}&page=${page}`).then((r) => r.json()),
  {
    params: () => ({ q: search.value, page: page.value }),
    staleTime: 30_000,
  }
);

// Changing any tracked signal triggers an automatic refetch under a new key.
search.value = "nix";
```

Notes:

- The effective cache key is `key::<stable-serialized-params>`; object key order
  does not matter.
- If params serialize to the same value, no refetch occurs (deduped).
- In-flight responses for stale params are ignored, preventing race conditions.
- `Map`, `Set`, and `Date` are supported in params and serialized deterministically.
- Circular references in params throw a `TypeError` instead of causing a stack overflow.

### Single-Flight Request Deduplication (v1.5)

When two or more components mount the same query key simultaneously with an
empty cache, only one fetch is fired. All subscribers share the same in-flight
promise.

```ts
// Both queries share a single network request on first mount.
const q1 = createQuery("users", () => fetch("/api/users").then((r) => r.json()));
const q2 = createQuery("users", () => fetch("/api/users").then((r) => r.json()));
// → only 1 fetch, both q1.data and q2.data resolve together.
```

### keepPreviousData / placeholderData (v1.5)

Prevent UI flicker when params change by keeping the previous data visible
while the new fetch is in progress:

```ts
const page = signal(1);

const q = createQuery(
  "posts",
  ({ page }) => fetch(`/api/posts?page=${page}`).then((r) => r.json()),
  {
    params: () => ({ page: page.value }),
    keepPreviousData: true, // old data stays visible during refetch
  }
);
```

Use `placeholderData` to show a fallback when no cached data exists yet:

```ts
const q = createQuery(
  "posts",
  () => fetch("/api/posts").then((r) => r.json()),
  {
    placeholderData: [], // shows [] while loading instead of undefined
  }
);

// placeholderData can also be a function receiving the previous data:
const q2 = createQuery(
  "posts",
  ({ page }) => fetch(`/api/posts?page=${page}`).then((r) => r.json()),
  {
    params: () => ({ page: page.value }),
    placeholderData: (prev) => (prev ? [...prev] : []),
  }
);
```

When both are set, `keepPreviousData` takes priority if previous data exists;
otherwise `placeholderData` is used.

### Custom serializeParams (v1.5)

Provide a custom serializer for params used to build the effective cache key.
Useful for exotic types, performance optimization, or hashed/encrypted keys:

```ts
const q = createQuery(
  "users",
  ({ id }) => fetch(`/api/users/${id}`).then((r) => r.json()),
  {
    params: () => ({ id: "abc" }),
    serializeParams: (params) => JSON.stringify(params), // custom impl
  }
);

// Use the same serializer for imperative cache access:
setQueryData("users", data, {
  params: { id: "abc" },
  serializeParams: (p) => JSON.stringify(p),
});
getQueryData("users", {
  params: { id: "abc" },
  serializeParams: (p) => JSON.stringify(p),
});
```

### dispose() (v1.5)

Both `createQuery` and `createCommand` return a `dispose()` method for explicit
cleanup. This removes global listeners, cancels in-flight requests, unregisters
from global registries, and stops param signal tracking:

```ts
const q = createQuery("users", () => fetch("/api/users").then((r) => r.json()));
q.dispose(); // query no longer reacts to invalidation or param changes

const cmd = createCommand("orders/create", async (payload) => { /* ... */ }, {
  mode: "queueOffline",
  offline: { adapter: myAdapter, replayOnReconnect: true },
});
cmd.dispose(); // removes the "online" event listener and cleans global state
```

`dispose()` is idempotent — calling it multiple times is safe.

### Cache Writes (v1.2)

```ts
import { getQueryData, setQueryData, updateQueryData } from "@deijose/nix-query";

const users = getQueryData<{ id: number; name: string }[]>("users/list");

setQueryData("users/list", [...(users ?? []), { id: 3, name: "Mia" }]);

updateQueryData("users/list", (current = []) =>
  current.map((u) => (u.id === 3 ? { ...u, name: "Mia V2" } : u))
);
```

## Command Example

```ts
import { createCommand } from "@deijose/nix-query";

const saveProfile = createCommand(
  "profile/save",
  async (payload: { name: string }, { signal }) => {
    const res = await fetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const err = new Error("Request failed") as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    return (await res.json()) as { ok: true };
  },
  {
    mode: "latest",
    dedupeWindowMs: 300,
    invalidate: ["profile", "posts"],
    retry: (failureCount, error) => {
      const status = (error as { status?: number })?.status;
      const isTransient = status === undefined || status >= 500 || status === 429;
      return isTransient && failureCount < 3;
    },
    retryDelay: (failureCount) => Math.min(500 * 2 ** (failureCount - 1), 5000),
  }
);

// fire-and-forget
saveProfile.execute({ name: "Deiver" });

// imperative flow
await saveProfile.executeAsync({ name: "Deiver" });
```

### Optimistic Rollback (v1.2)

```ts
import { createCommand, getQueryData, setQueryData } from "@deijose/nix-query";

type Item = { id: number; title: string };

const createItem = createCommand(
  "items/create",
  async (item: Item) => {
    // request real...
    throw new Error("failed");
  },
  {
    onMutate: (item) => {
      const previous = getQueryData<Item[]>("items/list") ?? [];
      setQueryData("items/list", [...previous, item]);
      return { previous };
    },
    onError: (_error, _item, context) => {
      setQueryData("items/list", context?.previous ?? []);
    },
  }
);
```

### Offline Queue via Adapter (v1.3 experimental)

`queueOffline` does not impose a storage engine. You must provide your own adapter.

```ts
import {
  CommandQueuedError,
  createCommand,
  type CommandQueueAdapter,
  type OfflineCommandEntry,
} from "@deijose/nix-query";

type CreateOrderInput = { id: string; total: number };

class LocalStorageQueueAdapter
  implements CommandQueueAdapter<CreateOrderInput> {
  private key = "nix-query:offline-commands";

  private read(): OfflineCommandEntry<CreateOrderInput>[] {
    const raw = localStorage.getItem(this.key);
    return raw ? JSON.parse(raw) : [];
  }

  private write(items: OfflineCommandEntry<CreateOrderInput>[]) {
    localStorage.setItem(this.key, JSON.stringify(items));
  }

  enqueue(entry: OfflineCommandEntry<CreateOrderInput>) {
    this.write([...this.read(), entry]);
  }

  list(commandKey?: string) {
    const all = this.read();
    return commandKey ? all.filter((i) => i.commandKey === commandKey) : all;
  }

  update(entry: OfflineCommandEntry<CreateOrderInput>) {
    this.write(this.read().map((i) => (i.id === entry.id ? entry : i)));
  }

  remove(id: string) {
    this.write(this.read().filter((i) => i.id !== id));
  }
}

const createOrder = createCommand(
  "orders/create",
  async (payload: CreateOrderInput, { signal }) => {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      throw new Error("order create failed");
    }

    return (await res.json()) as { ok: true };
  },
  {
    mode: "queueOffline",
    offline: {
      adapter: new LocalStorageQueueAdapter(),
      isOnline: () => navigator.onLine,
      replayOnReconnect: true,
      maxReplayAttempts: 5,
    },
  }
);

try {
  await createOrder.executeAsync({ id: "A-100", total: 42 });
} catch (error) {
  if (error instanceof CommandQueuedError) {
    // queued successfully, replay will happen later
  }
}

// Manual controls
await createOrder.replayQueue();
await createOrder.clearQueue();
```

Recommended for v1.3:

- Ensure server-side idempotency (request IDs or idempotency keys).
- Keep payloads serializable (no class instances/functions).
- Define replay policy per command (max retries, ordering, conflict strategy).

## API

### Query

- `createQuery(key, asyncFn, options?)`
- `invalidateQueries(key)`
- `clearQueryCache(key?)`
- `setQueryCacheTime(ms)`
- `getQueryData(key, options?)`
- `setQueryData(key, value, options?)`
- `updateQueryData(key, updater, options?)`

`createQuery` return shape:

- Signals: `status`, `data`, `error`
- Properties: `key` (effective cache key)
- Methods: `refetch()`, `dispose()` (v1.5)

Query options:

- `staleTime`: ms while cached data is considered fresh (default `0`)
- `refetchOnMount`: `"always" | "stale" | false` (default `"always"`)
- `params`: reactive params function `() => P`
- `serializeParams`: custom serializer `(params: unknown) => string` (v1.5)
- `keepPreviousData`: retain previous data during refetch (v1.5)
- `placeholderData`: static value or `(previousData) => value` shown while
  pending (v1.5)

### Command (v1.3)

- `createCommand(commandKey, executeFn, options?)`

`createCommand` return shape:

- Signals: `status`, `data`, `error`, `variables`, `failureCount`, `inFlight`, `queuedCount`
- Computed signals: `isIdle`, `isPending`, `isSuccess`, `isError`, `isQueued`
- Methods: `execute`, `executeAsync`, `reset`, `cancel`, `replayQueue`,
  `clearQueue`, `dispose` (v1.5)

Command options:

- `mode`: `"latest" | "queue" | "parallel" | "queueOffline"`
- `dedupeWindowMs`: anti double-tap window
- `serializeByKey`: serialize `queue/latest` by command key across instances
- `retry`: number or function `(failureCount, error) => boolean`
- `retryDelay`: number or function `(failureCount, error) => ms`
- `invalidate`: query keys to invalidate on successful command
- `onMutate`, `onSuccess`, `onError`, `onSettled`
- `offline` (v1.3 experimental):
  - `adapter`: custom queue adapter (required in `queueOffline`)
  - `isOnline`: custom online detector
  - `replayOnReconnect`: auto-replay when browser emits `online`
  - `maxReplayAttempts`: cap replay attempts before pausing item
  - `shouldEnqueue`: enqueue after failed execution based on error policy
  - `onEnqueue`, `onReplaySuccess`, `onReplayError`

Queue adapter contract:

```ts
interface CommandQueueAdapter<TVariables> {
  enqueue(entry: OfflineCommandEntry<TVariables>): Promise<void> | void;
  list(commandKey?: string): Promise<OfflineCommandEntry<TVariables>[]> | OfflineCommandEntry<TVariables>[];
  update(entry: OfflineCommandEntry<TVariables>): Promise<void> | void;
  remove(id: string): Promise<void> | void;
}
```

## Conventions

- Use query keys by bounded context (`"events/list"`, `"profile/current"`, etc.).
- Use command keys by action (`"events/create"`, `"profile/save"`, etc.).

## Next Plan

The roadmap is documented in [PROXIMOS_PASOS.md](./PROXIMOS_PASOS.md).

## License

MIT
