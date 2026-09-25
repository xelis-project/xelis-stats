// Client entry URL used by the Worker's SSR HTML.
//
// In dev, Vite serves the source module directly. In production the client
// environment builds src/client/main.ts to a fixed path (see vite.config.ts
// environments.client.build.rollupOptions.output.entryFileNames) so templates
// can reference it without a manifest lookup.
export const mainScriptUrl = import.meta.env.DEV ? "/src/client/main.ts" : "/assets/main.js";
