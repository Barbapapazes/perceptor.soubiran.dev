import { describe, expect, it } from "vite-plus/test";
import { health, parseReview, RUN_SLA_MS, STALL_MS, START_GRACE_MS } from "../src/monitor.ts";
import { expectedScheduledTime } from "../src/schedule.ts";
import { scheduledTime, summary } from "./fixtures.ts";

describe("independent weekly watchdog", () => {
  it.each([
    ["2026-11-09T07:59:59Z", "2026-11-02T08:00:00Z"],
    ["2026-11-09T08:00:00Z", "2026-11-09T08:00:00Z"],
    ["2026-11-15T23:59:59Z", "2026-11-09T08:00:00Z"],
    ["2026-11-16T07:59:59Z", "2026-11-09T08:00:00Z"],
    ["2026-12-01T12:00:00Z", "2026-11-30T08:00:00Z"],
  ])("derives expected runs from UTC time, not dispatch records: %s", (now, expected) => {
    expect(expectedScheduledTime(Date.parse(now))).toBe(Date.parse(expected));
  });

  it("detects an absent run even without a registered dispatch", () => {
    expect(health(null, scheduledTime, scheduledTime + START_GRACE_MS - 1)).toBeNull();
    expect(health(null, scheduledTime, scheduledTime + START_GRACE_MS)).toBe("run_missing");
  });

  it("detects stalled progress rather than mistaking control heartbeats for progress", () => {
    expect(health(summary({ updatedAt: scheduledTime + STALL_MS }), scheduledTime, scheduledTime + STALL_MS)).toBe("run_stalled");
    expect(health(summary({ progressAt: scheduledTime + 60_000 }), scheduledTime, scheduledTime + STALL_MS)).toBeNull();
  });

  it("respects delivery backoff but still enforces an end-to-end SLA", () => {
    expect(health(summary({ status: "ready", nextAttemptAt: scheduledTime + 3_600_000 }), scheduledTime, scheduledTime + 3_000_000)).toBeNull();
    expect(health(summary({ status: "ready", nextAttemptAt: scheduledTime + RUN_SLA_MS + 60_000 }), scheduledTime, scheduledTime + RUN_SLA_MS)).toBe("run_sla_exceeded");
  });

  it("treats empty as success, and a terminal failure as an incident", () => {
    for (const status of ["empty", "delivered"] as const) expect(health(summary({ status }), scheduledTime, scheduledTime + RUN_SLA_MS)).toBeNull();
    expect(health(summary({ status: "failed" }), scheduledTime, scheduledTime + 60_000)).toBe("run_failed");
  });
});

describe("review validation", () => {
  const review = { batchId: "a".repeat(64), url: "https://example.com/report?utm_source=mail", decision: "accepted", reason: "useful", reviewer: "editor-1" };
  it("canonicalizes URLs and drops arbitrary input properties", () => {
    expect(parseReview({ ...review, credentials: "never persist" })).toEqual({ ...review, url: "https://example.com/report" });
  });
  it.each([
    { batchId: "wrong" }, { url: "http://127.0.0.1/private" }, { decision: "published" },
    { reason: "free-form source body" }, { reviewer: "editor@example.com" },
  ])("rejects invalid or sensitive review values: %j", (override) => {
    expect(() => parseReview({ ...review, ...override })).toThrow();
  });
});
