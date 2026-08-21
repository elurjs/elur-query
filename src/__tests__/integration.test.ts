/**
 * Real-world integration Tests
 *
 * Simulates a full application scenario: a dashboard with multiple widgets
 * sharing the same query, paginated lists with keepPreviousData, a mutation
 * command with offline support, and complex params (Map/Set/Date).
 *
 * These tests exercise all four fixes together, the way a real app would.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { html, mount, NixComponent, signal, batch } from "@deijose/nix-js";
import {
    createQuery,
    createCommand,
    clearQueryCache,
    invalidateQueries,
    getQueryData,
    setQueryData,
    CommandQueuedError,
    type CommandQueueAdapter,
} from "../index";

// ─── Shared mock API ──────────────────────────────────────────────────────────

type MockFn<T extends (...args: never[]) => unknown> = ReturnType<typeof vi.fn<T>>;

interface UserListResult {
    users: Array<{ id: number; name: string }>;
    total: number;
}
interface UserDetailResult { id: number; name: string; email: string }
interface EventsResult { count: number; dateISO: string; events: string[] }
interface ProfileResult { ok: boolean; name: string }
interface OrderResult { ok: boolean; orderId: string }

interface MockApi {
    fetchUsers: MockFn<(params: { page: number; filter: string }) => Promise<UserListResult>>;
    fetchUserDetail: MockFn<(id: number) => Promise<UserDetailResult>>;
    fetchEvents: MockFn<(params: { date: Date; tags: Set<string> }) => Promise<EventsResult>>;
    saveProfile: MockFn<(payload: { name: string }) => Promise<ProfileResult>>;
    createOrder: MockFn<(payload: { id: string; total: number }) => Promise<OrderResult>>;
}

function createMockApi(): MockApi {
    return {
        fetchUsers: vi.fn<(params: { page: number; filter: string }) => Promise<UserListResult>>(
            async (_params) => {
                await new Promise((r) => setTimeout(r, 15));
                return {
                    users: Array.from({ length: 5 }, (_, i) => ({
                        id: _params.page * 100 + i,
                        name: `User ${_params.page * 100 + i}`,
                    })),
                    total: 50,
                };
            }
        ),
        fetchUserDetail: vi.fn<(id: number) => Promise<UserDetailResult>>(
            async (id) => {
                await new Promise((r) => setTimeout(r, 10));
                return { id, name: `User ${id}`, email: `user${id}@test.com` };
            }
        ),
        fetchEvents: vi.fn<(params: { date: Date; tags: Set<string> }) => Promise<EventsResult>>(
            async (params) => {
                await new Promise((r) => setTimeout(r, 12));
                return {
                    count: params.tags.size,
                    dateISO: params.date.toISOString(),
                    events: [`event-${params.date.getTime()}-${params.tags.size}`],
                };
            }
        ),
        saveProfile: vi.fn<(payload: { name: string }) => Promise<ProfileResult>>(
            async (payload) => {
                await new Promise((r) => setTimeout(r, 10));
                return { ok: true, ...payload };
            }
        ),
        createOrder: vi.fn<(payload: { id: string; total: number }) => Promise<OrderResult>>(
            async (payload) => {
                await new Promise((r) => setTimeout(r, 10));
                return { ok: true, orderId: payload.id };
            }
        ),
    };
}

function createMemoryAdapter<T>(): CommandQueueAdapter<T> {
    let items: Array<{
        id: string;
        commandKey: string;
        variables: T;
        attempts: number;
        createdAt: number;
        lastError?: string;
    }> = [];
    return {
        enqueue(entry) { items.push(entry); },
        list(commandKey) { return commandKey ? items.filter((i) => i.commandKey === commandKey) : [...items]; },
        update(entry) { items = items.map((i) => (i.id === entry.id ? entry : i)); },
        remove(id) { items = items.filter((i) => i.id !== id); },
    };
}

// ─── Integration Scenarios ───────────────────────────────────────────────────

describe("Real-World Integration", () => {
    let api: MockApi;

    beforeEach(() => {
        clearQueryCache();
        api = createMockApi();
    });

    it("Scenario A: Dashboard with 5 widgets sharing the same user query (single-flight)", async () => {
        // 5 different components all need the same user list.
        // Without single-flight, this would fire 5 API calls.
        // With single-flight, only 1 call is made.

        class UserWidget extends NixComponent {
            private q = createQuery(
                "dashboard/users",
                () => api.fetchUsers({ page: 1, filter: "all" }),
                { refetchOnMount: false }
            );

            render() {
                return html`
                    <div class="widget">
                        ${() =>
                        this.q.status.value === "success"
                            ? html`
                                <span class="count">${this.q.data.value!.users.length}</span>
                            `
                            : html`
                                <span class="loading">...</span>
                            `}
                    </div>
                `;
            }
        }

        const widgets = Array.from({ length: 5 }, () => {
            const el = document.createElement("div");
            mount(new UserWidget(), el);
            return el;
        });

        // While loading, all show loading state.
        expect(widgets.every((el) => el.querySelector(".loading"))).toBe(true);

        await new Promise((r) => setTimeout(r, 25));

        // All widgets show the same data.
        expect(widgets.every((el) => el.querySelector(".count")?.textContent === "5")).toBe(true);

        // CRITICAL: only ONE API call was made for all 5 widgets.
        expect(api.fetchUsers).toHaveBeenCalledTimes(1);
    });

    it("Scenario B: Paginated table with keepPreviousData — no flicker on page change", async () => {
        const page = signal(1);
        let renderLog: string[] = [];

        class PaginatedTable extends NixComponent {
            private q = createQuery(
                "table/users",
                () => api.fetchUsers({ page: page.value, filter: "all" }),
                {
                    params: () => ({ page: page.value, filter: "all" }),
                    keepPreviousData: true,
                }
            );

            render() {
                return html`
                    <table>
                        <tbody>
                            ${() => {
                        const data = this.q.data.value;
                        const status = this.q.status.value;
                        renderLog.push(`${status}:${data?.users?.[0]?.id ?? "none"}:${data?.users?.length ?? 0}`);
                        return data?.users
                            ? data.users.map(
                                (u) => html`
                                            <tr>
                                                <td class="uid">
                                                    ${u.id}
                                                </td>
                                                <td>
                                                    ${u.name}
                                                </td>
                                            </tr>
                                        `
                            )
                            : html`
                                        <tr>
                                            <td colspan="2">
                                                empty
                                            </td>
                                        </tr>
                                    `;
                    }}
                        </tbody>
                    </table>
                `;
            }
        }

        const el = document.createElement("div");
        mount(new PaginatedTable(), el);

        await new Promise((r) => setTimeout(r, 25));
        expect(el.querySelectorAll(".uid").length).toBe(5);
        expect(el.querySelector(".uid")!.textContent!.trim()).toBe("100");

        // Change to page 2.
        page.value = 2;

        // While fetching page 2, page 1 data should still be visible (no flicker).
        await Promise.resolve();
        await Promise.resolve();
        expect(el.querySelectorAll(".uid").length).toBe(5);
        expect(el.querySelector(".uid")!.textContent!.trim()).toBe("100"); // still page 1

        await new Promise((r) => setTimeout(r, 25));

        // Now page 2 data is shown.
        expect(el.querySelectorAll(".uid").length).toBe(5);
        expect(el.querySelector(".uid")!.textContent!.trim()).toBe("200");

        // Verify the render log shows no "empty" state between page changes.
        // The initial mount may show "none" once (no previous data), but after
        // the first successful load, there should be zero empty renders.
        const firstSuccessIdx = renderLog.findIndex((r) => r.startsWith("success:"));
        const rendersAfterFirstLoad = renderLog.slice(firstSuccessIdx + 1);
        const emptyRenders = rendersAfterFirstLoad.filter((r) => r.includes("none"));
        expect(emptyRenders.length).toBe(0); // No flicker — data was always present
    });

    it("Scenario C: Offline order creation with auto-replay on reconnect", async () => {
        const adapter = createMemoryAdapter<{ id: string; total: number }>();
        let online = false;

        const createOrder = createCommand(
            "orders/create",
            (payload: { id: string; total: number }) => api.createOrder(payload),
            {
                mode: "queueOffline",
                offline: {
                    adapter,
                    replayOnReconnect: true,
                    isOnline: () => online,
                },
            }
        );

        // User is offline — create 3 orders.
        online = false;
        for (let i = 1; i <= 3; i++) {
            await expect(createOrder.executeAsync({ id: `ORD-${i}`, total: i * 10 }))
                .rejects.toBeInstanceOf(CommandQueuedError);
        }

        expect(createOrder.queuedCount.value).toBe(3);
        expect(api.createOrder).not.toHaveBeenCalled();

        // User comes back online — dispatch 'online' event to trigger replay.
        online = true;
        window.dispatchEvent(new Event("online"));

        // Wait for replay to complete.
        await new Promise((r) => setTimeout(r, 80));

        expect(api.createOrder).toHaveBeenCalledTimes(3);
        expect(createOrder.queuedCount.value).toBe(0);

        // Clean up.
        createOrder.dispose();
    });

    it("Scenario D: Complex params with Map, Set, and Date in event filter", async () => {
        const filterDate = new Date("2024-06-15T10:00:00Z");
        const tags = signal(new Set(["urgent", "production"]));

        const q = createQuery(
            "events/filtered",
            (params: { date: Date; tags: Set<string> }) =>
                api.fetchEvents({ date: params.date, tags: params.tags }),
            {
                params: () => ({ date: filterDate, tags: tags.value }),
                staleTime: Infinity,
            }
        );

        await new Promise((r) => setTimeout(r, 20));
        expect(q.data.value).toEqual({
            count: 2,
            dateISO: "2024-06-15T10:00:00.000Z",
            events: [`event-${filterDate.getTime()}-2`],
        });

        // Add a tag — should refetch.
        tags.value = new Set(["urgent", "production", "critical"]);
        await new Promise((r) => setTimeout(r, 20));
        expect(q.data.value!.count).toBe(3);

        // Remove back to 2 tags — should refetch and use cache from before? No,
        // this is a new Set object, but same content as the first. Let's verify
        // it refetches because the serialized key is different (3 vs 2 tags).
        // Actually, going back to 2 tags should hit the cache from the first fetch.
        tags.value = new Set(["urgent", "production"]);
        await new Promise((r) => setTimeout(r, 20));
        expect(q.data.value!.count).toBe(2);
        expect(api.fetchEvents).toHaveBeenCalledTimes(2); // initial + 3-tag, not the 2-tag revisit
    });

    it("Scenario E: Mutation with optimistic update + invalidation + single-flight refetch", async () => {
        // Set up a query that multiple components share.
        let queryFetchCount = 0;
        const q1 = createQuery(
            "items/list",
            async () => {
                queryFetchCount++;
                await new Promise((r) => setTimeout(r, 10));
                return [{ id: 1, title: "Original" }];
            },
            { refetchOnMount: false }
        );
        const q2 = createQuery(
            "items/list",
            async () => {
                queryFetchCount++;
                await new Promise((r) => setTimeout(r, 10));
                return [{ id: 1, title: "Original" }];
            },
            { refetchOnMount: false }
        );

        await new Promise((r) => setTimeout(r, 20));
        expect(queryFetchCount).toBe(1); // single-flight: only 1 fetch for both
        expect(q1.data.value).toEqual([{ id: 1, title: "Original" }]);
        expect(q2.data.value).toEqual([{ id: 1, title: "Original" }]);

        // Create a mutation with optimistic update.
        const addItem = createCommand(
            "items/create",
            async (item: { id: number; title: string }) => {
                await new Promise((r) => setTimeout(r, 10));
                return item;
            },
            {
                onMutate: (item) => {
                    const previous = getQueryData<{ id: number; title: string }[]>("items/list") ?? [];
                    setQueryData("items/list", [...previous, item]);
                    return { previous };
                },
                onSuccess: () => {
                    invalidateQueries("items/list");
                },
                onError: (_err, _vars, ctx) => {
                    setQueryData("items/list", ctx?.previous ?? []);
                },
            }
        );

        // Execute mutation — optimistic update appears immediately.
        const promise = addItem.executeAsync({ id: 2, title: "New Item" });
        await Promise.resolve();

        // Optimistic data visible in both queries immediately.
        expect(q1.data.value!.length).toBe(2);
        expect(q2.data.value!.length).toBe(2);

        await promise;
        await new Promise((r) => setTimeout(r, 20));

        // After invalidation, both queries refetch — but single-flight means only 1 new fetch.
        const fetchesAfterMutation = queryFetchCount - 1;
        expect(fetchesAfterMutation).toBe(1); // single-flight dedup on refetch
    });

    it("Scenario F: Rapid param changes — only the latest param's data is shown", async () => {
        const search = signal("a");
        const resolvers: Record<string, (v: string) => void> = {};

        const q = createQuery<string, { q: string }>(
            "search/live",
            ({ q }) =>
                new Promise<string>((resolve) => {
                    resolvers[q] = resolve;
                }),
            {
                params: () => ({ q: search.value }),
                keepPreviousData: true,
            }
        );

        // Start with "a"
        await Promise.resolve();
        await Promise.resolve();

        // Rapidly change through b, c, d
        search.value = "b";
        await Promise.resolve();
        search.value = "c";
        await Promise.resolve();
        search.value = "d";
        await Promise.resolve();

        // Resolve in order: a, b, c, d
        resolvers["a"]("result-a");
        resolvers["b"]("result-b");
        resolvers["c"]("result-c");
        resolvers["d"]("result-d");

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Only the latest param ("d") should be in the data signal.
        expect(q.data.value).toBe("result-d");
    });

    it("Scenario G: Batch param updates — no intermediate refetches", async () => {
        const a = signal(1);
        const b = signal(2);
        let calls = 0;

        createQuery<number, { sum: number; product: number }>(
            "batch/params",
            async (p) => {
                calls++;
                await new Promise((r) => setTimeout(r, 10));
                return p.sum + p.product;
            },
            {
                params: () => ({ sum: a.value + b.value, product: a.value * b.value }),
            }
        );

        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toBe(1);

        // Batch update: a and b change atomically.
        // a=3, b=1 → sum=4, product=3 (different from sum=3, product=2)
        batch(() => {
            a.value = 3;
            b.value = 1;
        });

        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toBe(2); // only one refetch for the batched change
    });

    it("Scenario H: Full lifecycle — mount, fetch, mutate, invalidate, dispose", async () => {
        let fetchCalls = 0;

        class FeatureComponent extends NixComponent {
            q = createQuery(
                "lifecycle/data",
                async () => {
                    const myCall = ++fetchCalls;
                    await new Promise((r) => setTimeout(r, 10));
                    return { count: myCall };
                },
                { refetchOnMount: false }
            );

            cmd = createCommand(
                "lifecycle/mutate",
                async (v: number) => {
                    await new Promise((r) => setTimeout(r, 5));
                    return v;
                },
                { invalidate: ["lifecycle/data"] }
            );

            render() {
                return html`
                    <div>
                        <span class="val">
                        ${() => this.q.data.value?.count ?? "loading"}
                        </span>
                    </div>
                `;
            }
        }

        const el = document.createElement("div");
        const comp = new FeatureComponent();
        mount(comp, el);

        await new Promise((r) => setTimeout(r, 20));
        expect(el.querySelector(".val")!.textContent!.trim()).toBe("1");
        expect(fetchCalls).toBe(1);

        // Trigger mutation directly (avoids onclick binding evaluation issues).
        comp.cmd.execute(1);
        await new Promise((r) => setTimeout(r, 20));

        // Invalidation caused a refetch.
        expect(fetchCalls).toBe(2);
        expect(el.querySelector(".val")!.textContent!.trim()).toBe("2");
    });

    it("Scenario I: Custom serializer for encrypted param keys", async () => {
        // Simulate an app that uses hashed/encoded param keys.
        const customSerializer = (params: unknown): string => {
            const json = JSON.stringify(params);
            // Simple "hash" for testing — just reverse the string.
            return json.split("").reverse().join("");
        };

        const id = signal("user-123");

        const q = createQuery<string, { id: string }>(
            "custom-serial/user",
            async ({ id }) => `data:${id}`,
            {
                params: () => ({ id: id.value }),
                serializeParams: customSerializer,
            }
        );

        await new Promise((r) => setTimeout(r, 15));
        expect(q.data.value).toBe("data:user-123");

        // Imperative cache access with same serializer.
        setQueryData("custom-serial/user", "manual", {
            params: { id: "user-123" },
            serializeParams: customSerializer,
        });
        expect(q.data.value).toBe("manual");
    });

    it("Scenario J: Memory cleanup — dispose all queries and commands, verify no leaks", async () => {
        const addSpy = vi.spyOn(window, "addEventListener");
        const removeSpy = vi.spyOn(window, "removeEventListener");

        const queries: ReturnType<typeof createQuery>[] = [];
        const commands: ReturnType<typeof createCommand>[] = [];

        // Create 10 queries and 5 offline commands.
        for (let i = 0; i < 10; i++) {
            queries.push(
                createQuery(`cleanup/q${i}`, async () => i, { refetchOnMount: false })
            );
        }
        for (let i = 0; i < 5; i++) {
            commands.push(
                createCommand(
                    `cleanup/c${i}`,
                    async (v: number) => v,
                    {
                        mode: "queueOffline",
                        offline: {
                            adapter: createMemoryAdapter(),
                            replayOnReconnect: true,
                            isOnline: () => false,
                        },
                    }
                )
            );
        }

        const onlineListenersAdded = addSpy.mock.calls.filter(([e]) => e === "online").length;
        expect(onlineListenersAdded).toBe(5);

        // Wait for all fetches to resolve before disposing.
        await new Promise((r) => setTimeout(r, 20));
        for (let i = 0; i < 10; i++) {
            expect(queries[i].data.value).toBe(i);
        }

        // Dispose everything.
        queries.forEach((q) => q.dispose());
        commands.forEach((c) => c.dispose());

        const onlineListenersRemoved = removeSpy.mock.calls.filter(([e]) => e === "online").length;
        expect(onlineListenersRemoved).toBe(5);

        // Verify queries are no longer in the registry by invalidating.
        // If they were still registered, they'd refetch.
        for (let i = 0; i < 10; i++) {
            invalidateQueries(`cleanup/q${i}`);
        }
        await new Promise((r) => setTimeout(r, 20));

        // Data should not have changed (queries were disposed, no refetch).
        for (let i = 0; i < 10; i++) {
            expect(queries[i].data.value).toBe(i);
        }

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });
});
