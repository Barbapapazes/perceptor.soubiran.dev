import { MAX_ARTICLES } from "./editorial.ts";
import type { Batch } from "./selection.ts";

const ORIGIN = "https://api.soubiran.dev";
export const SUBMISSION_URL = `${ORIGIN}/api/internal/quick-news-submissions`;

export class DeliveryError extends Error {
  readonly name = "DeliveryError";
  constructor(message: string, readonly retryable: boolean, readonly code = "delivery_error", readonly status?: number) {
    super(message);
  }
}

export async function boundedJson(response: Response, maxBytes = 1_000_000): Promise<unknown> {
  if (!response.body) throw new Error("Missing JSON response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("JSON response exceeds size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function recentNews(request: typeof fetch = fetch): Promise<{ title: string; url: string; summary: string }[]> {
  const articles: { title: string; url: string; summary: string }[] = [];
  for (let page = 1; page <= 3; page++) {
    const response = await request(`${ORIGIN}/api/quick-news?page=${page}`, {
      redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Public news feed returned HTTP ${response.status}`);
    const body = await boundedJson(response) as { data?: unknown[] };
    if (!Array.isArray(body.data)) throw new Error("Invalid public news feed");
    for (const value of body.data.slice(0, 25)) {
      const item = value as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.url !== "string" || typeof item.summary !== "string") {
        throw new Error("Invalid public news article");
      }
      articles.push({ title: item.title.slice(0, 500), url: item.url, summary: item.summary.slice(0, 500) });
    }
    if (body.data.length < 25) break;
  }
  return articles;
}

export async function deliverBatch(
  batch: Batch,
  credentials: { clientId: string; clientSecret: string },
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (batch.articles.length === 0) throw new DeliveryError("Empty selections must not be sent to the API", false);
  if (batch.articles.length > MAX_ARTICLES) throw new DeliveryError("A batch cannot exceed 20 articles", false);
  if (!credentials.clientId || !credentials.clientSecret) throw new DeliveryError("Missing Access service token", false);
  let response: Response;
  try {
    response = await request(SUBMISSION_URL, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        "CF-Access-Client-Id": credentials.clientId,
        "CF-Access-Client-Secret": credentials.clientSecret,
        "Idempotency-Key": batch.batch_id,
      },
      body: JSON.stringify(batch),
    });
  } catch {
    throw new DeliveryError("Submission network failure (or unexpected redirect)", true, "delivery_network");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new DeliveryError(`Submission returned HTTP ${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500, "delivery_http", response.status);
  }
  const result = await boundedJson(response) as { batch_id?: string; collection_id?: string; articles?: { id?: string; url?: string }[] };
  if (result.batch_id !== batch.batch_id || result.collection_id !== batch.collection_id ||
    !Array.isArray(result.articles) || result.articles.length !== batch.articles.length ||
    !result.articles.every((item, index) => typeof item.id === "string" && item.url === batch.articles[index].link)) {
    throw new DeliveryError("Submission acknowledgement does not match the batch", true, "delivery_acknowledgement");
  }
  return result;
}
