import { tracing } from "cloudflare:workers";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { ToolRegistration } from "@earendil-works/pi-durable";

export const PROMPT_VERSION = "2026-11-07.1";
export const TERMINAL = new Set(["delivered", "empty", "failed"]);
export const SUMMARY_RETENTION_MS = 180 * 86_400_000;
export type Fields = Record<string, string | number | boolean | undefined>;
export type RunStats = {
  counters: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelCostUsd: number;
  providerCostResponses: number;
};
export function emptyStats(): RunStats {
  return { counters: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelCostUsd: 0, providerCostResponses: 0 };
}
export type Identity = {
  collectionId: string;
  conversationId: string;
  deploymentVersion: string;
  promptVersion: string;
  model: string;
};
export type ExecutionVersion = { deploymentVersion: string; promptVersion: string; model: string };
export type RunSummary = Identity & {
  executionVersions: ExecutionVersion[];
  schemaVersion: 1;
  revision: number;
  scheduledTime: number;
  startedAt: number;
  updatedAt: number;
  progressAt: number;
  finishedAt?: number;
  nextAttemptAt?: number;
  status: "preparing" | "researching" | "ready" | "delivered" | "empty" | "failed";
  durationMs: number;
  batchId?: string;
  selectedCount: number;
  articles: { url: string; sourceHost: string }[];
  failureCode?: string;
  phaseAttempts: number;
  lastError?: string;
  stats: RunStats;
};

/** Never serialize arbitrary errors, provider bodies, diagnostic objects or headers. */
export function safeError(error: unknown, secrets: readonly string[] = []) {
  const value = error instanceof Error ? error : new Error("Non-Error failure");
  const clean = (input: string) => {
    let result = input;
    for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/https?:\/\/[^\s<>"']+/g, "[URL]")
      .replace(/(?:bearer|authorization|api[_-]?key|client[_-]?secret)\s*[:=]?\s*\S+/gi, "[REDACTED]")
      .slice(0, 2000);
  };
  const details = error as { code?: unknown; status?: unknown; retryable?: unknown } | undefined;
  return {
    errorName: clean(value.name),
    // Unknown SDK errors can echo fetched content. Keep their stack locations, not their message.
    errorMessage: value.name === "SelectionError" || value.name === "DeliveryError" || value.name === "PolicyError"
      ? clean(value.message) : "Operation failed; inspect the protected durable transcript or Gateway log",
    errorStack: clean((value.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 8).join("\n")),
    errorCode: typeof details?.code === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(clean(details.code)) ? clean(details.code) : undefined,
    httpStatus: typeof details?.status === "number" ? details.status : undefined,
    retryable: typeof details?.retryable === "boolean" ? details.retryable : undefined,
  };
}

/** GenAI message parts, deliberately excluding images, private reasoning and host-side tool details. */
export function replayMessages(messages: readonly Message[]) {
  return messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "toolResult") return {
      role: "tool", parts: [{ type: "tool_call_response", id: message.toolCallId, response: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") }],
    };
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    const parts = content.flatMap<Record<string, unknown>>((part) => {
      if (part.type === "text") return [{ type: "text", content: part.text }];
      if (part.type === "toolCall") return [{ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments }];
      return [];
    });
    return { role: message.role, parts };
  });
}

export class PolicyError extends Error {
  readonly name = "PolicyError";
  constructor(readonly code: string, message: string) { super(message); }
}

/** One logger per object; storage callbacks are synchronous SQLite operations. */
export class RunTelemetry {
  constructor(
    private identity: () => Identity,
    private read: <T>(key: string) => T | undefined,
    private write: (key: string, value: unknown) => void,
    private secrets: () => readonly string[],
    private changed: () => void,
    private storePayloads: () => boolean = () => false,
  ) {}

  stats(): RunStats { return this.read<RunStats>("telemetry:stats") ?? emptyStats(); }

  increment(name: string, amount = 1): void {
    const stats = this.stats();
    stats.counters[name] = (stats.counters[name] ?? 0) + amount;
    this.write("telemetry:stats", stats);
  }

  event(event: string, fields: Fields = {}, level: "log" | "warn" | "error" = "log"): void {
    console[level]({ event, ...this.identity(), ...fields });
  }

  error(error: unknown) { return safeError(error, this.secrets()); }

  attributes(operation: string): Fields {
    const id = this.identity();
    return {
      "gen_ai.operation.name": operation,
      "gen_ai.agent.name": "perceptor",
      "gen_ai.agent.id": id.collectionId,
      "gen_ai.conversation.id": `${id.collectionId}/${id.conversationId}`,
      "perceptor.collection_id": id.collectionId,
      "perceptor.prompt_version": id.promptVersion,
      "service.version": id.deploymentVersion,
    };
  }

  private payload(span: ReturnType<typeof tracing.startSpan> | undefined, attribute: string, value: () => unknown): void {
    if (!span || !this.storePayloads()) return;
    let serialized = JSON.stringify(value()) ?? "null";
    for (const secret of this.secrets()) {
      if (secret) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    }
    // Keep valid JSON rather than clipping midway through a message. Leave room within the 64 KB span limit.
    if (new TextEncoder().encode(serialized).length > 16_384) {
      span.setAttribute(`perceptor.payload_omitted.${attribute}`, true);
      return;
    }
    span.setAttribute(attribute, serialized);
  }

  /** An invocation segment, not a span kept alive across Durable Object alarms. */
  operation<T>(name: string, fields: Fields, fn: () => Promise<T>): Promise<T> {
    return tracing.enterSpan("invoke_agent perceptor", async (agent) => {
      agent.setAttributes(this.attributes("invoke_agent"));
      return tracing.enterSpan(name, async (span) => {
        span.setAttributes({ "perceptor.collection_id": this.identity().collectionId, "perceptor.operation": name, ...fields });
        try { return await fn(); }
        catch (error) {
          span.recordException(this.error(error).errorMessage);
          span.setAttribute("error.type", this.error(error).errorCode ?? this.error(error).errorName);
          span.setStatus({ code: "error" });
          throw error;
        }
      });
    });
  }

  tool<P extends object, D extends JsonValue>(tool: ToolRegistration<P, D>): ToolRegistration<P, D> {
    return {
      ...tool,
      execute: (args, api, context) => this.operation(`execute_tool ${tool.name}`, {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool.name,
        "gen_ai.tool.call.id": api.callId,
        "perceptor.task_id": String(api.taskId),
      }, async () => {
        const startedAt = Date.now();
        this.payload(tracing.getActiveSpan(), "gen_ai.tool.call.arguments", () => args);
        this.increment(`tool.${tool.name}.attempts`);
        this.event("perceptor.tool.started", { tool: tool.name, callId: api.callId });
        try {
          const result = await tool.execute(args, api, context);
          this.payload(tracing.getActiveSpan(), "gen_ai.tool.call.result", () => result.output);
          const outcome = result.isError ? "error" : "ok";
          this.increment(`tool.${tool.name}.${outcome}`);
          tracing.getActiveSpan()?.setAttribute("perceptor.outcome", outcome);
          if (result.isError) tracing.getActiveSpan()?.setStatus({ code: "error" });
          this.event("perceptor.tool.finished", { tool: tool.name, callId: api.callId, outcome, durationMs: Date.now() - startedAt });
          return result;
        } catch (error) {
          this.increment(`tool.${tool.name}.error`);
          this.event("perceptor.tool.failed", { tool: tool.name, callId: api.callId, durationMs: Date.now() - startedAt, ...this.error(error) }, "warn");
          throw error;
        } finally { this.changed(); }
      }),
    };
  }

  /** Wrap actual provider execution, not the durable submission/queue operation. */
  provider(base: Provider, requestProvider: (eventId: string) => Provider): Provider {
    const wrap = (start: (provider: Provider) => ReturnType<Provider["streamSimple"]>, model: string, messages: readonly Message[]) =>
      tracing.startActiveSpan("invoke_agent perceptor", (agent) => {
        agent.setAttributes(this.attributes("invoke_agent"));
        return tracing.startActiveSpan(`chat ${model}`, (span) => {
          try {
            const sequence = (this.read<number>("telemetry:requestSequence") ?? 0) + 1;
            this.write("telemetry:requestSequence", sequence);
            const eventId = `${this.identity().collectionId}:model:${sequence}`;
            span.setAttributes({ ...this.attributes("chat"), "gen_ai.request.model": model, "perceptor.event_id": eventId });
            this.payload(span, "gen_ai.input.messages", () => replayMessages(messages));
            this.payload(span, "gen_ai.system_instructions", () => messages.filter((message) => message.role === "system").map((message) => {
              const text = typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("\n");
              return { type: "text", content: [text, ...Object.values(message.sections ?? {}).filter((value) => value !== null)].join("\n") };
            }));
            this.increment("modelRequests");
            this.event("perceptor.model.started", { eventId, model });
            const stream = start(requestProvider(eventId));
            // Observe result() without consuming/replacing the stream or changing cancellation semantics.
            void stream.result().then((message) => {
              this.modelResult(message, eventId);
              this.payload(span, "gen_ai.output.messages", () => replayMessages([message]));
              span.setAttributes({
                "gen_ai.provider.name": model.split("/")[0],
                "gen_ai.response.model": message.responseModel ?? message.model,
                "gen_ai.usage.input_tokens": message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
                "gen_ai.usage.output_tokens": message.usage.output,
                "perceptor.stop_reason": message.stopReason,
              });
              for (const diagnostic of message.diagnostics ?? []) {
                if (diagnostic.type !== "cloudflare" && diagnostic.type !== "cloudflare-error") continue;
                const details = diagnostic.details as Record<string, unknown> | undefined;
                for (const key of ["logId", "eventId", "traceId", "runId", "status", "code"]) {
                  const value = details?.[key];
                  if (typeof value === "string" || typeof value === "number") span.setAttribute(`cloudflare.ai_gateway.${key}`, String(value).slice(0, 200));
                }
              }
              if (message.stopReason === "error" || message.stopReason === "aborted") {
                span.setAttribute("error.type", message.stopReason);
                span.setStatus({ code: "error" });
              }
            }).catch((error: unknown) => {
              this.event("perceptor.telemetry.failed", this.error(error), "error");
              span.setStatus({ code: "error" });
            }).finally(() => { span.end(); agent.end(); });
            return stream;
          } catch (error) {
            span.recordException(this.error(error).errorMessage);
            span.setStatus({ code: "error" });
            span.end(); agent.end();
            throw error;
          }
        });
      });
    return {
      ...base,
      stream: (model, context, options) => wrap((provider) => provider.stream(model, context, options), model.id, context.messages),
      streamSimple: (model, context, options) => wrap((provider) => provider.streamSimple(model, context, options), model.id, context.messages),
    };
  }

  private modelResult(message: AssistantMessage, eventId: string): void {
    const stats = this.stats();
    stats.inputTokens += message.usage.input;
    stats.outputTokens += message.usage.output;
    stats.cacheReadTokens += message.usage.cacheRead;
    stats.cacheWriteTokens += message.usage.cacheWrite;
    stats.modelCostUsd += message.usage.cost.total;
    stats.providerCostResponses += message.usage.cost.totalFromProvider ? 1 : 0;
    stats.counters.modelResponses = (stats.counters.modelResponses ?? 0) + 1;
    if (["error", "aborted"].includes(message.stopReason)) stats.counters.modelErrors = (stats.counters.modelErrors ?? 0) + 1;
    this.write("telemetry:stats", stats);
    this.event("perceptor.model.finished", {
      eventId, model: message.model, stopReason: message.stopReason, durationMs: message.durationMs,
      inputTokens: message.usage.input, outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite,
      modelCostUsd: message.usage.cost.total, costFromProvider: message.usage.cost.totalFromProvider ?? false,
    }, message.stopReason === "error" ? "warn" : "log");
    this.changed();
  }
}
