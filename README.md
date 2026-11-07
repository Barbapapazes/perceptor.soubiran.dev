# Perceptor

Weekly Quick News discovery with **Pi Durable on Cloudflare Workers**. Perceptor
researches, reads and selects **zero to 20 articles** for human review. **20 is a
ceiling, never a target or minimum.** It never publishes articles or starts the
existing Quick News generation pipeline.

## Editorial policy

`src/editorial.ts` defines the research brief. It was informed by read-only samples
of the production public feed (`/api/quick-news`, pages 1, 3 and 6) on 2026-11-07:

- Practical AI/agent engineering: harnesses, memory, context, orchestration,
  evaluation, cost, human judgment and operational trade-offs.
- Web development, developer tools, cloud/databases, security, useful research,
  first-hand engineering reports, postmortems and substantial technical essays.
- Original titles, including French titles; concise **English** descriptions that
  explain a specific contribution or argument and attribute vendor/author claims.
- Primary sources preferred, without excluding independent authors. No generic
  tech-news filler, forced topic quotas, hype or recycled announcements.

Before research, Perceptor snapshots up to 75 published articles from the public
feed for duplicate avoidance and editorial context. This data is untrusted reference
material, not instructions. The feed must be available; preparation retries instead
of researching blindly. The API remains the final URL-deduplication backstop.

## Execution

1. A cron fires **Monday at 08:00 UTC**, with no daylight-saving adjustment.
2. A named SQLite Durable Object is created/resumed for that scheduled event.
3. A durable control job submits an idempotent operation to `PiHarness`.
4. Native `web_search` (Ceramic via AI Gateway) and `web_fetch` tools research the
   **seven complete UTC calendar days preceding the trigger date**. The end date
   is exclusive, so a Monday run covers the previous Monday through Sunday.
5. `save_selection` validates and freezes the shortlist and its source evidence.
6. Nonempty selections become a persisted outbox batch, delivered by application
   code to `https://api.soubiran.dev/api/internal/quick-news-submissions`.
   Empty selections finish locally and make **no submission request**.

Each run has independent context, cached search responses/pages, budget counters,
selection evidence, a frozen delivery batch and its acknowledgement. Durable state
is stored in the object's SQLite database, separately from Pi's `pi_*` tables.
No filesystem workspace, shell, MCP connection, arbitrary execution, Queue,
Workflow or browser session is needed.

`GET /` returns public service metadata only. There is no public run, mutation,
transcript or credential endpoint. Internal `begin(scheduledTime)` RPC can redispatch
the same run identity; it does not overwrite completed/failed selections.

### Limits and recovery

- At most **40 search attempts**, **40 source-fetch attempts**, **36 tool rounds**
  and **12,000 output tokens per model request**. Tools execute sequentially.
- Research deadline: 20 minutes. Checked before requests/tools and by the durable
  controller; in-flight calls are bounded separately, so this is not an exact
  platform-level wall-clock cutoff.
- Native tool deadlines: 20 seconds; model request deadline: 120 seconds.
- Cached reads do not consume another network-attempt reservation. An interrupted
  uncached search/fetch can be billed again after replay and consumes another
  reservation. Failed attempts count, too.
- Source response cap: 1 MB; cached converted pages: 160,000 characters; tool
  windows: 16,000 characters. Normalization strips tracking parameters/fragments
  without discarding semantic query parameters.
- Selections require a successfully fetched canonical source, a valid publication
  date in the window, and a verbatim date-evidence snippet present in that source.
  The model still interprets what the date means; this is evidence for human review,
  not a guarantee of factual correctness or a trusted structured publisher timestamp.
- The unified Web Search API has no documented publication-date filter. Never
  substitute search snippets, retrieval time or Last-Modified for publication.
- Delivery uses identical persisted payload/hash on retries, with at most eight
  attempts and exponential backoff. Network errors, 408, 429 and 5xx are retryable;
  other non-success responses fail the run. Unexpected redirects are not followed.
- The API checks `Idempotency-Key == batch_id` and deduplicates by URL. This is not
  a transactional exactly-once guarantee across Cloudflare and the API.
- Failed runs retain state and log `perceptor.failed`; successful delivery logs
  `perceptor.delivered`; empty selections log `perceptor.empty`. Configure a Workers
  log alert for failures before unattended production use. No secrets or source
  bodies are written to these application logs.

Pi Durable is experimental. `agents@0.33.0` and the Pi packages are pinned to the
compatible `1.5.0` line. Do not roll conversation data back to an older Pi minor.
Retain per-run objects for now; add an explicit retention/deletion policy before
long-term operation. Browser fallback and late-discovered older articles are not
part of v1; unreadable or undated sources are skipped rather than guessed.

## Configuration and credentials

`cloudflare.config.ts` is the only Worker configuration. Keep the existing **cf +
Cloudflare Vite v2 + Vite+** toolchain; do not add a parallel Wrangler configuration.
The cf tooling and programmatic configuration are beta and pinned in the lockfile.

Configured bindings:

| Binding | Purpose |
| --- | --- |
| `AI` | Workers AI binding for Gateway inference/search and document conversion |
| `RESEARCH` | SQLite-backed `ResearchAgent` Durable Object |
| `AI_GATEWAY` | Gateway ID, default `perceptor` |
| `MODEL` | Catalog model, default `openai/gpt-6.1-sol` |
| `ACCESS_CLIENT_ID` | Secret: API Cloudflare Access service-token client ID |
| `ACCESS_CLIENT_SECRET` | Secret: corresponding client secret |

The output-budget hook supports catalog models using OpenAI Responses or Anthropic
Messages. Extend that policy deliberately before selecting another wire format.

Before deploying:

1. Deploy the companion API change accepting **1–20 articles per batch**. The API
   continues rejecting empty batches; Perceptor handles those locally.
2. Create the `perceptor` AI Gateway in the Worker's account. Enable authenticated
   Unified Billing with sufficient credits, or configure supported provider keys
   on the gateway. Search uses Ceramic; inference uses the configured catalog model.
   No provider key is stored in this Worker.
3. Configure Gateway spend limits and rate limits. Spend limits are eventually
   consistent and complement, rather than replace, the application budgets.
4. Create a least-privilege Cloudflare Access service token with a Service Auth
   policy for the API's internal submission endpoint. The origin must not allow an
   Access bypass. Store the two secrets using Cloudflare's dashboard/secret tooling.
   Perceptor does **not** use Laravel bearer authentication.
5. Review the cron, Gateway, model, account and observability settings, then deploy
   a CI-built artifact intentionally. No deployment is performed by installation.

Access headers are attached only to the fixed API submission URL; the model cannot
choose an authenticated destination. Public feed requests and research tools never
receive Access credentials. `web_fetch` retains the SDK's public-host/redirect
checks and blocks the API/Perceptor hosts. Those checks do not resolve public DNS
names to detect private addresses: they are not a complete DNS-rebinding defense.
External content remains untrusted even with the SDK's prompt-injection wrapper.

## Development

Requires Node.js **24.22.0** and pnpm **10.34.5**, as pinned in the repository.
Copy `.dev.vars.example` to `.dev.vars` only if deliberately enabling local service
calls. Never commit real secrets. AI/search/conversion calls use live Cloudflare
services and can incur charges; the test suite uses fakes and remote bindings are
disabled in `vitest.config.ts`.

Existing scripts remain available: `dev`, `check`, `format`, `test`, `test:watch`,
`build`, `typecheck`, `deploy:dry-run`, and `deploy`. Build artifacts in CI and deploy
the prebuilt output; do not build or run verification on the constrained Pi server.
See [cf in CI](https://developers.cloudflare.com/cf/ci/) for prebuilt deployment.

The project-local `.pi/mcp.json` configures Cloudflare's hosted MCP server at
`https://mcp.cloudflare.com/mcp` for **development**, not for the deployed agent.
Its OAuth credentials are managed by Pi outside the repository and are distinct
from cf authentication and the API Access service token.

## References

- [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/)
- [Pi extensions and replay safety](https://developers.cloudflare.com/agents/harnesses/pi/extensions/)
- [Pi AI / Gateway provider](https://developers.cloudflare.com/agents/models/pi-ai/)
- [Web search tool](https://developers.cloudflare.com/agents/tools/web-search/)
- [Web fetch tool](https://developers.cloudflare.com/agents/tools/web-fetch/)
- [Search providers and pricing](https://developers.cloudflare.com/web-search/providers/)
- [Lifecycle jobs](https://developers.cloudflare.com/agents/runtime/lifecycle/job-queue/)
- [Programmatic cf configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
