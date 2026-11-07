import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "perceptor",
    compatibilityDate: "2026-11-07",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    env: {
      AI: bindings.ai(),
      RESEARCH: bindings.durableObject({ worker: "perceptor", exportName: "ResearchAgent" }),
      AI_GATEWAY: bindings.text("perceptor"),
      MODEL: bindings.text("openai/gpt-6.1-sol"),
      ACCESS_CLIENT_ID: bindings.secret(),
      ACCESS_CLIENT_SECRET: bindings.secret(),
    },
    exports: {
      ResearchAgent: exports.durableObject({ storage: "sqlite" }),
    },
    // Monday at 08:00 UTC. No DST adjustment and no public run-trigger endpoint.
    triggers: [triggers.scheduled({ schedule: "0 8 * * 1" })],
    observability: {
      enabled: true,
    },
  },
});
