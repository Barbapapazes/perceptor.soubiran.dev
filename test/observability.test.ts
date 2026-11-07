import { describe, expect, it, vi } from "vite-plus/test";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { emptyStats, PolicyError, replayMessages, RunTelemetry, safeError } from "../src/observability.ts";

function telemetry() {
  const values = new Map<string, unknown>();
  const identity = { collectionId: "discovery-1794211200000", conversationId: "1", deploymentVersion: "deployment-1", promptVersion: "prompt-1", model: "openai/example" };
  const observer = new RunTelemetry(() => identity, <T>(key: string) => values.get(key) as T | undefined, (key, value) => { values.set(key, value); }, () => ["super-private-token"], () => undefined);
  return { observer, identity, values };
}

describe("structured, privacy-safe run telemetry", () => {
  it("resumes counters from durable state rather than memory", () => {
    const { observer, values, identity } = telemetry();
    observer.increment("searches");
    observer.increment("searchResults", 10);
    const resumed = new RunTelemetry(() => identity, <T>(key: string) => values.get(key) as T | undefined, (key, value) => { values.set(key, value); }, () => [], () => undefined);
    resumed.increment("searches");
    expect(resumed.stats()).toEqual({ ...emptyStats(), counters: { searches: 2, searchResults: 10 } });
  });

  it("uses stable GenAI identity without making each collection a different agent name", () => {
    const { observer } = telemetry();
    expect(observer.attributes("chat")).toMatchObject({
      "gen_ai.operation.name": "chat", "gen_ai.agent.name": "perceptor",
      "gen_ai.agent.id": "discovery-1794211200000",
      "gen_ai.conversation.id": "discovery-1794211200000/1",
    });
  });

  it("emits one structured object with run/version correlation", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { observer, identity } = telemetry();
      observer.event("perceptor.example", { attempt: 2 });
      expect(log).toHaveBeenCalledWith({ event: "perceptor.example", ...identity, attempt: 2 });
    } finally { log.mockRestore(); }
  });

  it("does not copy arbitrary SDK messages, URLs or credentials into error telemetry", () => {
    const error = new Error("source body super-private-token https://example.com/?api_key=private");
    const details = safeError(error, ["super-private-token"]);
    expect(details.errorMessage).not.toContain("source body");
    expect(JSON.stringify(details)).not.toContain("super-private-token");
    expect(JSON.stringify(details)).not.toContain("api_key=private");
    expect(safeError(new PolicyError("research_deadline", "Research deadline exceeded"))).toMatchObject({ errorCode: "research_deadline", errorMessage: "Research deadline exceeded" });
  });

  it("observes the original provider stream without consuming or replacing it", async () => {
    const { observer } = telemetry();
    const stream = createAssistantMessageEventStream();
    const model = { id: "openai/example", api: "openai-responses", provider: "cloudflare" } as Model<"openai-responses">;
    const underlying = { streamSimple: vi.fn().mockReturnValue(stream) } as unknown as Provider;
    const provider = observer.provider(underlying, () => underlying);
    const returned = provider.streamSimple(model, { messages: [] });
    expect(returned).toBe(stream);
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: "Public answer" }], api: "openai-responses", provider: "cloudflare", model: model.id,
      timestamp: Date.now(), stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
    };
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    expect(await returned.result()).toBe(message);
    await Promise.resolve();
    expect(observer.stats()).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, modelCostUsd: 0.3, counters: { modelRequests: 1, modelResponses: 1 } });
  });

  it("does not expose private reasoning, images or tool host details in replay messages", () => {
    const messages: Message[] = [
      { role: "system", content: "Instructions are recorded separately", timestamp: 1 },
      { role: "user", content: "Find articles", timestamp: 2 },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "agents" } },
      ], timestamp: 3 } as AssistantMessage,
      { role: "toolResult", toolCallId: "call-1", toolName: "web_search", content: [{ type: "text", text: "Public result" }], details: { secretHostDetail: "never export" }, isError: false, timestamp: 4 },
    ];
    expect(replayMessages(messages)).toEqual([
      { role: "user", parts: [{ type: "text", content: "Find articles" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call-1", name: "web_search", arguments: { query: "agents" } }] },
      { role: "tool", parts: [{ type: "tool_call_response", id: "call-1", response: "Public result" }] },
    ]);
  });
});
