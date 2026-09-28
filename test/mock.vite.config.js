// ponytail: throwaway build config for the DOM harness. Outputs outside the
// project so the packaged plugin is never affected.
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [svelte()],
  build: {
    outDir: "/tmp/vqb-mock",
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./mock.html", import.meta.url)) },
  },
});
