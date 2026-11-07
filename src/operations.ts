import type { PerceptorEnv } from "./agent.ts";
import { boundedJson } from "./api.ts";
import { MONITOR_NAME, parseReview } from "./monitor.ts";
import { TERMINAL } from "./observability.ts";

/** Separate, high-entropy operations credential; never reuse the API Access service token. */
export async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!token || token.length < 32 || !header.startsWith("Bearer ") || header.length > 512) return false;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [expected, actual] = await Promise.all([digest(token), digest(header.slice(7))]);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ actual[index];
  return difference === 0;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function operations(request: Request, env: PerceptorEnv): Promise<Response> {
  if (!await authorized(request, env.OPERATIONS_TOKEN)) return json({ error: "Unauthorized" }, 401);
  const url = new URL(request.url);
  const store = env.OBSERVATIONS.getByName(MONITOR_NAME);
  if (request.method === "GET" && url.pathname === "/ops/health") {
    const status = await store.status(Date.now());
    return json(status, status.healthy ? 200 : 503);
  }
  if (request.method === "GET" && url.pathname === "/ops/runs") {
    const limit = Number(url.searchParams.get("limit") ?? 26);
    if (!Number.isInteger(limit) || limit < 1 || limit > 180) return json({ error: "Invalid limit" }, 400);
    return json(await store.list(limit));
  }
  const incident = /^\/ops\/incidents\/(discovery-\d{13})\/acknowledge$/.exec(url.pathname);
  if (request.method === "POST" && incident) {
    return json({ acknowledged: await store.acknowledge(incident[1]) });
  }
  const match = /^\/ops\/runs\/(discovery-\d{13})(?:\/(evidence|review))?$/.exec(url.pathname);
  if (!match) return json({ error: "Not found" }, 404);
  const [, collectionId, action] = match;
  if (request.method === "GET" && !action) {
    const detail = await store.detail(collectionId);
    return detail ? json(detail) : json({ error: "Not found" }, 404);
  }
  if (request.method === "GET" && action === "evidence") {
    const evidence = await env.RESEARCH.getByName(collectionId).evidence();
    return evidence ? json(evidence) : json({ error: "Not found" }, 404);
  }
  if (request.method === "PUT" && action === "review") {
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "Expected application/json" }, 415);
    let review;
    try {
      review = parseReview(await boundedJson(new Response(request.body), 16_384));
    } catch { return json({ error: "Invalid review or body exceeds 16 KiB" }, 400); }
    const detail = await store.detail(collectionId);
    if (!detail || !TERMINAL.has(detail.summary.status) || detail.summary.batchId !== review.batchId || !detail.summary.articles.some((item) => item.url === review.url)) return json({ error: "Review does not match a retained terminal frozen batch" }, 409);
    return json(await store.review(collectionId, review));
  }
  return json({ error: "Not found" }, 404);
}
