import { describe, expect, it } from "vite-plus/test";
import type { WebFetchPage } from "agents/webfetch";
import { reportingWindow } from "../src/editorial.ts";
import { canonicalUrl, createBatch, validateSelection, type Selection } from "../src/selection.ts";

const window = reportingWindow(Date.parse("2026-11-09T08:00:00Z"));
function fixture(count = 1) {
  const selection: Selection = {
    reason: count ? "Original engineering evidence worth reading." : "No verified articles met the quality bar.",
    articles: Array.from({ length: count }, (_, i) => ({
      title: `Engineering report ${i}`, link: `https://example.com/report-${i}`,
      description: "The team explains its agent-memory design and the cost of repairing stale notes.",
      publishedAt: "2026-11-06", dateEvidence: "Published November 6, 2026",
      relevance: "A concrete memory mechanism with operational trade-offs.",
    })),
  };
  const pages: WebFetchPage[] = selection.articles.map((article) => ({
    url: article.link, finalUrl: article.link, status: 200, contentType: "text/markdown", via: "text",
    content: "# Engineering report\nPublished November 6, 2026\nAn original technical report.",
    totalChars: 90, bytes: 90, headers: {}, redirects: [],
  }));
  return { selection, pages };
}

describe("weekly editorial selection", () => {
  it("uses seven complete UTC days with a stable dispatch identity", () => {
    expect(window).toEqual({
      start: "2026-11-02T00:00:00.000Z", end: "2026-11-09T00:00:00.000Z",
      collectionId: "discovery-1794211200000",
    });
    expect(() => reportingWindow(Number.NaN)).toThrow("Invalid scheduled time");
  });

  it.each([0, 1, 11, 20])("accepts %i recommendations without a quota", (count) => {
    const { selection, pages } = fixture(count);

    expect(validateSelection(selection, window, pages, []).articles).toHaveLength(count);
  });

  it("rejects a twenty-first recommendation", () => {
    const { selection, pages } = fixture(21);

    expect(() => validateSelection(selection, window, pages, [])).toThrow("at most 20");
  });

  it.each(["2026-11-01", "2026-11-09", "2026-11-10", "2026-02-30"])("rejects invalid or out-of-window date %s", (date) => {
    const { selection, pages } = fixture();
    selection.articles[0].publishedAt = date;

    expect(() => validateSelection(selection, window, pages, [])).toThrow("publication date");
  });

  it("requires publication evidence from a successfully fetched canonical source", () => {
    const { selection, pages } = fixture();

    expect(() => validateSelection(selection, window, [], [])).toThrow("publication-date evidence");
    pages[0].status = 403;
    expect(() => validateSelection(selection, window, pages, [])).toThrow("publication-date evidence");
    pages[0].status = 200;
    selection.articles[0].dateEvidence = "An invented date snippet";
    expect(() => validateSelection(selection, window, pages, [])).toThrow("publication-date evidence");
  });

  it("rejects duplicate and previously published links after normalization", () => {
    const { selection, pages } = fixture(2);
    selection.articles[1].link = `${selection.articles[0].link}?utm_source=email#section`;

    expect(() => validateSelection(selection, window, pages, [])).toThrow("Duplicate");
    const single = fixture();
    expect(() => validateSelection(single.selection, window, single.pages, ["https://example.com/report-0?utm_medium=email"])).toThrow("previously published");
  });

  it("keeps semantic query parameters while removing tracking and fragments", () => {
    expect(canonicalUrl("https://example.com/report?id=42&utm_source=email#section")).toBe("https://example.com/report?id=42");
    expect(canonicalUrl("https://x.com/person/article/123?s=46&t=token&lang=en")).toBe("https://x.com/person/article/123?lang=en");
  });

  it.each(["file:///tmp/article", "http://127.0.0.1/article", "http://localhost/article", "https://user:secret@example.com/article", "https://example.com:8443/article"])("rejects unsafe URL %s", (url) => {
    expect(() => canonicalUrl(url)).toThrow();
  });

  it("freezes a stable API batch without leaking research evidence into the submission", async () => {
    const { selection, pages } = fixture();
    const validated = validateSelection(selection, window, pages, []);

    const first = await createBatch(window, validated);
    const retry = await createBatch(window, validated);

    expect(retry).toEqual(first);
    expect(first.batch_id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.articles).toEqual([{
      title: "Engineering report 0", link: "https://example.com/report-0",
      description: "The team explains its agent-memory design and the cost of repairing stale notes.",
    }]);
    expect((await createBatch(window, { ...validated, articles: [] })).batch_id).not.toBe(first.batch_id);
  });
});
