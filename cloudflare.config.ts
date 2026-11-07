import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "perceptor",
    compatibilityDate: "2026-11-07",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    observability: {
      enabled: true,
    },
  },
});
