import "./diagnostics.ts";
import type { PerceptorEnv } from "./agent.ts";
import { reportingWindow } from "./editorial.ts";
import { MONITOR_NAME } from "./monitor.ts";
import { WATCHDOG_CRON, WEEKLY_CRON } from "./schedule.ts";
import { safeError } from "./observability.ts";
import { operations } from "./operations.ts";

export { ResearchAgent } from "./agent.ts";
export { ObservationStore } from "./monitor.ts";

export default {
  async fetch(request: Request, env: PerceptorEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      // Liveness only, not proof that the latest weekly run completed.
      return Response.json({ service: "perceptor", maxArticles: 20, publication: "review-only" });
    }
    if (url.pathname.startsWith("/ops/")) {
      try { return await operations(request, env); }
      catch (error) {
        console.error({ event: "perceptor.operations.failed", ...safeError(error, [env.OPERATIONS_TOKEN, env.ACCESS_CLIENT_ID, env.ACCESS_CLIENT_SECRET]) });
        return Response.json({ error: "Operations unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: PerceptorEnv): Promise<void> {
    try {
      if (controller.cron === WATCHDOG_CRON) {
        await env.OBSERVATIONS.getByName(MONITOR_NAME).check(controller.scheduledTime);
        return;
      }
      if (controller.cron !== WEEKLY_CRON) throw new Error("Unknown scheduled trigger");
      const window = reportingWindow(controller.scheduledTime);
      console.log({ event: "perceptor.cron.dispatched", collectionId: window.collectionId, scheduledTime: controller.scheduledTime });
      await env.RESEARCH.getByName(window.collectionId).begin(controller.scheduledTime);
    } catch (error) {
      console.error({ event: "perceptor.cron.failed", cron: controller.cron, scheduledTime: controller.scheduledTime, ...safeError(error, [env.OPERATIONS_TOKEN, env.ACCESS_CLIENT_ID, env.ACCESS_CLIENT_SECRET]) });
      // Do not leak arbitrary provider messages into Cloudflare's automatic exception capture.
      throw new Error("Perceptor scheduled dispatch failed; inspect structured telemetry");
    }
  },
} satisfies ExportedHandler<PerceptorEnv>;
