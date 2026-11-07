import { DurableObject } from "cloudflare:workers";
import type { PerceptorEnv } from "./agent.ts";
import { canonicalUrl } from "./selection.ts";
import { SUMMARY_RETENTION_MS, TERMINAL, type RunSummary } from "./observability.ts";
import { expectedScheduledTime } from "./schedule.ts";

export const MONITOR_NAME = "perceptor-observability-v1";
export const START_GRACE_MS = 15 * 60_000;
export const STALL_MS = 15 * 60_000;
export const RUN_SLA_MS = 4 * 60 * 60_000;

export function health(summary: RunSummary | null, scheduledTime: number, now: number): string | null {
  if (!summary) return now - scheduledTime >= START_GRACE_MS ? "run_missing" : null;
  if (summary.status === "failed") return "run_failed";
  if (TERMINAL.has(summary.status)) return null;
  if (now - scheduledTime >= RUN_SLA_MS) return "run_sla_exceeded";
  const expectedProgress = Math.max(summary.progressAt, summary.nextAttemptAt ?? 0);
  return now - expectedProgress >= STALL_MS ? "run_stalled" : null;
}

export const REVIEW_REASONS = ["useful", "description_edit", "title_edit", "irrelevant", "duplicate", "wrong_date", "weak_source", "inaccurate", "other"] as const;
export type Review = {
  batchId: string;
  url: string;
  decision: "accepted" | "edited" | "rejected";
  reason: typeof REVIEW_REASONS[number];
  reviewer: string;
};
export function parseReview(value: unknown): Review {
  if (!value || typeof value !== "object") throw new Error("Invalid review");
  const item = value as Record<string, unknown>;
  if (typeof item.batchId !== "string" || !/^[a-f0-9]{64}$/.test(item.batchId) ||
    typeof item.url !== "string" || item.url.length > 2000 ||
    !["accepted", "edited", "rejected"].includes(String(item.decision)) ||
    !REVIEW_REASONS.includes(item.reason as Review["reason"]) ||
    typeof item.reviewer !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(item.reviewer)) throw new Error("Invalid review");
  return { batchId: item.batchId, url: canonicalUrl(item.url), decision: item.decision as Review["decision"], reason: item.reason as Review["reason"], reviewer: item.reviewer };
}

/** A separate object/cron: never depends on the research object's control alarms. */
export class ObservationStore extends DurableObject<PerceptorEnv> {
  constructor(ctx: DurableObjectState, env: PerceptorEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS runs (
      collection_id TEXT PRIMARY KEY, scheduled_time INTEGER NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL, updated_at INTEGER NOT NULL, summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_scheduled ON runs(scheduled_time);
    CREATE TABLE IF NOT EXISTS reviews (
      collection_id TEXT NOT NULL, url TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (collection_id, url)
    );
    CREATE TABLE IF NOT EXISTS incidents (
      collection_id TEXT PRIMARY KEY, code TEXT NOT NULL, emitted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS acknowledgements (collection_id TEXT PRIMARY KEY, code TEXT NOT NULL, acknowledged_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS monitor_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    const uploadedAt = Date.parse(env.VERSION?.timestamp ?? "");
    // Enroll once, not on every deploy. Do not demand a run that predates the initial version.
    const monitoringSince = Number.isFinite(uploadedAt) && uploadedAt <= Date.now() ? uploadedAt : Date.now() - 60 * 60_000;
    ctx.storage.sql.exec("INSERT OR IGNORE INTO monitor_state VALUES ('monitoringSince', ?)", monitoringSince);
  }

  record(summary: RunSummary): void {
    // Out-of-order waitUntil/RPC completions must not roll back a newer snapshot.
    this.ctx.storage.sql.exec(`INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET revision=excluded.revision, status=excluded.status,
      updated_at=excluded.updated_at, summary=excluded.summary WHERE excluded.revision > runs.revision`,
    summary.collectionId, summary.scheduledTime, summary.revision, summary.status, summary.updatedAt, JSON.stringify(summary));
  }

  list(limit = 26): RunSummary[] {
    return this.ctx.storage.sql.exec<{ summary: string }>(
      "SELECT summary FROM runs ORDER BY scheduled_time DESC LIMIT ?", Math.max(1, Math.min(180, limit)),
    ).toArray().map((row) => JSON.parse(row.summary) as RunSummary);
  }

  detail(collectionId: string) {
    const row = this.ctx.storage.sql.exec<{ summary: string }>("SELECT summary FROM runs WHERE collection_id = ?", collectionId).toArray()[0];
    if (!row) return null;
    const summary = JSON.parse(row.summary) as RunSummary;
    const reviews = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM reviews WHERE collection_id = ?", collectionId).toArray().map((item) => JSON.parse(item.value) as Review);
    const accepted = reviews.filter((item) => item.decision !== "rejected").length;
    return {
      summary, reviews,
      evaluation: {
        reviewed: reviews.length, accepted, rejected: reviews.length - accepted,
        edited: reviews.filter((item) => item.decision === "edited").length,
        acceptanceRate: reviews.length ? accepted / reviews.length : null,
        // Model-only observed cost, NOT the complete Gateway/search/conversion/Workers bill.
        observedModelCostPerAcceptedArticleUsd: accepted ? summary.stats.modelCostUsd / accepted : null,
      },
    };
  }

  status(now: number) {
    const row = this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM monitor_state WHERE key = 'checkedAt'").toArray()[0];
    const incidents = this.ctx.storage.sql.exec<{ collection_id: string; code: string; emitted_at: number }>("SELECT collection_id, code, emitted_at FROM incidents ORDER BY emitted_at DESC LIMIT 32").toArray();
    const enrollment = this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM monitor_state WHERE key = 'monitoringSince'").toArray()[0];
    return { healthy: !!row && now - row.value < 90 * 60_000 && incidents.length === 0, checkedAt: row?.value ?? null, monitoringSince: enrollment.value, incidents };
  }

  acknowledge(collectionId: string): boolean {
    const incident = this.ctx.storage.sql.exec<{ code: string }>("SELECT code FROM incidents WHERE collection_id = ?", collectionId).toArray()[0];
    if (!incident) return false;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO acknowledgements VALUES (?, ?, ?)", collectionId, incident.code, Date.now());
    this.ctx.storage.sql.exec("DELETE FROM incidents WHERE collection_id = ?", collectionId);
    console.log({ event: "perceptor.watchdog.acknowledged", collectionId, failureCode: incident.code });
    return true;
  }

  review(collectionId: string, input: Review) {
    const review = parseReview(input);
    const detail = this.detail(collectionId);
    if (!detail || !TERMINAL.has(detail.summary.status)) throw new Error("Unknown or unfinished collection");
    if (review.batchId !== detail.summary.batchId || !detail.summary.articles.some((item) => item.url === review.url)) throw new Error("Review does not match the frozen batch");
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO reviews VALUES (?, ?, ?, ?)", collectionId, review.url, JSON.stringify(review), Date.now());
    console.log({ event: "perceptor.review.recorded", collectionId, batchId: review.batchId, decision: review.decision, reason: review.reason, reviewer: review.reviewer, sourceHost: new URL(review.url).hostname });
    return this.detail(collectionId);
  }

  async check(now: number): Promise<void> {
    const expected = expectedScheduledTime(now);
    const since = this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM monitor_state WHERE key = 'monitoringSince'").toArray()[0].value;
    const targets = new Map<string, number>();
    if (expected >= since) targets.set(`discovery-${expected}`, expected);
    // Also catch a previous week's still-active run, not just this week's expected run.
    for (const row of this.ctx.storage.sql.exec<{ collection_id: string; scheduled_time: number }>(
      "SELECT collection_id, scheduled_time FROM runs WHERE status IN ('preparing', 'researching', 'ready') ORDER BY scheduled_time DESC LIMIT 32",
    ).toArray()) targets.set(row.collection_id, row.scheduled_time);
    for (const row of this.ctx.storage.sql.exec<{ collection_id: string }>("SELECT collection_id FROM incidents ORDER BY emitted_at DESC LIMIT 32").toArray()) {
      const time = Number(row.collection_id.slice(10));
      if (now - time < SUMMARY_RETENTION_MS) targets.set(row.collection_id, time);
    }
    for (const [collectionId, scheduledTime] of targets) {
      try {
        // Reconcile directly with authoritative state; a failed telemetry publish is not a failed run.
        const summary = await this.env.RESEARCH.getByName(collectionId).snapshot();
        if (summary) this.record(summary);
        this.incident(collectionId, health(summary, scheduledTime, now), now);
      } catch {
        this.incident(collectionId, "watchdog_read_failed", now);
      }
    }
    await this.prune(now);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO monitor_state VALUES ('checkedAt', ?)", now);
    this.ctx.storage.sql.exec("DELETE FROM incidents WHERE CAST(substr(collection_id, 11) AS INTEGER) < ?", now - SUMMARY_RETENTION_MS);
    this.ctx.storage.sql.exec("DELETE FROM acknowledgements WHERE CAST(substr(collection_id, 11) AS INTEGER) < ?", now - SUMMARY_RETENTION_MS);
    console.log({ event: "perceptor.watchdog.checked", expectedCollectionId: `discovery-${expected}`, checked: targets.size, checkedAt: now });
  }

  private incident(collectionId: string, code: string | null, now: number): void {
    const prior = this.ctx.storage.sql.exec<{ code: string; emitted_at: number }>("SELECT code, emitted_at FROM incidents WHERE collection_id = ?", collectionId).toArray()[0];
    if (!code) {
      if (prior) console.log({ event: "perceptor.watchdog.resolved", collectionId, previousCode: prior.code });
      this.ctx.storage.sql.exec("DELETE FROM incidents WHERE collection_id = ?", collectionId);
      this.ctx.storage.sql.exec("DELETE FROM acknowledgements WHERE collection_id = ?", collectionId);
      return;
    }
    const acknowledged = this.ctx.storage.sql.exec<{ code: string }>("SELECT code FROM acknowledgements WHERE collection_id = ?", collectionId).toArray()[0];
    if (acknowledged?.code === code) return;
    this.ctx.storage.sql.exec("DELETE FROM acknowledgements WHERE collection_id = ?", collectionId);
    if (prior?.code === code && now - prior.emitted_at < 86_400_000) return;
    console.error({ event: "perceptor.watchdog.alert", collectionId, failureCode: code });
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO incidents VALUES (?, ?, ?)", collectionId, code, now);
  }

  private async prune(now: number): Promise<void> {
    // Keep summaries/reviews for 180 days. Delete complete old, terminal research objects first.
    const old = this.ctx.storage.sql.exec<{ collection_id: string }>(
      "SELECT collection_id FROM runs WHERE scheduled_time < ? AND updated_at < ? AND status IN ('delivered', 'empty', 'failed') ORDER BY scheduled_time LIMIT 8", now - SUMMARY_RETENTION_MS, now - SUMMARY_RETENTION_MS,
    ).toArray();
    for (const row of old) {
      try {
        const deleted = await this.env.RESEARCH.getByName(row.collection_id).purge(now);
        if (!deleted) continue;
        this.ctx.storage.sql.exec("DELETE FROM reviews WHERE collection_id = ?", row.collection_id);
        this.ctx.storage.sql.exec("DELETE FROM incidents WHERE collection_id = ?", row.collection_id);
        this.ctx.storage.sql.exec("DELETE FROM runs WHERE collection_id = ?", row.collection_id);
      } catch { console.warn({ event: "perceptor.retention.retry", collectionId: row.collection_id }); }
    }
  }
}
