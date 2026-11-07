import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import worker from "../src/index.ts";
import type { PerceptorEnv } from "../src/agent.ts";

describe("Perceptor Worker", () => {
  it("exposes a read-only health response", async () => {
    const response = await exports.default.fetch("https://example.com/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "perceptor", maxArticles: 20, publication: "review-only" });
  });

  it("does not expose a public research trigger", async () => {
    const response = await exports.default.fetch("https://example.com/run", { method: "POST" });

    expect(response.status).toBe(404);
  });

  it("dispatches repeated cron events to the same durable run identity", async () => {
    const begin = vi.fn().mockResolvedValue({ status: "preparing" });
    const getByName = vi.fn().mockReturnValue({ begin });
    const env = { RESEARCH: { getByName } } as unknown as PerceptorEnv;
    const event = { scheduledTime: Date.parse("2026-11-09T08:00:00Z") } as ScheduledController;

    await worker.scheduled(event, env);
    await worker.scheduled(event, env);

    expect(getByName.mock.calls).toEqual([["discovery-1794211200000"], ["discovery-1794211200000"]]);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenLastCalledWith(event.scheduledTime);
  });
});
