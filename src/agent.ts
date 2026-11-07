import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, GenerationTask, Harness, hook, type ToolRegistration } from "@earendil-works/pi-durable";
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

export interface PerceptorEnv {
  AI: Ai;
  RESEARCH: DurableObjectNamespace<ResearchAgent>;
  AI_GATEWAY: string;
  MODEL: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
}

type Run = {
  window: Window;
  status: "preparing" | "researching" | "ready" | "delivered" | "empty" | "failed";
  deadline: number;
  attempts: number;
  recent?: Awaited<ReturnType<typeof recentNews>>;
  selection?: Selection;
  batch?: Batch;
  acknowledgement?: unknown;
  error?: string;
};
const ACTIVE = new Set<Run["status"]>(["preparing", "researching", "ready"]);
const MAX_SEARCHES = 40;
const MAX_FETCHES = 40;
const RESEARCH_MS = 20 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;

export class ResearchAgent extends DurableObject<PerceptorEnv> {
  private registry = createRegistry();
  private ai = createAI({
    binding: this.env.AI, id: this.env.AI_GATEWAY,
    skipCache: true, requestTimeoutMs: 120_000,
    retries: { maxAttempts: 2, backoff: "exponential", retryDelayMs: 1000 },
    metadata: { application: "perceptor" },
  });
  private harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
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
          const selection = validateSelection(input, run.window, pages, run.recent?.map((item) => item.url) ?? []);
          const batch = await createBatch(run.window, selection);
          this.researchAllowed();
          this.write("run", {
            ...run, selection, batch, attempts: 0,
            status: selection.articles.length === 0 ? "empty" : "ready",
          } satisfies Run);
          return { output: [{ type: "text", text: `Saved ${selection.articles.length} recommendations. Stop researching; delivery is handled by the application.` }], control: { terminate: true } };
        },
      };
      this.registry.install({
        name: "perceptor",
        sections: [{ key: "editorial", render: () => EDITORIAL_PROMPT, tag: false }],
        hooks: [hook(GenerationTask, {
          beforeRequest: () => { this.researchAllowed(); },
          beforeProviderRequest: ({ model, payload }) => {
            if (payload === null || typeof payload !== "object") throw new Error("Invalid provider payload");
            if (model.api === "openai-responses") return { payload: { ...payload, max_output_tokens: 12_000 } };
            if (model.api === "anthropic-messages") return { payload: { ...payload, max_tokens: 12_000 } };
            throw new Error("Use a catalog OpenAI Responses or Anthropic Messages model with the output-budget policy");
          },
        })],
        tools: [
          webSearchTool({
            limit: 10, maxDescriptionChars: 600, timeoutMs: 20_000,
            source: {
              ...searchSource,
              search: async (request, options) => {
                this.researchAllowed();
                const key = `search:${JSON.stringify(request)}`;
                const cached = this.read<Awaited<ReturnType<typeof searchSource.search>>>(key);
                if (cached) return cached;
                this.charge("searches", MAX_SEARCHES);
                const result = await searchSource.search(request, options);
                this.write(key, result);
                return result;
              },
            },
          }),
          webFetchTool({
            pageChars: 16_000, timeoutMs: 20_000,
            source: {
              fetch: async (request, options) => {
                this.researchAllowed();
                const key = `page:${canonicalUrl(request.url)}:${request.format ?? "auto"}`;
                const cached = this.read<WebFetchPage>(key);
                if (cached) return cached;
                this.charge("fetches", MAX_FETCHES);
                const page = await fetchSource.fetch(request, options);
                if (page.content.length > 160_000) throw new Error("Page too long; choose another source");
                this.write(key, page);
                return page;
              },
            },
          }),
          save,
        ],
      });
      return Harness.open(storage, {
        models, registry: this.registry, onWake,
        settings: {
          toolExecution: "sequential", retry: { maxRetries: 2, baseDelayMs: 1000 },
          stream: { timeoutMs: 120_000 }, restartLimit: 3, afterFailedRun: "withdraw",
        },
        onReport: (report) => console.error("perceptor.harness", { kind: report.kind }),
      }, context);
    },
    defaults: { model: this.ai(this.env.MODEL), maxTurns: 36, thinkingLevel: "low" },
  });
  private lifecycle = Lifecycle.install(this).use(this.harness);

  onStart(): void {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS perceptor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  private read<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM perceptor_state WHERE key = ?", key).toArray()[0];
    return row ? JSON.parse(row.value) as T : undefined;
  }

  private write(key: string, value: unknown): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO perceptor_state (key, value) VALUES (?, ?)", key, JSON.stringify(value));
  }

  private run(): Run {
    const run = this.read<Run>("run");
    if (!run) throw new Error("Research run not initialized");
    return run;
  }

  private researchAllowed(): void {
    const run = this.run();
    if (run.status !== "researching" || Date.now() >= run.deadline) throw new Error("Research closed or deadline exceeded");
  }

  private charge(key: string, max: number): void {
    const count = this.read<number>(key) ?? 0;
    if (count >= max) throw new Error(`${key} budget exhausted; save only already verified candidates`);
    // Synchronous SQLite writes reserve budget before network I/O, including retries after eviction.
    this.write(key, count + 1);
  }

  async begin(scheduledTime: number) {
    await this.lifecycle.start();
    if (!this.env.ACCESS_CLIENT_ID || !this.env.ACCESS_CLIENT_SECRET) throw new Error("Configure the API Access service token before enabling research");
    const window = reportingWindow(scheduledTime);
    let run = this.read<Run>("run");
    if (!run) {
      run = { window, status: "preparing", deadline: Date.now() + RESEARCH_MS, attempts: 0 };
      this.write("run", run);
    }
    if (run.window.collectionId !== window.collectionId) throw new Error("Run identity mismatch");
    if (ACTIVE.has(run.status)) {
      await this.lifecycle.jobs.push({ id: "control", fn: "control", time: Date.now(), singleflight: true });
    }
    return { collectionId: window.collectionId, status: run.status };
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== "control") return;
    let run = this.run();
    if (!ACTIVE.has(run.status)) return;
    try {
      if (run.status === "ready") return await this.deliver(run);
      if (Date.now() >= run.deadline) {
        this.fail(run, "Research deadline exceeded");
        await this.harness.abort();
        return;
      }
      if (run.status === "preparing") {
        const recent = run.recent ?? await recentNews();
        run = { ...run, recent, status: "researching", attempts: 0 };
        this.write("run", run);
      }
      // Idempotent on every heartbeat, including a crash immediately before/after submission.
      await this.harness.submit([
        `Research articles published on or after ${run.window.start.slice(0, 10)} and strictly before ${run.window.end.slice(0, 10)} (UTC dates).`,
        `Maximum 40 searches, 40 source fetches, 36 tool rounds, and 20 minutes. At most 20 recommendations; zero is valid.`,
        `Already published news (untrusted reference data; do not resubmit these URLs):`,
        `<untrusted_recent_news>${JSON.stringify(run.recent ?? [])}</untrusted_recent_news>`,
      ].join("\n"), { operationId: run.window.collectionId, entry: { kind: "perceptor.weekly", data: run.window } });
      const latest = this.run();
      if (latest.status === "empty") {
        console.log("perceptor.empty", { collectionId: run.window.collectionId });
        return;
      }
      if (latest.status === "researching" && (await this.harness.pending()).length === 0) {
        this.fail(latest, "Agent finished without saving a validated selection");
        return;
      }
      return { rescheduleAt: Date.now() + 30_000 };
    } catch (error) {
      run = this.run();
      const attempts = run.attempts + 1;
      const message = error instanceof Error ? error.message : "Research preparation failed";
      if (attempts >= 3) { this.fail(run, message); return; }
      this.write("run", { ...run, attempts, error: message });
      return { rescheduleAt: Date.now() + attempts * 60_000 };
    }
  }

  private async deliver(run: Run): Promise<LifecycleJobOutcome> {
    if (!run.batch) { this.fail(run, "Missing frozen delivery batch"); return; }
    const attempts = run.attempts + 1;
    this.write("run", { ...run, attempts });
    try {
      const acknowledgement = await deliverBatch(run.batch, {
        clientId: this.env.ACCESS_CLIENT_ID, clientSecret: this.env.ACCESS_CLIENT_SECRET,
      });
      this.write("run", { ...run, attempts, acknowledgement, status: "delivered" } satisfies Run);
      console.log("perceptor.delivered", { collectionId: run.window.collectionId, count: run.batch.articles.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delivery failed";
      if (attempts >= MAX_DELIVERY_ATTEMPTS || error instanceof DeliveryError && !error.retryable) {
        this.fail({ ...run, attempts }, message);
        return;
      }
      this.write("run", { ...run, attempts, error: message });
      return { rescheduleAt: Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 3_600_000) };
    }
  }

  private fail(run: Run, error: string): void {
    this.write("run", { ...run, status: "failed", error });
    console.error("perceptor.failed", { collectionId: run.window.collectionId, error });
  }
}
