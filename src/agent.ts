import { DurableObject, tracing } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, GenerationTask, Harness, hook, ToolTask, type ToolRegistration } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { createAIWebSearch } from "agents/websearch";
import { webSearchTool } from "agents/websearch/pi";
import { createDirectWebFetch, type WebFetchPage } from "agents/webfetch";
import { webFetchTool } from "agents/webfetch/pi";
import { DeliveryError, deliverBatch, recentNews } from "./api.ts";
import { EDITORIAL_PROMPT, reportingWindow } from "./editorial.ts";
import { SelectionSchema, canonicalUrl, createBatch, validateSelection, type Batch, type Selection, type Window } from "./selection.ts";
import { MONITOR_NAME, type ObservationStore } from "./monitor.ts";
import { PolicyError, PROMPT_VERSION, RunTelemetry, SUMMARY_RETENTION_MS, TERMINAL, type ExecutionVersion, type RunSummary } from "./observability.ts";

export interface PerceptorEnv {
  AI: Ai;
  RESEARCH: DurableObjectNamespace<ResearchAgent>;
  OBSERVATIONS: DurableObjectNamespace<ObservationStore>;
  VERSION: { id: string; tag?: string; timestamp?: string };
  AI_GATEWAY: string;
  MODEL: string;
  OPERATIONS_TOKEN: string;
  TRACE_PAYLOADS: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
}

type Run = {
  window: Window;
  status: RunSummary["status"];
  scheduledTime: number;
  startedAt: number;
  promptVersion: string;
  deploymentVersion: string;
  model: string;
  deadline: number;
  attempts: number;
  finishedAt?: number;
  nextAttemptAt?: number;
  failureCode?: string;
  recent?: Awaited<ReturnType<typeof recentNews>>;
  selection?: Selection;
  batch?: Batch;
  acknowledgement?: unknown;
  error?: string;
};
type Clock = { revision: number; updatedAt: number; progressAt: number };
const ACTIVE = new Set<Run["status"]>(["preparing", "researching", "ready"]);
const MAX_SEARCHES = 40;
const MAX_FETCHES = 40;
const RESEARCH_MS = 20 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;

export class ResearchAgent extends DurableObject<PerceptorEnv> {
  private initialized = false;
  private registry = createRegistry();
  private telemetry = new RunTelemetry(
    () => {
      const run = this.read<Run>("run");
      return {
        collectionId: run?.window.collectionId ?? "uninitialized",
        conversationId: "1", // PiHarness's documented root session, scoped by collection in trace attributes.
        deploymentVersion: this.env.VERSION?.id ?? "local",
        promptVersion: PROMPT_VERSION,
        model: run?.model ?? this.env.MODEL,
      };
    },
    <T>(key: string) => this.read<T>(key),
    (key, value) => this.write(key, value),
    () => [this.env.ACCESS_CLIENT_ID, this.env.ACCESS_CLIENT_SECRET, this.env.OPERATIONS_TOKEN],
    () => this.touch(true),
    () => this.env.TRACE_PAYLOADS === "true",
  );
  private aiOptions() {
    const run = this.read<Run>("run");
    return {
      binding: this.env.AI, id: this.env.AI_GATEWAY,
      skipCache: true, collectLog: true, requestTimeoutMs: 120_000,
      retries: { maxAttempts: 2, backoff: "exponential" as const, retryDelayMs: 1000 },
      // Exactly five custom metadata fields. Never use Cloudflare's reserved cf.* namespace.
      metadata: {
        application: "perceptor", collectionId: run?.window.collectionId ?? "uninitialized",
        promptVersion: PROMPT_VERSION, deploymentVersion: this.env.VERSION?.id ?? "local", phase: "research",
      },
      // Keep usage/correlation metadata without copying public source text into Gateway payload logs.
      headers: { "cf-aig-collect-log-payload": "false" },
    };
  }
  private harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.telemetry.provider(createAI(this.aiOptions()).provider,
        (eventId) => createAI({ ...this.aiOptions(), eventId }).provider));
      const searchSource = createAIWebSearch({ binding: this.env.AI, gateway: this.env.AI_GATEWAY, provider: "ceramic" });
      const fetchSource = createDirectWebFetch({
        binding: this.env.AI, maxBytes: 1_000_000, maxRedirects: 3,
        blockedHosts: ["api.soubiran.dev", "perceptor.soubiran.dev"],
      });
      const save: ToolRegistration<typeof SelectionSchema> = {
        name: "save_selection", parameters: SelectionSchema, replay: "safe",
        description: "Freeze the complete shortlist for human review. Zero to 20 articles; 20 is a ceiling, never a target. Quote publication-date evidence from every fetched source. Call once, then stop.",
        execute: async (input) => {
          const run = this.run();
          if (run.selection) {
            return { output: [{ type: "text", text: "Selection already saved; stop researching." }], control: { terminate: true } };
          }
          this.researchAllowed();
          const pages = this.ctx.storage.sql.exec<{ value: string }>(
            "SELECT value FROM perceptor_state WHERE key LIKE 'page:%'",
          ).toArray().map((row) => JSON.parse(row.value) as WebFetchPage);
          let selection: Selection;
          try {
            selection = validateSelection(input, run.window, pages, run.recent?.map((item) => item.url) ?? []);
          } catch (error) {
            const code = this.telemetry.error(error).errorCode ?? "validation_failed";
            this.telemetry.increment(`validation.${code}`);
            this.telemetry.event("perceptor.selection.rejected", { failureCode: code }, "warn");
            throw error;
          }
          const batch = await createBatch(run.window, selection);
          this.researchAllowed();
          this.updateRun({
            ...this.run(), selection, batch, attempts: 0, error: undefined, nextAttemptAt: undefined,
            status: selection.articles.length === 0 ? "empty" : "ready",
            finishedAt: selection.articles.length === 0 ? Date.now() : undefined,
          });
          this.telemetry.event("perceptor.selection.saved", { selectedCount: selection.articles.length, batchId: batch.batch_id });
          return { output: [{ type: "text", text: `Saved ${selection.articles.length} recommendations. Stop researching; delivery is handled by the application.` }], control: { terminate: true } };
        },
      };
      this.registry.install({
        name: "perceptor",
        sections: [{ key: "editorial", render: () => EDITORIAL_PROMPT, tag: false }],
        hooks: [hook(GenerationTask, {
          beforeRequest: () => { this.researchAllowed(); return undefined; },
          beforeProviderRequest: ({ model, payload }) => {
            if (payload === null || typeof payload !== "object") throw new PolicyError("invalid_payload", "Invalid provider payload");
            if (model.api === "openai-responses") return { payload: { ...payload, max_output_tokens: 12_000 } };
            if (model.api === "anthropic-messages") return { payload: { ...payload, max_tokens: 12_000 } };
            throw new PolicyError("unsupported_model", "Use a catalog OpenAI Responses or Anthropic Messages model with the output-budget policy");
          },
        }), hook(ToolTask, {
          // Includes invalid schema arguments and interrupted/aborted calls that never execute our tool wrapper.
          afterTool: async (call, result) => {
            for (const diagnostic of result.diagnostics ?? []) {
              this.telemetry.event("perceptor.tool.diagnostic", { tool: call.name, callId: call.id, diagnosticCode: diagnostic.code }, "warn");
              this.telemetry.increment(`toolDiagnostic.${diagnostic.code}`);
            }
            if (result.diagnostics?.some((item) => ["invalid_arguments", "tool_unavailable", "blocked", "interrupted", "restart_limit", "aborted", "abandoned"].includes(item.code ?? ""))) {
              await this.telemetry.operation(`execute_tool ${call.name}`, {
                "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": call.name,
                "gen_ai.tool.call.id": call.id, "perceptor.outcome": "not_executed",
              }, async () => { tracing.getActiveSpan()?.setStatus({ code: "error" }); });
              this.touch(true);
            }
            return undefined;
          },
        })],
        tools: [
          this.telemetry.tool(webSearchTool({
            limit: 10, maxDescriptionChars: 600, timeoutMs: 20_000,
            source: {
              ...searchSource,
              search: async (request, options) => {
                this.researchAllowed();
                const key = `search:${JSON.stringify(request)}`;
                const cached = this.read<Awaited<ReturnType<typeof searchSource.search>>>(key);
                tracing.getActiveSpan()?.setAttribute("perceptor.cache_hit", !!cached);
                if (cached) { this.telemetry.increment("searchCacheHits"); return cached; }
                this.charge("searches", MAX_SEARCHES);
                try {
                  const result = await searchSource.search(request, options);
                  this.write(key, result);
                  this.telemetry.increment("searchResults", result.items.length);
                  // The pinned search SDK has no metadata option. Its Gateway requestId is the explicit join key.
                  this.telemetry.event("perceptor.search.completed", { gatewayLogId: result.metadata.requestId, resultCount: result.items.length, durationMs: result.metadata.latencyMs });
                  return result;
                } catch (error) {
                  this.telemetry.increment("searchErrors");
                  const requestId = (error as { requestId?: unknown })?.requestId;
                  this.telemetry.event("perceptor.search.failed", { gatewayLogId: typeof requestId === "string" ? requestId.slice(0, 200) : undefined, ...this.telemetry.error(error) }, "warn");
                  throw error;
                }
              },
            },
          })),
          this.telemetry.tool(webFetchTool({
            pageChars: 16_000, timeoutMs: 20_000,
            source: {
              fetch: async (request, options) => {
                this.researchAllowed();
                const key = `page:${canonicalUrl(request.url)}:${request.format ?? "auto"}`;
                const cached = this.read<WebFetchPage>(key);
                tracing.getActiveSpan()?.setAttribute("perceptor.cache_hit", !!cached);
                if (cached) { this.telemetry.increment("fetchCacheHits"); return cached; }
                this.charge("fetches", MAX_FETCHES);
                const startedAt = Date.now();
                try {
                  const page = await fetchSource.fetch(request, options);
                  if (page.content.length > 160_000) throw new PolicyError("page_too_long", "Page too long; choose another source");
                  this.write(key, page);
                  this.telemetry.increment(page.status >= 200 && page.status < 300 ? "fetchSuccesses" : "fetchHttpErrors");
                  this.telemetry.event("perceptor.fetch.completed", { sourceHost: new URL(page.finalUrl).hostname, httpStatus: page.status, contentChars: page.content.length, bytes: page.bytes, durationMs: Date.now() - startedAt });
                  return page;
                } catch (error) {
                  this.telemetry.increment("fetchErrors");
                  this.telemetry.event("perceptor.fetch.failed", { sourceHost: new URL(request.url).hostname, durationMs: Date.now() - startedAt, ...this.telemetry.error(error) }, "warn");
                  throw error;
                }
              },
            },
          })),
          this.telemetry.tool(save),
        ],
      });
      return Harness.open(storage, {
        models, registry: this.registry, onWake,
        settings: {
          toolExecution: "sequential", retry: { maxRetries: 2, baseDelayMs: 1000 },
          stream: { timeoutMs: 120_000 }, restartLimit: 3, afterFailedRun: "withdraw",
        },
        onReport: (report) => {
          try {
            this.telemetry.increment(`harness.${report.kind}`);
            this.telemetry.event("perceptor.harness.failed", {
              kind: report.kind, taskId: "task" in report ? String(report.task?.id ?? "") : undefined,
              reason: "reason" in report ? report.reason : undefined,
              restarts: "restarts" in report ? report.restarts : undefined,
              ...this.telemetry.error(report.error),
            }, "error");
            this.touch(true);
          } catch {
            // storage_failed can make SQLite telemetry unavailable too. Never throw from Pi's report callback.
            console.error({ event: "perceptor.harness.failed", kind: report.kind, telemetryUnavailable: true });
          }
        },
      }, context);
    },
    // PiHarness accepts only provider/id. Resolve it against the factory's model catalog, not during read-only snapshots.
    defaults: { model: { provider: "cloudflare", id: this.env.MODEL }, maxTurns: 36, thinkingLevel: "low" },
  });
  private lifecycle = Lifecycle.install(this).use(this.harness);

  onStart(): void { this.initialize(); }

  private initialize(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS perceptor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.initialized = true;
  }

  private read<T>(key: string): T | undefined {
    this.initialize();
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM perceptor_state WHERE key = ?", key).toArray()[0];
    return row ? JSON.parse(row.value) as T : undefined;
  }

  private write(key: string, value: unknown): void {
    this.initialize();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO perceptor_state (key, value) VALUES (?, ?)", key, JSON.stringify(value));
  }

  private run(): Run {
    const run = this.read<Run>("run");
    if (!run) throw new PolicyError("uninitialized_run", "Research run not initialized");
    return run;
  }

  private touch(progress: boolean): void {
    const run = this.read<Run>("run");
    if (!run) return;
    const versions = this.read<ExecutionVersion[]>("telemetry:versions") ?? [];
    const version = { deploymentVersion: this.env.VERSION?.id ?? "local", promptVersion: PROMPT_VERSION, model: run.model ?? this.env.MODEL };
    if (!versions.some((item) => JSON.stringify(item) === JSON.stringify(version))) {
      versions.push(version);
      this.write("telemetry:versions", versions);
    }
    const clock = this.read<Clock>("telemetry:clock");
    const now = Date.now();
    this.write("telemetry:clock", { revision: (clock?.revision ?? 0) + 1, updatedAt: now, progressAt: progress ? now : clock?.progressAt ?? run.startedAt });
    const summary = this.snapshotValue();
    if (summary) {
      if (TERMINAL.has(summary.status)) {
        this.telemetry.event("perceptor.run.summary", {
          status: summary.status, revision: summary.revision, durationMs: summary.durationMs,
          selectedCount: summary.selectedCount, failureCode: summary.failureCode,
          inputTokens: summary.stats.inputTokens, outputTokens: summary.stats.outputTokens,
          modelCostUsd: summary.stats.modelCostUsd, searches: summary.stats.counters.searches ?? 0,
          fetches: summary.stats.counters.fetches ?? 0, modelRequests: summary.stats.counters.modelRequests ?? 0,
        });
      }
      this.ctx.waitUntil((async () => {
        await this.env.OBSERVATIONS.getByName(MONITOR_NAME).record(summary);
      })().catch((error: unknown) => {
        this.telemetry.event("perceptor.summary.publish_failed", this.telemetry.error(error), "error");
      }));
    }
  }

  private updateRun(run: Run): void {
    const previous = this.read<Run>("run");
    this.write("run", run);
    this.touch(true);
    if (previous?.status !== run.status) this.telemetry.event("perceptor.run.transition", { previousStatus: previous?.status, status: run.status });
    if (TERMINAL.has(run.status) && previous?.status !== run.status) {
      this.telemetry.event(`perceptor.${run.status}`, { status: run.status, batchId: run.batch?.batch_id, selectedCount: run.selection?.articles.length ?? 0, failureCode: run.failureCode, durationMs: (run.finishedAt ?? Date.now()) - run.startedAt }, run.status === "failed" ? "error" : "log");
      // Persisted status prevents repeat terminal logs on ordinary duplicate delivery/control invocations.
      // Logs remain best effort across crashes; the durable summary is authoritative.
    }
  }

  private snapshotValue(): RunSummary | null {
    const run = this.read<Run>("run");
    if (!run) return null;
    const clock = this.read<Clock>("telemetry:clock");
    return {
      schemaVersion: 1, collectionId: run.window.collectionId, conversationId: "1",
      deploymentVersion: run.deploymentVersion ?? "legacy", promptVersion: run.promptVersion ?? "legacy", model: run.model ?? this.env.MODEL,
      executionVersions: this.read<ExecutionVersion[]>("telemetry:versions") ?? [],
      revision: clock?.revision ?? 0, scheduledTime: run.scheduledTime ?? Number(run.window.collectionId.slice(10)),
      startedAt: run.startedAt ?? run.deadline - RESEARCH_MS,
      updatedAt: clock?.updatedAt ?? run.startedAt ?? run.deadline - RESEARCH_MS, progressAt: clock?.progressAt ?? run.startedAt ?? run.deadline - RESEARCH_MS,
      finishedAt: run.finishedAt, nextAttemptAt: run.nextAttemptAt, status: run.status,
      durationMs: (run.finishedAt ?? Date.now()) - (run.startedAt ?? run.deadline - RESEARCH_MS),
      batchId: run.batch?.batch_id, selectedCount: run.selection?.articles.length ?? 0,
      articles: run.selection?.articles.map((item) => ({ url: item.link, sourceHost: new URL(item.link).hostname })) ?? [],
      failureCode: run.failureCode, phaseAttempts: run.attempts, lastError: run.error, stats: this.telemetry.stats(),
    };
  }

  /** Protected by service binding/RPC; these methods are never exposed as public triggers. */
  async snapshot(): Promise<RunSummary | null> { return this.snapshotValue(); }
  async evidence() { return this.read<Run>("run")?.selection ?? null; }

  async purge(now: number): Promise<boolean> {
    const run = this.read<Run>("run");
    if (!run) return true;
    const scheduledTime = run.scheduledTime ?? Number(run.window.collectionId.slice(10));
    if (!TERMINAL.has(run.status) || now - Math.max(scheduledTime, run.finishedAt ?? scheduledTime) < SUMMARY_RETENTION_MS) return false;
    // Follow Lifecycle's teardown contract so no late wake callback can rearm an alarm.
    await this.lifecycle.disableAlarms();
    await this.lifecycle.dispose();
    await this.ctx.storage.deleteAll();
    this.initialized = false;
    // A tiny tombstone prevents old internal redispatches resurrecting an expired run.
    this.write("purged", { collectionId: run.window.collectionId, at: now });
    return true;
  }

  private researchAllowed(): void {
    const run = this.run();
    if (run.status !== "researching") throw new PolicyError("research_closed", "Research closed");
    if (Date.now() >= run.deadline) throw new PolicyError("research_deadline", "Research deadline exceeded");
  }

  private charge(key: string, max: number): void {
    const count = this.read<number>(key) ?? 0;
    if (count >= max) {
      this.telemetry.increment(`budgetExhausted.${key}`);
      throw new PolicyError(`${key}_budget`, `${key} budget exhausted; save only already verified candidates`);
    }
    // Reserve before network I/O, including failed/replayed attempts.
    this.write(key, count + 1);
    this.telemetry.increment(key);
  }

  async begin(scheduledTime: number) {
    if (this.read("purged")) throw new PolicyError("run_expired", "Expired collections cannot be restarted");
    const window = reportingWindow(scheduledTime);
    let run = this.read<Run>("run");
    if (!run) {
      run = {
        window, scheduledTime, startedAt: Date.now(), promptVersion: PROMPT_VERSION,
        deploymentVersion: this.env.VERSION?.id ?? "local", model: this.env.MODEL, status: "preparing", deadline: Date.now() + RESEARCH_MS, attempts: 0,
      };
      this.updateRun(run);
      this.telemetry.event("perceptor.run.started", { scheduledTime, scheduleLagMs: Date.now() - scheduledTime });
    }
    if (run.window.collectionId !== window.collectionId) throw new PolicyError("identity_mismatch", "Run identity mismatch");
    if (ACTIVE.has(run.status)) {
      try {
        if (!this.env.ACCESS_CLIENT_ID || !this.env.ACCESS_CLIENT_SECRET) throw new PolicyError("missing_credentials", "Configure the API Access service token before enabling research");
        await this.lifecycle.start();
        await this.lifecycle.jobs.push({ id: "control", fn: "control", time: Date.now(), singleflight: true });
      } catch (error) {
        this.fail(this.run(), error, "startup_failed");
        throw new PolicyError("startup_failed", "Research startup failed; inspect the protected run summary");
      }
    }
    return { collectionId: window.collectionId, status: this.run().status };
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== "control") return;
    return this.telemetry.operation("perceptor.control", {}, () => this.control());
  }

  private async control(): Promise<LifecycleJobOutcome> {
    let run = this.run();
    if (!ACTIVE.has(run.status)) return;
    this.touch(false);
    try {
      if (run.status === "ready") return await this.deliver(run);
      if (Date.now() >= run.deadline) {
        this.fail(run, new PolicyError("research_deadline", "Research deadline exceeded"));
        await this.harness.abort();
        return;
      }
      if (run.status === "preparing") {
        const recent = run.recent ?? await this.telemetry.operation("perceptor.prepare", {}, () => recentNews());
        run = { ...this.run(), recent, status: "researching", attempts: 0, nextAttemptAt: undefined, error: undefined };
        this.updateRun(run);
      }
      await this.harness.submit([
        `Research articles published on or after ${run.window.start.slice(0, 10)} and strictly before ${run.window.end.slice(0, 10)} (UTC dates).`,
        `Maximum 40 searches, 40 source fetches, 36 tool rounds, and 20 minutes. At most 20 recommendations; zero is valid.`,
        `Already published news (untrusted reference data; do not resubmit these URLs):`,
        `<untrusted_recent_news>${JSON.stringify(run.recent ?? [])}</untrusted_recent_news>`,
      ].join("\n"), { operationId: run.window.collectionId, entry: { kind: "perceptor.weekly", data: run.window } });
      const latest = this.run();
      if (latest.status === "empty") return;
      if (latest.status === "researching" && (await this.harness.pending()).length === 0) {
        const result = await this.harness.wait(run.window.collectionId);
        this.fail(latest, new PolicyError(result.reason ?? "no_selection", "Agent finished without saving a validated selection"));
        return;
      }
      return { rescheduleAt: Date.now() + 30_000 };
    } catch (error) {
      run = this.run();
      if (!ACTIVE.has(run.status)) return;
      const attempts = run.attempts + 1;
      if (attempts >= 3) { this.fail({ ...run, attempts }, error, "control_retries_exhausted"); return; }
      const nextAttemptAt = Date.now() + attempts * 60_000;
      this.telemetry.event("perceptor.retry.scheduled", { phase: run.status, attempt: attempts, nextAttemptAt, ...this.telemetry.error(error) }, "warn");
      this.telemetry.increment("controlRetries");
      this.updateRun({ ...run, attempts, nextAttemptAt, error: this.telemetry.error(error).errorMessage });
      return { rescheduleAt: nextAttemptAt };
    }
  }

  private async deliver(run: Run): Promise<LifecycleJobOutcome> {
    if (!run.batch) { this.fail(run, new PolicyError("missing_batch", "Missing frozen delivery batch")); return; }
    const batch = run.batch;
    const attempts = run.attempts + 1;
    this.updateRun({ ...run, attempts, nextAttemptAt: undefined });
    this.telemetry.increment("deliveryAttempts");
    this.telemetry.event("perceptor.delivery.started", { batchId: batch.batch_id, attempt: attempts });
    try {
      const acknowledgement = await this.telemetry.operation("perceptor.deliver", { "perceptor.batch_id": batch.batch_id, "perceptor.attempt": attempts }, () => deliverBatch(batch, {
        clientId: this.env.ACCESS_CLIENT_ID, clientSecret: this.env.ACCESS_CLIENT_SECRET,
      }));
      this.updateRun({ ...this.run(), acknowledgement, status: "delivered", finishedAt: Date.now(), nextAttemptAt: undefined, error: undefined });
    } catch (error) {
      if (attempts >= MAX_DELIVERY_ATTEMPTS || error instanceof DeliveryError && !error.retryable) {
        this.fail(this.run(), error, "delivery_failed");
        return;
      }
      const nextAttemptAt = Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
      this.telemetry.increment("deliveryRetries");
      this.telemetry.event("perceptor.retry.scheduled", { phase: "delivery", batchId: batch.batch_id, attempt: attempts, nextAttemptAt, ...this.telemetry.error(error) }, "warn");
      this.updateRun({ ...this.run(), nextAttemptAt, error: this.telemetry.error(error).errorMessage });
      return { rescheduleAt: nextAttemptAt };
    }
  }

  private fail(run: Run, error: unknown, fallbackCode = "research_failed"): void {
    const details = this.telemetry.error(error);
    this.telemetry.event("perceptor.error", { phase: run.status, attempt: run.attempts, ...details }, "error");
    this.updateRun({ ...run, status: "failed", error: details.errorMessage, failureCode: details.errorCode ?? fallbackCode, finishedAt: Date.now(), nextAttemptAt: undefined });
  }
}
