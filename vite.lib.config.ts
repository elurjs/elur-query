import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
    publicDir: false,
    build: {
        outDir: "dist/lib",
        emptyOutDir: true,
        sourcemap: true,
        lib: {
            entry: {
                "elur-query": resolve("src/index.ts"),
                devtools: resolve("src/devtools.ts"),
            },
            name: "ElurQuery",
            formats: ["es", "cjs"],
            fileName: (format, entryName) =>
                `${entryName}.${format === "cjs" ? "cjs" : "js"}`,
        },
        rollupOptions: {
            external: ["@elurjs/core"],
            output: {
                // Shared module state between the main entry and the devtools
                // entry (the devtools plugin must observe the same caches).
                preserveModules: true,
                globals: {
                    "@elurjs/core": "ElurJs",
                },
            },
        },
    },
});
