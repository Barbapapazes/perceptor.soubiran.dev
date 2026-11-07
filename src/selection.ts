import { arr, compile, obj, str, type Static } from "@earendil-works/pi-schema";
import { isPrivateOrLocalHost, type WebFetchPage } from "agents/webfetch";
import { MAX_ARTICLES } from "./editorial.ts";

export const SelectionSchema = obj({
  reason: str({ minLength: 1, maxLength: 1000 }),
  articles: arr(
    obj({
      title: str({ minLength: 1, maxLength: 500 }),
      link: str({ minLength: 1, maxLength: 2000 }),
      description: str({ minLength: 1, maxLength: 500 }),
      publishedAt: str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      dateEvidence: str({ minLength: 4, maxLength: 300 }),
      relevance: str({ minLength: 1, maxLength: 500 }),
    }),
    { maxItems: MAX_ARTICLES },
  ),
});
export type Selection = Static<typeof SelectionSchema>;
export type Article = Pick<Selection["articles"][number], "title" | "link" | "description">;
export type Window = { start: string; end: string; collectionId: string };
export class SelectionError extends Error {
  readonly name = "SelectionError";
  constructor(readonly code: string, message: string) { super(message); }
}
const selectionValidator = compile(SelectionSchema);
const tracking = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "twclid", "ttclid",
  "igshid", "li_fat_id", "mc_cid", "mc_eid", "_ga", "_gl", "ref_src", "ref_url",
]);

export function canonicalUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new SelectionError("invalid_url", "Only public HTTP(S) article URLs are accepted"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
    isPrivateOrLocalHost(url.hostname) || url.port && !["80", "443"].includes(url.port)) {
    throw new SelectionError("invalid_url", "Only public HTTP(S) article URLs are accepted");
  }
  url.hash = "";
  const isX = ["x.com", "www.x.com"].includes(url.hostname);
  for (const key of [...url.searchParams.keys()]) {
    const name = key.toLowerCase();
    if (name.startsWith("utm_") || tracking.has(name) || isX && ["s", "t"].includes(name)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

export function validateSelection(
  value: unknown,
  window: Window,
  pages: WebFetchPage[],
  knownUrls: string[],
): Selection {
  if (!selectionValidator.check(value)) throw new SelectionError("invalid_selection_schema", "Invalid selection; at most 20 complete articles are allowed");
  const seen = new Set(knownUrls.map(canonicalUrl));
  const articles = value.articles.map((article) => {
    const link = canonicalUrl(article.link);
    if (seen.has(link)) throw new SelectionError("duplicate_article", "Duplicate or previously published article");
    seen.add(link);
    const day = new Date(`${article.publishedAt}T00:00:00.000Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== article.publishedAt ||
      article.publishedAt < window.start.slice(0, 10) || article.publishedAt >= window.end.slice(0, 10)) {
      throw new SelectionError("outside_window", "Article publication date is outside the reporting window");
    }
    const page = pages.find((page) => page.status >= 200 && page.status < 300 &&
      canonicalUrl(page.finalUrl) === link && page.content.includes(article.dateEvidence));
    if (!page) throw new SelectionError("missing_date_evidence", "Read the canonical source and quote its publication-date evidence before selecting it");
    if (![article.title, article.description, article.relevance].every((text) => text.trim().length > 0)) {
      throw new SelectionError("blank_fields", "Article fields must not be blank");
    }
    return { ...article, link, title: article.title.trim(), description: article.description.trim() };
  });
  return { reason: value.reason, articles };
}

export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createBatch(window: Window, selection: Selection) {
  const articles: Article[] = selection.articles.map(({ title, link, description }) => ({ title, link, description }));
  const batch_id = await sha256(JSON.stringify({ collection_id: window.collectionId, articles }));
  return { collection_id: window.collectionId, batch_id, articles };
}
export type Batch = Awaited<ReturnType<typeof createBatch>>;
