import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import type { PerceptorEnv } from "../src/agent.ts";
import { SUMMARY_RETENTION_MS } from "../src/observability.ts";
import { scheduledTime, summary } from "./fixtures.ts";
import { expectedScheduledTime } from "../src/schedule.ts";

const bindings = env as unknown as PerceptorEnv;

describe("durable observation store", () => {
  it("ignores out-of-order publications and idempotent duplicate revisions", async () => {
    const store = bindings.OBSERVATIONS.getByName("test-observability-ordering");
    await store.record(summary({ revision: 3, status: "delivered" }));
    await store.record(summary({ revision: 2, status: "researching" }));
    await store.record(summary({ revision: 3, status: "failed" }));
    expect((await store.detail(`discovery-${scheduledTime}`))?.summary.status).toBe("delivered");
  });

  it("upserts feedback without inflating review counts and evaluates observed model cost", async () => {
    const store = bindings.OBSERVATIONS.getByName("test-observability-review");
    const run = summary({ status: "delivered", batchId: "a".repeat(64), selectedCount: 1, articles: [{ url: "https://example.com/report", sourceHost: "example.com" }] });
    run.stats.modelCostUsd = 0.25;
    await store.record(run);
    const feedback = { batchId: run.batchId!, url: run.articles[0].url, decision: "accepted" as const, reason: "useful" as const, reviewer: "editor-1" };
    await store.review(run.collectionId, feedback);
    await store.review(run.collectionId, feedback);
    expect((await store.detail(run.collectionId))?.evaluation).toMatchObject({ reviewed: 1, accepted: 1, acceptanceRate: 1, observedModelCostPerAcceptedArticleUsd: 0.25 });
    await store.review(run.collectionId, { ...feedback, decision: "rejected", reason: "wrong_date" });
    expect((await store.detail(run.collectionId))?.evaluation).toMatchObject({ reviewed: 1, accepted: 0, rejected: 1, acceptanceRate: 0, observedModelCostPerAcceptedArticleUsd: null });
    await expect(store.review(run.collectionId, { ...feedback, batchId: "b".repeat(64) })).rejects.toThrow("frozen batch");
  });

  it("reconciles a missing expected run without dispatching research", async () => {
    const store = bindings.OBSERVATIONS.getByName("test-observability-missing");
    const now = Date.now() + 7 * 86_400_000;
    const expected = expectedScheduledTime(now);
    await store.check(now);
    const status = await store.status(now);
    expect(status.checkedAt).toBe(now);
    expect(status.healthy).toBe(false);
    expect(status.incidents).toEqual([expect.objectContaining({ collection_id: `discovery-${expected}`, code: "run_missing" })]);
    expect((await bindings.RESEARCH.getByName(`discovery-${expected}`).snapshot())).toBeNull();
    expect(await store.acknowledge(`discovery-${expected}`)).toBe(true);
    await store.check(now + 60_000);
    expect((await store.status(now + 60_000)).healthy).toBe(true);
    expect(await store.acknowledge(`discovery-${expected}`)).toBe(false);
  });

  it("expires old terminal summaries and reviews, but retains active runs", async () => {
    const store = bindings.OBSERVATIONS.getByName("test-observability-retention");
    const terminal = summary({ status: "delivered", finishedAt: scheduledTime });
    const active = summary({ collectionId: `discovery-${scheduledTime + 1}`, scheduledTime: scheduledTime + 1 });
    await store.record(terminal);
    await store.record(active);
    await store.check(scheduledTime + SUMMARY_RETENTION_MS + 86_400_000);
    expect(await store.detail(terminal.collectionId)).toBeNull();
    expect(await store.detail(active.collectionId)).not.toBeNull();
  });
});
