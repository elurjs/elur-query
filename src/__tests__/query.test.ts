import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { html, mount, NixComponent, signal, batch } from "@deijose/nix-js";
import {
    createQuery,
    invalidateQueries,
    clearQueryCache,
    setQueryCacheTime,
    getQueryData,
    setQueryData,
    updateQueryData,
} from "../index";

describe("createQuery / invalidateQueries", () => {
    it("re-fetches on invalidate even when result is destructured", async () => {
        let callCount = 0;

        const { data, status } = createQuery("destructure-query", async () => {
            callCount++;
            return callCount;
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(status.value).toBe("success");
        expect(data.value).toBe(1);

        invalidateQueries("destructure-query");

        await Promise.resolve();
        await Promise.resolve();

        expect(status.value).toBe("success");
        expect(data.value).toBe(2);
        expect(callCount).toBe(2);
    });

    it("fetches and renders data by key", async () => {
        class TestListComp extends NixComponent {
            private query = createQuery("test-items", () => Promise.resolve(["a", "b", "c"]));

            render() {
                return html`
          <div class="list-container">
            ${() =>
                        this.query.status.value === "success"
                            ? html`<ul class="list">${this.query.data.value!.map((i) => html`<li>${i}</li>`)}</ul>`
                            : ""}
          </div>
        `;
            }
        }

        const el = document.createElement("div");
        mount(new TestListComp(), el);
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector(".list")!.children.length).toBe(3);
    });

    it("re-fetches when invalidateQueries is called with matching key", async () => {
        let callCount = 0;

        class CounterComp extends NixComponent {
            private query = createQuery("counter-query", () => {
                callCount++;
                return Promise.resolve(callCount);
            });

            render() {
                return html`
          <div>
            ${() =>
                        this.query.status.value === "success"
                            ? html`<span class="val">${this.query.data.value}</span>`
                            : ""}
          </div>
        `;
            }
        }

        const el = document.createElement("div");
        mount(new CounterComp(), el);
        await new Promise((r) => setTimeout(r, 10));
        expect(el.querySelector(".val")!.textContent).toBe("1");

        invalidateQueries("counter-query");
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector(".val")!.textContent).toBe("2");
        expect(callCount).toBe(2);
    });

    it("does not affect queries with different keys", async () => {
        let countA = 0;
        let countB = 0;

        class CompA extends NixComponent {
            q = createQuery("key-a", () => {
                countA++;
                return Promise.resolve("a");
            });
            render() {
                return html`<span class="a">${() => this.q.data.value}</span>`;
            }
        }

        class CompB extends NixComponent {
            q = createQuery("key-b", () => {
                countB++;
                return Promise.resolve("b");
            });
            render() {
                return html`<span class="b">${() => this.q.data.value}</span>`;
            }
        }

        mount(new CompA(), document.createElement("div"));
        mount(new CompB(), document.createElement("div"));
        await new Promise((r) => setTimeout(r, 10));

        invalidateQueries("key-a");
        await new Promise((r) => setTimeout(r, 10));

        expect(countA).toBe(2);
        expect(countB).toBe(1);
    });

    it("manual refetch forces reload", async () => {
        let count = 0;
        let refetchFn!: () => void;

        class RefetchComp extends NixComponent {
            q = createQuery("manual-test", () => {
                count++;
                return Promise.resolve(count);
            });
            onInit() {
                refetchFn = this.q.refetch;
            }
            render() {
                return html`<div></div>`;
            }
        }

        mount(new RefetchComp(), document.createElement("div"));
        await Promise.resolve();
        expect(count).toBe(1);

        refetchFn();
        await Promise.resolve();
        expect(count).toBe(2);
    });

    it("getQueryData/setQueryData/updateQueryData work and sync active query", async () => {
        const q = createQuery(
            "users/list",
            async () => [{ id: 1, name: "Ana" }],
            { refetchOnMount: false }
        );

        await Promise.resolve();
        expect(getQueryData<{ id: number; name: string }[]>("users/list")?.length).toBe(1);

        setQueryData("users/list", [{ id: 1, name: "Ana" }, { id: 2, name: "Luis" }]);
        expect(getQueryData<{ id: number; name: string }[]>("users/list")?.length).toBe(2);
        expect(q.status.value).toBe("success");
        expect(q.data.value?.length).toBe(2);

        updateQueryData<{ id: number; name: string }[]>(
            "users/list",
            (current = []) => [...current, { id: 3, name: "Mia" }]
        );
        expect(getQueryData<{ id: number; name: string }[]>("users/list")?.length).toBe(3);
        expect(q.data.value?.length).toBe(3);
    });
});

describe("createQuery with reactive params", () => {
    beforeEach(() => {
        clearQueryCache();
    });

    it("passes params to the fetcher", async () => {
        const search = signal("ana");
        let received: string | undefined;

        createQuery<string[], { q: string }>(
            "posts",
            async ({ q }) => {
                received = q;
                return [q];
            },
            { params: () => ({ q: search.value }) }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(received).toBe("ana");
    });

    it("refetches automatically when a param signal changes", async () => {
        const search = signal("a");
        const calls: string[] = [];

        const { data } = createQuery<string, { q: string }>(
            "search",
            async ({ q }) => {
                calls.push(q);
                return `result:${q}`;
            },
            { params: () => ({ q: search.value }) }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(data.value).toBe("result:a");
        expect(calls).toEqual(["a"]);

        search.value = "b";
        await Promise.resolve();
        await Promise.resolve();
        expect(data.value).toBe("result:b");
        expect(calls).toEqual(["a", "b"]);
    });

    it("caches each param value independently and serves cache on revisit", async () => {
        const id = signal(1);
        let callCount = 0;

        const { data } = createQuery<number, { id: number }>(
            "user",
            async ({ id }) => {
                callCount++;
                return id * 10;
            },
            { params: () => ({ id: id.value }), staleTime: Infinity }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(data.value).toBe(10);
        expect(callCount).toBe(1);

        id.value = 2;
        await Promise.resolve();
        await Promise.resolve();
        expect(data.value).toBe(20);
        expect(callCount).toBe(2);

        // Revisit id=1 — served from cache, no new fetch.
        id.value = 1;
        await Promise.resolve();
        await Promise.resolve();
        expect(data.value).toBe(10);
        expect(callCount).toBe(2);
    });

    it("does not refetch when params serialize to the same key", async () => {
        const a = signal(1);
        const b = signal(2);
        let callCount = 0;

        createQuery<number, { sum: number }>(
            "stable",
            async () => {
                callCount++;
                return 0;
            },
            { params: () => ({ sum: a.value + b.value }) }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(callCount).toBe(1);

        // a+b stays 3 (atomic) → same key → no refetch.
        batch(() => {
            a.value = 0;
            b.value = 3;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(callCount).toBe(1);
    });

    it("ignores stale in-flight responses after params change", async () => {
        const id = signal(1);
        const resolvers: Record<number, (v: string) => void> = {};

        const { data } = createQuery<string, { id: number }>(
            "race",
            ({ id }) =>
                new Promise<string>((resolve) => {
                    resolvers[id] = resolve;
                }),
            { params: () => ({ id: id.value }) }
        );

        // Switch to id=2 before id=1 resolves.
        id.value = 2;
        await Promise.resolve();

        // Resolve the stale id=1 request last.
        resolvers[2]("v2");
        await Promise.resolve();
        await Promise.resolve();
        expect(data.value).toBe("v2");

        resolvers[1]("v1");
        await Promise.resolve();
        await Promise.resolve();
        // Stale response must not overwrite current data.
        expect(data.value).toBe("v2");
    });

    it("invalidates param-scoped queries when the base key is invalidated", async () => {
        const id = signal("abc");
        let callCount = 0;

        const { data } = createQuery<string, { id: string }>(
            "events/checklist",
            async ({ id }) => {
                callCount++;
                return `items:${id}`;
            },
            { params: () => ({ id: id.value }) }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(data.value).toBe("items:abc");
        expect(callCount).toBe(1);

        invalidateQueries("events/checklist");
        await Promise.resolve();
        await Promise.resolve();

        expect(callCount).toBe(2);
        expect(data.value).toBe("items:abc");
    });

    it("exposes the effective key on the query result", async () => {
        const id = signal("abc");
        const q = createQuery<string, { id: string }>(
            "events/detail",
            async ({ id }) => `detail:${id}`,
            { params: () => ({ id: id.value }) }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(q.key).toBe('events/detail::{"id":"abc"}');
    });

    it("getQueryData/setQueryData/updateQueryData work with params", async () => {
        const id = signal("abc");
        const q = createQuery<string[], { id: string }>(
            "events/items",
            async ({ id }) => [`item:${id}`],
            { refetchOnMount: false, params: () => ({ id: id.value }) }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(q.data.value).toEqual(["item:abc"]);

        setQueryData<string[]>("events/items", ["item:abc", "extra"], { params: { id: "abc" } });
        expect(getQueryData<string[]>("events/items", { params: { id: "abc" } })?.length).toBe(2);
        expect(q.data.value?.length).toBe(2);

        updateQueryData<string[]>(
            "events/items",
            (current = []) => [...current, "another"],
            { params: { id: "abc" } }
        );
        expect(getQueryData<string[]>("events/items", { params: { id: "abc" } })?.length).toBe(3);
        expect(q.data.value?.length).toBe(3);
    });

    it("clearQueryCache clears param-scoped variants by base key", async () => {
        const id = signal("abc");
        let callCount = 0;

        const q = createQuery<string, { id: string }>(
            "events/clear-test",
            async ({ id }) => {
                callCount++;
                return `value:${id}`;
            },
            { refetchOnMount: false, params: () => ({ id: id.value }) }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(q.data.value).toBe("value:abc");
        expect(callCount).toBe(1);

        clearQueryCache("events/clear-test");
        await Promise.resolve();

        expect(getQueryData<string>("events/clear-test", { params: { id: "abc" } })).toBeUndefined();

        // Remounting/reattivating should fetch again because cache is gone.
        q.refetch();
        await Promise.resolve();
        await Promise.resolve();
        expect(callCount).toBe(2);
    });
});

describe("Query Cache Utils & Garbage Collection", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        clearQueryCache();
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });

    it("clearQueryCache clears by key or globally", async () => {
        let fetchCountA = 0;
        let fetchCountB = 0;

        class CompA extends NixComponent {
            q = createQuery(
                "k1",
                () => {
                    fetchCountA++;
                    return Promise.resolve(1);
                },
                { refetchOnMount: false }
            );
            render() {
                return html`<div>A</div>`;
            }
        }

        class CompB extends NixComponent {
            q = createQuery(
                "k2",
                () => {
                    fetchCountB++;
                    return Promise.resolve(2);
                },
                { refetchOnMount: false }
            );
            render() {
                return html`<div>B</div>`;
            }
        }

        const host = document.createElement("div");
        mount(new CompA(), host);
        mount(new CompB(), host);
        await Promise.resolve();

        expect(fetchCountA).toBe(1);
        expect(fetchCountB).toBe(1);

        clearQueryCache("k1");
        mount(new CompA(), document.createElement("div"));
        mount(new CompB(), document.createElement("div"));
        await Promise.resolve();

        expect(fetchCountA).toBe(2);
        expect(fetchCountB).toBe(1);

        clearQueryCache();
        mount(new CompB(), document.createElement("div"));
        await Promise.resolve();

        expect(fetchCountB).toBe(2);
    });

    it("garbage collector removes stale entries", async () => {
        setQueryCacheTime(10);
        let fetchCount = 0;

        class GcComp extends NixComponent {
            q = createQuery(
                "gc-test",
                () => {
                    fetchCount++;
                    return Promise.resolve(fetchCount);
                },
                { staleTime: Infinity, refetchOnMount: false }
            );

            render() {
                return html`<div>${() => this.q.data.value}</div>`;
            }
        }

        mount(new GcComp(), document.createElement("div"));
        await Promise.resolve();
        expect(fetchCount).toBe(1);

        mount(new GcComp(), document.createElement("div"));
        await Promise.resolve();
        expect(fetchCount).toBe(1);

        const time2 = Date.now() + 60_001;
        vi.setSystemTime(time2);
        vi.advanceTimersByTime(60_001);

        mount(new GcComp(), document.createElement("div"));
        await Promise.resolve();
        expect(fetchCount).toBe(2);
    });
});
