import { describe, it, expect, vi, beforeEach } from "vitest";
import { html, mount, ElurComponent, signal } from "@elurjs/core";
import {
    createQuery,
    createCommand,
    clearQueryCache,
    invalidateQueries,
    getQueryData,
    setQueryData,
    type CommandQueueAdapter,
} from "../index";

describe("Fix #1: Single-Flight Request Deduplication", () => {
    beforeEach(() => clearQueryCache());

    it("fires the fetcher only once when two queries mount the same key simultaneously", async () => {
        let fetchCalls = 0;
        const fetcher = vi.fn(async () => {
            fetchCalls++;
            await new Promise((r) => setTimeout(r, 20));
            return { hello: "world" };
        });

        const q1 = createQuery("sf/same-key", fetcher);
        const q2 = createQuery("sf/same-key", fetcher);

        await new Promise((r) => setTimeout(r, 30));

        expect(fetchCalls).toBe(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(q1.data.value).toEqual({ hello: "world" });
        expect(q2.data.value).toEqual({ hello: "world" });
        expect(q1.status.value).toBe("success");
        expect(q2.status.value).toBe("success");
    });

    it("dedupes across many simultaneous subscribers", async () => {
        let calls = 0;
        const fetcher = async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 15));
            return calls;
        };

        const queries = Array.from({ length: 10 }, () =>
            createQuery("sf/multi", fetcher)
        );

        await new Promise((r) => setTimeout(r, 25));

        expect(calls).toBe(1);
        for (const q of queries) {
            expect(q.data.value).toBe(1);
        }
    });

    it("fires separate fetches for different keys", async () => {
        let callsA = 0;
        let callsB = 0;

        createQuery("sf/key-a", async () => {
            callsA++;
            await new Promise((r) => setTimeout(r, 10));
            return "a";
        });
        createQuery("sf/key-b", async () => {
            callsB++;
            await new Promise((r) => setTimeout(r, 10));
            return "b";
        });

        await new Promise((r) => setTimeout(r, 20));

        expect(callsA).toBe(1);
        expect(callsB).toBe(1);
    });

    it("refetch bypasses single-flight and starts a new request", async () => {
        let calls = 0;
        const q = createQuery("sf/refetch", async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 10));
            return calls;
        });

        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toBe(1);

        q.refetch();
        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toBe(2);
    });

    it("invalidateQueries clears in-flight so next fetch is fresh", async () => {
        let calls = 0;
        let resolveFirst!: () => void;
        const firstPromise = new Promise<void>((r) => (resolveFirst = r));

        const q = createQuery("sf/invalidate", async () => {
            calls++;
            if (calls === 1) {
                await firstPromise;
            }
            return calls;
        });

        await new Promise((r) => setTimeout(r, 5));
        invalidateQueries("sf/invalidate");
        resolveFirst();

        await new Promise((r) => setTimeout(r, 20));

        expect(calls).toBeGreaterThanOrEqual(2);
        expect(q.data.value).toBe(calls);
    });

    it("shares in-flight promise with param-scoped queries", async () => {
        let calls = 0;
        const id = signal(1);

        const fetcher = async ({ id }: { id: number }) => {
            calls++;
            await new Promise((r) => setTimeout(r, 15));
            return `user-${id}`;
        };

        const q1 = createQuery("sf/params", fetcher, {
            params: () => ({ id: id.value }),
        });
        const q2 = createQuery("sf/params", fetcher, {
            params: () => ({ id: id.value }),
        });

        await new Promise((r) => setTimeout(r, 25));

        expect(calls).toBe(1);
        expect(q1.data.value).toBe("user-1");
        expect(q2.data.value).toBe("user-1");
    });
});

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

describe("Fix #2: Memory Leak — dispose() and listener cleanup", () => {
    it("createQuery.dispose() removes from global registries", async () => {
        const q = createQuery("dispose/q", async () => 42);
        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe(42);

        q.dispose();

        invalidateQueries("dispose/q");
        await new Promise((r) => setTimeout(r, 10));

        expect(q.data.value).toBe(42);
    });

    it("createQuery.dispose() is idempotent", async () => {
        const q = createQuery("dispose/idempotent", async () => 1);
        await new Promise((r) => setTimeout(r, 10));

        q.dispose();
        q.dispose(); // should not throw
        q.dispose();
    });

    it("createQuery.dispose() stops param signal tracking", async () => {
        const id = signal(1);
        let calls = 0;

        const q = createQuery<number, { id: number }>(
            "dispose/params",
            async ({ id }) => {
                calls++;
                await new Promise((r) => setTimeout(r, 10));
                return id * 10;
            },
            { params: () => ({ id: id.value }) }
        );

        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toBe(1);
        expect(q.data.value).toBe(10);

        q.dispose();

        id.value = 2;
        await new Promise((r) => setTimeout(r, 20));

        expect(calls).toBe(1);
    });

    it("createCommand.dispose() removes the online event listener", async () => {
        const addSpy = vi.spyOn(window, "addEventListener");
        const removeSpy = vi.spyOn(window, "removeEventListener");

        const cmd = createCommand(
            "dispose/cmd-offline",
            async (payload: { id: number }) => payload.id,
            {
                mode: "queueOffline",
                offline: {
                    adapter: createMemoryAdapter(),
                    replayOnReconnect: true,
                    isOnline: () => false,
                },
            }
        );

        const onlineCalls = addSpy.mock.calls.filter(([event]) => event === "online");
        expect(onlineCalls.length).toBe(1);

        cmd.dispose();

        const removeOnlineCalls = removeSpy.mock.calls.filter(([event]) => event === "online");
        expect(removeOnlineCalls.length).toBe(1);

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });

    it("createCommand.dispose() cancels in-flight and cleans global state", async () => {
        let aborted = false;
        const cmd = createCommand(
            "dispose/cmd-latest",
            async (_v: number, { signal }) => {
                return new Promise<number>((_resolve, reject) => {
                    signal.addEventListener("abort", () => {
                        aborted = true;
                        const err = new Error("aborted") as Error & { name: string };
                        err.name = "AbortError";
                        reject(err);
                    }, { once: true });
                });
            },
            { mode: "latest" }
        );

        cmd.execute(1);
        await new Promise((r) => setTimeout(r, 5));

        cmd.dispose();

        await new Promise((r) => setTimeout(r, 5));
        expect(aborted).toBe(true);
    });

    it("createCommand.dispose() is idempotent", () => {
        const cmd = createCommand(
            "dispose/cmd-idempotent",
            async () => "ok",
            {
                mode: "queueOffline",
                offline: {
                    adapter: createMemoryAdapter(),
                    isOnline: () => true,
                },
            }
        );

        cmd.dispose();
        cmd.dispose();
        cmd.dispose();
    });

    it("multiple queueOffline commands each clean their own listener", async () => {
        const addSpy = vi.spyOn(window, "addEventListener");
        const removeSpy = vi.spyOn(window, "removeEventListener");

        const cmd1 = createCommand(
            "dispose/multi-1",
            async (v: number) => v,
            {
                mode: "queueOffline",
                offline: { adapter: createMemoryAdapter(), isOnline: () => false },
            }
        );
        const cmd2 = createCommand(
            "dispose/multi-2",
            async (v: number) => v,
            {
                mode: "queueOffline",
                offline: { adapter: createMemoryAdapter(), isOnline: () => false },
            }
        );

        const onlineAdds = addSpy.mock.calls.filter(([e]) => e === "online");
        expect(onlineAdds.length).toBe(2);

        cmd1.dispose();
        const removesAfter1 = removeSpy.mock.calls.filter(([e]) => e === "online");
        expect(removesAfter1.length).toBe(1);

        cmd2.dispose();
        const removesAfter2 = removeSpy.mock.calls.filter(([e]) => e === "online");
        expect(removesAfter2.length).toBe(2);

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });
});

describe("Fix #3: keepPreviousData / placeholderData", () => {
    beforeEach(() => clearQueryCache());

    it("keepPreviousData retains old data while fetching new params", async () => {
        const page = signal(1);
        let calls = 0;

        const q = createQuery<string[], { page: number }>(
            "kp/paginated",
            async ({ page }) => {
                calls++;
                await new Promise((r) => setTimeout(r, 20));
                return [`item-${page}-1`, `item-${page}-2`];
            },
            {
                params: () => ({ page: page.value }),
                keepPreviousData: true,
            }
        );

        await new Promise((r) => setTimeout(r, 30));
        expect(q.data.value).toEqual(["item-1-1", "item-1-2"]);
        expect(q.status.value).toBe("success");

        page.value = 2;
        await Promise.resolve(); // let effect fire

        expect(q.status.value).toBe("pending");
        expect(q.data.value).toEqual(["item-1-1", "item-1-2"]);

        await new Promise((r) => setTimeout(r, 30));
        expect(q.status.value).toBe("success");
        expect(q.data.value).toEqual(["item-2-1", "item-2-2"]);
    });

    it("without keepPreviousData, data is cleared on param change (flicker)", async () => {
        const page = signal(1);

        const q = createQuery<string[], { page: number }>(
            "kp/no-keep",
            async ({ page }) => {
                await new Promise((r) => setTimeout(r, 20));
                return [`item-${page}`];
            },
            {
                params: () => ({ page: page.value }),
            }
        );

        await new Promise((r) => setTimeout(r, 30));
        expect(q.data.value).toEqual(["item-1"]);

        page.value = 2;
        await Promise.resolve();

        expect(q.status.value).toBe("pending");
        expect(q.data.value).toBeUndefined();
    });

    it("placeholderData shows static value while pending", async () => {
        const q = createQuery<string[]>(
            "ph/static",
            async () => {
                await new Promise((r) => setTimeout(r, 20));
                return ["real"];
            },
            { placeholderData: ["loading..."] }
        );

        expect(q.data.value).toEqual(["loading..."]);
        expect(q.status.value).toBe("pending");

        await new Promise((r) => setTimeout(r, 30));
        expect(q.data.value).toEqual(["real"]);
        expect(q.status.value).toBe("success");
    });

    it("placeholderData as function receives previous data", async () => {
        const page = signal(1);

        const q = createQuery<string[], { page: number }>(
            "ph/func",
            async ({ page }) => {
                await new Promise((r) => setTimeout(r, 20));
                return [`real-${page}`];
            },
            {
                params: () => ({ page: page.value }),
                placeholderData: (prev) => (prev ? [...prev, "placeholder"] : ["init-placeholder"]),
            }
        );

        expect(q.data.value).toEqual(["init-placeholder"]);

        await new Promise((r) => setTimeout(r, 30));
        expect(q.data.value).toEqual(["real-1"]);

        page.value = 2;
        await Promise.resolve();
        expect(q.data.value).toEqual(["real-1", "placeholder"]);

        await new Promise((r) => setTimeout(r, 30));
        expect(q.data.value).toEqual(["real-2"]);
    });

    it("keepPreviousData + placeholderData: keepPreviousData takes priority when previous data exists", async () => {
        const page = signal(1);

        const q = createQuery<string[], { page: number }>(
            "kp+ph/priority",
            async ({ page }) => {
                await new Promise((r) => setTimeout(r, 20));
                return [`real-${page}`];
            },
            {
                params: () => ({ page: page.value }),
                keepPreviousData: true,
                placeholderData: ["fallback-placeholder"],
            }
        );

        expect(q.data.value).toEqual(["fallback-placeholder"]);

        await new Promise((r) => setTimeout(r, 30));
        expect(q.data.value).toEqual(["real-1"]);

        page.value = 2;
        await Promise.resolve();
        expect(q.data.value).toEqual(["real-1"]); // previous data, not placeholder

        await new Promise((r) => setTimeout(r, 30));
        expect(q.data.value).toEqual(["real-2"]);
    });

    it("keepPreviousData works with real DOM rendering (no flicker)", async () => {
        const page = signal(1);

        class PaginatedList extends ElurComponent {
            private q = createQuery<string[], { page: number }>(
                "kp/dom",
                async ({ page }) => {
                    await new Promise((r) => setTimeout(r, 20));
                    return [`row-${page}-a`, `row-${page}-b`];
                },
                {
                    params: () => ({ page: page.value }),
                    keepPreviousData: true,
                }
            );

            render() {
                return html`
                    <ul class="list">
                        ${() =>
                        this.q.data.value
                            ? this.q.data.value.map((item) => html`
                                <li>
                                    ${item}
                                </li>
                            `)
                            : ""}
                    </ul>
                `;
            }
        }

        const el = document.createElement("div");
        mount(new PaginatedList(), el);

        await new Promise((r) => setTimeout(r, 30));
        expect(el.querySelectorAll("li").length).toBe(2);
        expect(el.querySelector("li")!.textContent!.trim()).toBe("row-1-a");

        page.value = 2;
        await Promise.resolve();

        expect(el.querySelectorAll("li").length).toBe(2);
        expect(el.querySelector("li")!.textContent!.trim()).toBe("row-1-a");

        await new Promise((r) => setTimeout(r, 30));
        expect(el.querySelectorAll("li").length).toBe(2);
        expect(el.querySelector("li")!.textContent!.trim()).toBe("row-2-a");
    });
});

describe("Fix #4: Robust _stableStringify", () => {
    beforeEach(() => clearQueryCache());

    it("handles Map in params without data loss", async () => {
        const m = signal(new Map([["key1", "val1"]]));

        const q = createQuery<string, { m: Map<string, string> }>(
            "ss/map",
            async ({ m }) => `size:${m.size}`,
            { params: () => ({ m: m.value }) }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe("size:1");
    });

    it("handles Set in params without data loss", async () => {
        const s = signal(new Set([1, 2, 3]));

        const q = createQuery<string, { s: Set<number> }>(
            "ss/set",
            async ({ s }) => `size:${s.size}`,
            { params: () => ({ s: s.value }) }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe("size:3");
    });

    it("handles Date in params (timezone-safe)", async () => {
        const d1 = new Date("2024-06-15T12:00:00Z");
        const d2 = new Date("2024-06-15T12:00:00Z");

        const s = signal(d1);

        const q = createQuery<string, { d: Date }>(
            "ss/date",
            async ({ d }) => d.toISOString(),
            { params: () => ({ d: s.value }) }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe("2024-06-15T12:00:00.000Z");

        s.value = d2;
        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe("2024-06-15T12:00:00.000Z");
    });

    it("throws TypeError on circular references instead of stack overflow", async () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;

        expect(() => {
            createQuery("ss/circular", async () => "ok", {
                params: () => circular as never,
            });
        }).toThrow(TypeError);
    });

    it("sorts Map entries deterministically regardless of insertion order", async () => {
        const m1 = new Map([["b", 2], ["a", 1]]);
        const m2 = new Map([["a", 1], ["b", 2]]);

        let calls = 0;
        const s = signal(m1);

        createQuery<number, { m: Map<string, number> }>(
            "ss/map-order",
            async () => ++calls,
            { params: () => ({ m: s.value }), staleTime: Infinity }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(calls).toBe(1);

        s.value = m2;
        await new Promise((r) => setTimeout(r, 10));
        expect(calls).toBe(1);
    });

    it("sorts Set values deterministically regardless of insertion order", async () => {
        const s1 = new Set([3, 1, 2]);
        const s2 = new Set([1, 2, 3]);

        let calls = 0;
        const sig = signal(s1);

        createQuery<number, { s: Set<number> }>(
            "ss/set-order",
            async () => ++calls,
            { params: () => ({ s: sig.value }), staleTime: Infinity }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(calls).toBe(1);

        sig.value = s2;
        await new Promise((r) => setTimeout(r, 10));
        expect(calls).toBe(1);
    });

    it("supports custom serializeParams", async () => {
        const serializeCalls: unknown[] = [];
        const customSerializer = (params: unknown): string => {
            serializeCalls.push(params);
            return JSON.stringify(params); // simple custom impl
        };

        const id = signal(42);

        const q = createQuery<string, { id: number }>(
            "ss/custom",
            async ({ id }) => `id:${id}`,
            {
                params: () => ({ id: id.value }),
                serializeParams: customSerializer,
            }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe("id:42");
        expect(serializeCalls.length).toBeGreaterThanOrEqual(1);
        expect(serializeCalls[0]).toEqual({ id: 42 });
    });

    it("custom serializeParams works with getQueryData/setQueryData", async () => {
        const customSerializer = (params: unknown): string => {
            return `custom:${JSON.stringify(params)}`;
        };

        const id = signal("abc");

        const q = createQuery<string, { id: string }>(
            "ss/custom-cache",
            async ({ id }) => `val:${id}`,
            {
                params: () => ({ id: id.value }),
                serializeParams: customSerializer,
                refetchOnMount: false,
            }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe("val:abc");

        setQueryData("ss/custom-cache", "manual-set", {
            params: { id: "abc" },
            serializeParams: customSerializer,
        });
        expect(q.data.value).toBe("manual-set");
        expect(
            getQueryData<string>("ss/custom-cache", {
                params: { id: "abc" },
                serializeParams: customSerializer,
            })
        ).toBe("manual-set");
    });

    it("handles nested Map and Set inside objects", async () => {
        const params = signal({
            filters: new Map([["status", "active"]]),
            tags: new Set(["urgent", "backend"]),
        });

        const q = createQuery<string, typeof params.value>(
            "ss/nested",
            async (p) => `f:${p.filters.size},t:${p.tags.size}`,
            { params: () => params.value }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe("f:1,t:2");
    });

    it("handles arrays with mixed types", async () => {
        const arr = signal([1, "two", { three: 3 }, new Set([4])]);

        const q = createQuery<string, typeof arr.value>(
            "ss/mixed-array",
            async (a) => `len:${a.length}`,
            { params: () => arr.value }
        );

        await new Promise((r) => setTimeout(r, 10));
        expect(q.data.value).toBe("len:4");
    });
});
