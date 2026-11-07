import { describe, expect, it, vi } from "vite-plus/test";
import { DeliveryError, SUBMISSION_URL, deliverBatch, recentNews } from "../src/api.ts";
import type { Batch } from "../src/selection.ts";

const batch: Batch = {
  collection_id: "discovery-1794211200000", batch_id: "a".repeat(64),
  articles: [{ title: "Engineering report", link: "https://example.com/report", description: "A factual description." }],
};
const credentials = { clientId: "test.access", clientSecret: "test-secret" };
function acknowledgement() {
  return Response.json({ ...batch, articles: [{ id: "news-id", url: batch.articles[0].link }] });
}

describe("discovery delivery", () => {
  it("sends Access credentials only to the fixed internal endpoint with stable retry content", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => acknowledgement());

    await deliverBatch(batch, credentials, request);
    await deliverBatch(batch, credentials, request);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe(SUBMISSION_URL);
    const options = request.mock.calls[0][1];
    const headers = new Headers(options?.headers);
    expect(headers.get("CF-Access-Client-Id")).toBe("test.access");
    expect(headers.get("CF-Access-Client-Secret")).toBe("test-secret");
    expect(headers.get("Idempotency-Key")).toBe(batch.batch_id);
    expect(options?.redirect).toBe("error");
    expect(options?.body).toBe(JSON.stringify(batch));
    expect(request.mock.calls[1][1]?.body).toBe(options?.body);
  });

  it("does not POST an empty selection or send missing credentials", async () => {
    const request = vi.fn<typeof fetch>();

    await expect(deliverBatch({ ...batch, articles: [] }, credentials, request)).rejects.toThrow("Empty selections");
    await expect(deliverBatch({ ...batch, articles: Array.from({ length: 21 }, () => batch.articles[0]) }, credentials, request)).rejects.toThrow("exceed 20");
    await expect(deliverBatch(batch, { clientId: "", clientSecret: "" }, request)).rejects.toThrow("Access service token");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [400, false], [401, false], [403, false], [422, false], [408, true], [429, true], [503, true],
  ] as const)("classifies HTTP %i for delivery retry", async (status, retryable) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("error", { status }));

    await expect(deliverBatch(batch, credentials, request)).rejects.toMatchObject({ retryable, status, code: "delivery_http" });
  });

  it("retries network failures and rejects mismatched acknowledgements", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("network"));

    await expect(deliverBatch(batch, credentials, request)).rejects.toMatchObject({ retryable: true });
    request.mockResolvedValue(Response.json({ collection_id: "wrong", batch_id: batch.batch_id, articles: [] }));
    await expect(deliverBatch(batch, credentials, request)).rejects.toBeInstanceOf(DeliveryError);
  });

  it("reads public editorial references without Access credentials and bounds pagination", async () => {
    const item = { title: "An engineering essay", url: "https://example.com/essay", summary: "A specific argument about engineering judgment." };
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: Array.from({ length: 25 }, () => item) }));

    const articles = await recentNews(request);

    expect(articles).toHaveLength(75);
    expect(request).toHaveBeenCalledTimes(3);
    for (const [url, options] of request.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.soubiran\.dev\/api\/quick-news\?page=[123]$/);
      expect(new Headers(options?.headers).has("CF-Access-Client-Secret")).toBe(false);
      expect(options?.redirect).toBe("error");
    }
  });

  it("does not research blindly when the public reference feed fails", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("Unavailable", { status: 503 }));

    await expect(recentNews(request)).rejects.toThrow("Public news feed returned HTTP 503");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
