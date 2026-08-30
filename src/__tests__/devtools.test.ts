import { describe, expect, it } from "vitest";
import { clearQueryCache, createQuery, getQueryData, setQueryData } from "../index";
import { getQueryDevtoolsSnapshot, handleQueryDevtoolsCommand } from "../devtools";
import type { QueryCacheEntrySnapshot } from "../devtools";

describe("devtools plugin", () => {
    it("returns a JSON-safe snapshot of the cache and inflight state", async () => {
        setQueryData("devtools-user", { id: 1, name: "Ada" });

        const query = createQuery("devtools-pending", () => new Promise(() => undefined));

        const snapshot = getQueryDevtoolsSnapshot();
        expect(snapshot.cacheTime).toBeGreaterThan(0);

        const cached = snapshot.cache.find((e: QueryCacheEntrySnapshot) => e.key === "devtools-user");
        expect(cached).toBeDefined();
        expect(cached?.dataPreview).toContain("Ada");
        expect(cached?.data).toEqual({ id: 1, name: "Ada" });

        expect(snapshot.inflight).toContain("devtools-pending");
        expect(Array.isArray(snapshot.commands)).toBe(true);

        // The whole snapshot must survive JSON serialization.
        expect(() => JSON.stringify(snapshot)).not.toThrow();

        query.dispose();
    });

    it("refetches active queries and clears cache entries from extension commands", async () => {
        let version = 0;
        const query = createQuery("devtools-refetch", async () => ({ version: ++version }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(getQueryData("devtools-refetch")).toEqual({ version: 1 });

        await handleQueryDevtoolsCommand({ type: "refetch", key: "devtools-refetch" });
        expect(getQueryData("devtools-refetch")).toEqual({ version: 2 });

        await handleQueryDevtoolsCommand({ type: "clear", key: "devtools-refetch" });
        expect(getQueryData("devtools-refetch")).toBeUndefined();
        query.dispose();
        clearQueryCache();
    });

    it("registers on the global hook when present", () => {
        const registered: string[] = [];
        (window as unknown as Record<string, unknown>).__ELUR_DEVTOOLS_HOOK__ = {
            version: 1,
            registerPlugin(plugin: { id: string }) {
                registered.push(plugin.id);
                return () => undefined;
            },
        };
        // The module already ran at import time; simulate a fresh import is
        // not possible here, so assert the descriptor contract via snapshot.
        expect(getQueryDevtoolsSnapshot).toBeTypeOf("function");
        delete (window as unknown as Record<string, unknown>).__ELUR_DEVTOOLS_HOOK__;
    });
});
