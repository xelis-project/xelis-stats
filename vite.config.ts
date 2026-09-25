import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    cloudflare(),
  ],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: { main: "src/client/main.ts" },
          output: {
            // stable paths so the Worker's SSR templates can reference the
            // built entry (see src/client/entry-url.ts)
            entryFileNames: "assets/[name].js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash][extname]",
          },
        },
      },
    },
  },
});
