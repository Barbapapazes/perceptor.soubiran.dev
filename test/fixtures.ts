import { emptyStats, type RunSummary } from "../src/observability.ts";

export const scheduledTime = Date.parse("2026-11-09T08:00:00Z");
export function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    schemaVersion: 1, collectionId: `discovery-${scheduledTime}`, conversationId: "1",
    deploymentVersion: "deployment-1", promptVersion: "prompt-1", model: "openai/example",
    executionVersions: [{ deploymentVersion: "deployment-1", promptVersion: "prompt-1", model: "openai/example" }],
    revision: 1, scheduledTime, startedAt: scheduledTime, updatedAt: scheduledTime, progressAt: scheduledTime,
    status: "researching", phaseAttempts: 0, durationMs: 0, selectedCount: 0, articles: [], stats: emptyStats(), ...overrides,
  };
}
