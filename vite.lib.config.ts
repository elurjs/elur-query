import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
    publicDir: false,
    build: {
        outDir: "dist/lib",
        emptyOutDir: true,
        sourcemap: true,
        lib: {
            entry: resolve("src/index.ts"),
            name: "ElurQuery",
            formats: ["es", "cjs"],
            fileName: (format) => (format === "cjs" ? "elur-query.cjs" : "elur-query.js"),
        },
        rollupOptions: {
            external: ["@elurjs/core"],
            output: {
                preserveModules: false,
                globals: {
                    "@elurjs/core": "ElurJs",
                },
            },
        },
    },
});
