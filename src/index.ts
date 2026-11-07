import type { PerceptorEnv } from "./agent.ts";
import { reportingWindow } from "./editorial.ts";

export { ResearchAgent } from "./agent.ts";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ service: "perceptor", maxArticles: 20, publication: "review-only" });
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: PerceptorEnv): Promise<void> {
    const window = reportingWindow(controller.scheduledTime);
    await env.RESEARCH.getByName(window.collectionId).begin(controller.scheduledTime);
  },
} satisfies ExportedHandler<PerceptorEnv>;
