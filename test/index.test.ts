import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import worker from "../src/index.ts";
import type { PerceptorEnv } from "../src/agent.ts";
import { WATCHDOG_CRON, WEEKLY_CRON } from "../src/schedule.ts";

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
    const event = { cron: WEEKLY_CRON, scheduledTime: Date.parse("2026-11-09T08:00:00Z") } as ScheduledController;

    await worker.scheduled(event, env);
    await worker.scheduled(event, env);

    expect(getByName.mock.calls).toEqual([["discovery-1794211200000"], ["discovery-1794211200000"]]);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenLastCalledWith(event.scheduledTime);
  });

  it("dispatches watchdog ticks independently without starting research", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const getByName = vi.fn().mockReturnValue({ check });
    const research = vi.fn();
    const env = { OBSERVATIONS: { getByName }, RESEARCH: { getByName: research } } as unknown as PerceptorEnv;
    const event = { cron: WATCHDOG_CRON, scheduledTime: Date.parse("2026-11-09T08:15:00Z") } as ScheduledController;
    await worker.scheduled(event, env);
    expect(check).toHaveBeenCalledWith(event.scheduledTime);
    expect(research).not.toHaveBeenCalled();
  });

  it("does not expose observability or evidence without an operations credential", async () => {
    for (const path of ["/ops/health", "/ops/runs", "/ops/runs/discovery-1794211200000/evidence"]) {
      const response = await worker.fetch(new Request(`https://example.com${path}`), {} as PerceptorEnv);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("surfaces scheduled dispatch failures without leaking the original error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { RESEARCH: { getByName: () => ({ begin: vi.fn().mockRejectedValue(new Error("private source text")) }) } } as unknown as PerceptorEnv;
    try {
      await expect(worker.scheduled({ cron: WEEKLY_CRON, scheduledTime: Date.parse("2026-11-09T08:00:00Z") } as ScheduledController, env)).rejects.toThrow("Perceptor scheduled dispatch failed");
      expect(JSON.stringify(log.mock.calls)).not.toContain("private source text");
    } finally { log.mockRestore(); }
  });
});
