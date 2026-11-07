import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { WATCHDOG_CRON, WEEKLY_CRON } from "./src/schedule.ts";

export default defineConfig({
  worker: {
    name: "perceptor",
    compatibilityDate: "2026-11-07",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    env: {
      AI: bindings.ai(),
      RESEARCH: bindings.durableObject({ worker: "perceptor", exportName: "ResearchAgent" }),
      OBSERVATIONS: bindings.durableObject({ worker: "perceptor", exportName: "ObservationStore" }),
      VERSION: bindings.versionMetadata(),
      OPERATIONS_TOKEN: bindings.secret(),
      TRACE_PAYLOADS: bindings.text("false"),
      AI_GATEWAY: bindings.text("perceptor"),
      MODEL: bindings.text("openai/gpt-6.1-sol"),
      ACCESS_CLIENT_ID: bindings.secret(),
      ACCESS_CLIENT_SECRET: bindings.secret(),
    },
    exports: {
      ResearchAgent: exports.durableObject({ storage: "sqlite" }),
      ObservationStore: exports.durableObject({ storage: "sqlite" }),
    },
    // Research weekly; independently reconcile expected/missing/stalled runs every hour.
    triggers: [triggers.scheduled({ schedule: WEEKLY_CRON }), triggers.scheduled({ schedule: WATCHDOG_CRON })],
    observability: {
      enabled: true,
      redactQueryString: true,
      issues: { enabled: true },
      logs: { enabled: true, headSamplingRate: 1, invocationLogs: true },
      traces: { enabled: true, headSamplingRate: 1 },
      // Add account-configured OTel destination names to logs/traces.destinations; see docs/observability.md.
    },
  },
});
