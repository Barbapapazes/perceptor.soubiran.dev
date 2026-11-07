import { describe, expect, it, vi } from "vite-plus/test";
import type { PerceptorEnv } from "../src/agent.ts";
import { authorized, operations } from "../src/operations.ts";
import { summary } from "./fixtures.ts";

const token = "a-test-operations-token-of-at-least-32-characters";
function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Request(`https://example.com${path}`, { ...init, headers });
}
function fixture() {
  const store = {
    list: vi.fn().mockResolvedValue([summary()]), detail: vi.fn().mockResolvedValue(null),
    review: vi.fn(), acknowledge: vi.fn().mockResolvedValue(true), status: vi.fn().mockResolvedValue({ healthy: false, checkedAt: null, incidents: [] }),
  };
  const getByName = vi.fn().mockReturnValue(store);
  const research = vi.fn();
  const env = { OPERATIONS_TOKEN: token, OBSERVATIONS: { getByName }, RESEARCH: { getByName: research } } as unknown as PerceptorEnv;
  return { env, store, getByName, research };
}

describe("protected operations API", () => {
  it("fails closed for missing, short, incorrect, query-string or oversized credentials", async () => {
    expect(await authorized(request("/ops/runs"), token)).toBe(true);
    expect(await authorized(request("/ops/runs"), undefined)).toBe(false);
    expect(await authorized(request("/ops/runs"), "short")).toBe(false);
    expect(await authorized(request("/ops/runs"), `${token}-wrong`)).toBe(false);
    expect(await authorized(new Request(`https://example.com/ops/runs?token=${token}`), token)).toBe(false);
    expect(await authorized(new Request("https://example.com/ops/runs", { headers: { Authorization: `Bearer ${"x".repeat(600)}` } }), token)).toBe(false);
  });

  it("does not access a Durable Object before authorization", async () => {
    const { env, getByName } = fixture();
    const response = await operations(new Request("https://example.com/ops/runs"), env);
    expect(response.status).toBe(401);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("bounds listing and marks protected responses as uncacheable", async () => {
    const { env, store, research } = fixture();
    const response = await operations(request("/ops/runs?limit=10"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(store.list).toHaveBeenCalledWith(10);
    expect(research).not.toHaveBeenCalled();
    expect((await operations(request("/ops/runs?limit=10000"), env)).status).toBe(400);
    expect((await operations(request("/ops/runs?limit=NaN"), env)).status).toBe(400);
  });

  it("returns 503 when the independent watchdog is stale or has an incident", async () => {
    const { env, store } = fixture();
    expect((await operations(request("/ops/health"), env)).status).toBe(503);
    store.status.mockResolvedValue({ healthy: true, checkedAt: Date.now(), incidents: [] });
    expect((await operations(request("/ops/health"), env)).status).toBe(200);
  });

  it("acknowledges incidents without invoking research or changing delivery", async () => {
    const { env, store, research } = fixture();
    const response = await operations(request("/ops/incidents/discovery-1794211200000/acknowledge", { method: "POST" }), env);
    expect(await response.json()).toEqual({ acknowledged: true });
    expect(store.acknowledge).toHaveBeenCalledWith("discovery-1794211200000");
    expect(research).not.toHaveBeenCalled();
  });

  it("rejects oversized feedback before recording it", async () => {
    const { env, store } = fixture();
    const response = await operations(request("/ops/runs/discovery-1794211200000/review", { method: "PUT", body: JSON.stringify({ padding: "x".repeat(17_000) }) }), env);
    expect(response.status).toBe(400);
    expect(store.review).not.toHaveBeenCalled();
  });

  it("requires feedback to match the retained frozen batch and URL", async () => {
    const { env, store } = fixture();
    const input = { batchId: "a".repeat(64), url: "https://example.com/report", decision: "accepted", reason: "useful", reviewer: "editor-1" };
    const path = "/ops/runs/discovery-1794211200000/review";
    expect((await operations(request(path, { method: "PUT", body: JSON.stringify(input) }), env)).status).toBe(409);
    store.detail.mockResolvedValue({ summary: summary({ status: "delivered", batchId: input.batchId, articles: [{ url: input.url, sourceHost: "example.com" }] }) });
    store.review.mockResolvedValue({ recorded: true });
    const response = await operations(request(path, { method: "PUT", body: JSON.stringify(input) }), env);
    expect(response.status).toBe(200);
    expect(store.review).toHaveBeenCalledWith("discovery-1794211200000", input);
  });
});
