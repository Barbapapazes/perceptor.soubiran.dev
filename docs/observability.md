# Observability and operations

## Architecture and Cloudflare contract

The project keeps `cloudflare.config.ts`, `cf`, Vite+ and the pinned Pi/Agents
packages. It does not introduce Wrangler configuration, an OTel collector, a second
agent framework or an experimental OTel API bridge.

Cloudflare's [Agent Tracing guide](https://developers.cloudflare.com/agents/runtime/observability/tracing/)
says Lifecycle alone does **not** instrument an agent. PiHarness is a custom harness
for this integration; `src/observability.ts` uses the documented
[Workers custom spans API](https://developers.cloudflare.com/workers/observability/traces/custom-spans/):

```text
invoke_agent perceptor
  chat <model>                  actual provider stream, through terminal result

invoke_agent perceptor
  execute_tool <tool>           actual tool execution, including returned errors

invoke_agent perceptor
  perceptor.control / prepare / deliver
```

Execution is durable, so these are **invocation/task segments**, not a single span
held open across alarms, hibernation, retries and evictions. Session identity links
segments. The Agents dashboard's span/run counts must not be interpreted as weekly
collection counts; use durable collection summaries for weekly success rates.
Model streams are observed through `result()` without consuming/replacing their
stream or changing cancellation. Spans end when the operation finishes, including
error results. An eviction can still interrupt telemetry; no lossless tracing
claim is made. Invalid, unavailable, blocked and interrupted tools also emit
coded diagnostics and non-execution spans.

All agent/model spans set:

- `gen_ai.agent.name = perceptor` (one logical implementation, never a per-run name).
- `gen_ai.agent.id = collectionId` (the stable named research object).
- `gen_ai.conversation.id = collectionId/1` (Pi root session `1`, scoped to its object).
- `gen_ai.operation.name = invoke_agent`, `chat`, or `execute_tool` as appropriate.

Model spans add request/response model, input/output tokens, stop reason and the
allowlisted Gateway correlation diagnostics. Tool spans add name and call ID.
The platform adds fetch/binding/RPC/handler spans. Automatic instrumentation does
not imply that the external Laravel API shares a distributed trace: use the stable
`batch_id`/`Idempotency-Key` to correlate delivery with API-side logs.

Configuration explicitly enables 100% logs, invocation logs, traces and Workers
Issues. Query strings are redacted from platform request URLs. Source maps are
emitted by Vite; [cf deploy uploads generated maps](https://developers.cloudflare.com/workers/observability/source-maps/).
The native Workers trace/log view and Agents tab are the primary debugging UIs.

## Events and persisted measurements

Logs are single structured JSON objects with `event`, `collectionId`, session,
model, current deployment ID and prompt version. The main event families are:

| Event | Meaning |
| --- | --- |
| `perceptor.cron.dispatched` / `.failed` | Scheduled dispatch, not completion |
| `perceptor.run.started` / `.transition` | Run identity, scheduling lag and phases |
| `perceptor.model.started` / `.finished` | Logical provider attempts, observed tokens/cost, stop reason |
| `perceptor.tool.started` / `.finished` / `.failed` / `.diagnostic` | Tool attempts, latency, errors and Pi diagnostics |
| `perceptor.search.completed` / `.failed` | Search result count, provider latency, Gateway join key |
| `perceptor.fetch.completed` / `.failed` | Source host, HTTP status and content size, never source bodies |
| `perceptor.selection.rejected` / `.saved` | Coded validation failure or frozen selection count |
| `perceptor.retry.scheduled` | Phase, attempt, sanitized error and next retry time |
| `perceptor.harness.failed` | Pi report kind, task/reason/restart context when available |
| `perceptor.lifecycle.diagnostic` | Slow dispatch, alarm memory reset, backlog warning |
| `perceptor.delivered` / `.empty` / `.failed` | One terminal transition, never a quantity quota |
| `perceptor.run.summary` | Terminal summary revisions (use newest revision per collection) |
| `perceptor.summary.publish_failed` | Long-term copy failed; watchdog can reconcile authoritative state |
| `perceptor.watchdog.checked` / `.alert` / `.resolved` / `.acknowledged` | Independent reconciliation and incidents |
| `perceptor.review.recorded` | Human feedback with source host, decision and controlled reason |

The [Lifecycle diagnostics subscriber](https://developers.cloudflare.com/agents/runtime/observability/diagnostics-channels/)
is installed once per isolate. It uses the documented raw `agents:lifecycle`
channel because the pinned SDK's typed helper omits job/alarm events. Only
allowlisted fields/events are forwarded, never entire diagnostic payloads.

Each research object persists telemetry counters, a monotonic revision, progress
clock, model usage and original run provenance beside existing evidence. A separate
`ObservationStore` object keeps compact, queryable run snapshots and review outcomes.
Out-of-order/duplicate publications cannot overwrite a newer revision. Publications
use `waitUntil`; publication failure does not silently disappear, and hourly checks
read authoritative research state to reconcile it. The store is not the source of
truth for research/delivery or a cross-system transaction.

A summary includes original prompt/deployment/model, execution version history,
schedule/start/progress/finish times, next retry, status/failure code, frozen batch,
selected source URLs/hosts, and counters for searches, results, cache hits, fetch
outcomes, tool outcomes, validation failures, retries, model attempts and responses.
Increment `PROMPT_VERSION` whenever editorial instructions or selection policy
change. Do not roll Pi data back across incompatible Pi minors. Execution versions
make deployments during a durable run visible rather than attributing everything
to the initial version.

### Cost and completeness

`modelCostUsd` is the **observed Pi model cost**: the best available provider-reported
cost or catalog estimate, with a count of provider-cost responses. It is **not the
complete bill**: search, conversion, Workers/DO usage and telemetry costs are not
included. A crash can prevent final usage recording; `modelRequests > modelResponses`
reveals incomplete observations. Never turn missing usage into a claim of zero
billing. Use Gateway analytics and Cloudflare billing as the financial source of truth.
Cached tool reads do not reserve another network attempt. Model/provider retries
and Pi recovery can incur additional requests, so distinguish logical model attempts,
Gateway requests and tool network reservations.

### Gateway correlation

Inference uses five [custom metadata entries](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/):
`application`, `collectionId`, `promptVersion`, `deploymentVersion`, `phase`. Each
logical model request has a durable-sequence `eventId`. Diagnostic `logId`, `traceId`
and `runId` appear on model spans when the provider supplies them.

**Do not invent a search metadata option:** `agents@0.33.0`'s `createAIWebSearch`
does not accept it. Search's documented `metadata.requestId` (or error `requestId`)
is logged as `gatewayLogId` with the collection. Follow this join key into Gateway.
Public queries and untrimmed results remain in protected per-run SQLite evidence.

## Privacy and replay

Default `TRACE_PAYLOADS=false` records no custom message/tool payload attributes.
Inference explicitly enables Gateway metadata logging while setting
`cf-aig-collect-log-payload: false`. Configure search/Gateway payload retention
separately in the account: inference settings do not automatically apply to the
search source. Review [Gateway logging behavior](https://developers.cloudflare.com/ai-gateway/observability/logging/),
including legacy vs new logging eligibility and Logpush's independent behavior.

Set `TRACE_PAYLOADS` to `true` in `cloudflare.config.ts` only after an intentional
privacy review and redeployment. This records standard JSON-serialized
`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`,
`gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` for Agents session replay.
Images, private reasoning and host-side tool details are omitted. Each attribute
is capped at 16 KiB; oversized attributes are omitted whole with a
`perceptor.payload_omitted.*` flag, not invalid/truncated JSON. The platform's
~64 KiB per-span limit can impose further truncation. Configured credentials are
redacted as defense in depth; this is **not** a general PII detector. Public source
text may itself contain sensitive material. Keep payload capture off unless needed.

Error telemetry uses allowlisted code/status/retryability and sanitized stack
locations. Only application-controlled Policy/Selection/Delivery error messages
are retained; arbitrary SDK/provider messages can echo page bodies and are not
copied into logs. Use protected durable evidence/Gateway diagnostics to investigate.
Credentials are never model inputs, trace attributes, query parameters or feedback.

The native trace/session replay is **not a complete conversation archive**. Keep
SQLite evidence for forensic inspection through
[Durable Objects Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/).
Data Studio is privileged production access (including writes); use SELECT-only
queries for investigation, not hand edits of Pi tables:

```sql
SELECT key, value FROM perceptor_state
WHERE key IN ('run', 'telemetry:stats', 'telemetry:clock', 'telemetry:versions');
```

Choose the `ResearchAgent` namespace and named `discovery-<scheduledTime>` object.
Raw cached `search:*` and `page:*` values and `pi_*` tables stay there, not in public
endpoints. Do not export the entire database into application logs.

## Independent watchdog

Research cron: **Monday 08:00 UTC**. Watchdog cron: **hourly at :15 UTC**. The
watchdog derives the last expected Monday from UTC time, even if dispatch never
registered anything. It checks that object directly, plus known active runs and
unresolved incidents. It does not call `begin`, research, submit or deliver.

| Condition | Threshold/code |
| --- | --- |
| No run | 15 minutes after expected dispatch: `run_missing` |
| No meaningful progress | 15 minutes: `run_stalled` |
| End-to-end run unfinished | 4 hours from schedule: `run_sla_exceeded` |
| Terminal failure | `run_failed` |
| Authoritative state cannot be read | `watchdog_read_failed` |

The next scheduled retry postpones stall detection, not the 4-hour SLA. Routine
control heartbeats do not count as meaningful progress. The SLA accommodates the
eight-attempt delivery policy's roughly two-hour backoff plus research. Detection
is limited by the hourly poll, so a 15-minute threshold is not a 15-minute paging
guarantee. Repeated incidents log once per day or when their code changes; resolution
is logged on the next successful reconciliation. Cloudflare Issues resolution is
an operator action, not implied by a `.resolved` log.

Monitoring enrollment is persisted once, using the initial Worker's version upload
timestamp (or one hour before first store access if metadata is unavailable, such
as local development). An expected run predating enrollment is not demanded. This
avoids a false missing-run incident when first deployed mid-week, without depending
on a successful research dispatch. Later deployments do not reset enrollment. If a
version was uploaded long before it was actually deployed, inspect `monitoringSince`
on `/ops/health` and acknowledge the historical incident if appropriate—do not run
paid research just to manufacture a success.

**A watchdog on the same Worker cannot detect its own total disappearance.** Configure
an independent authenticated uptime check of `/ops/health`. It returns 503 when
there is an incident, no completed watchdog check, or the last check is 90 minutes
old. `GET /` is only liveness and must not be used for weekly-run monitoring.
The protected health route does not perform paid research or enqueue a run.

After investigating an unrecoverable terminal failure or known historical missing
run, `POST /ops/incidents/:collectionId/acknowledge` acknowledges that incident's
current code. This removes it from active health/paging, not from run/evaluation
history. The same code is suppressed until recovery; a different code pages again,
and a healthy reconciliation clears the acknowledgement. New collections are never
covered by an old acknowledgement. An acknowledged failure is **not** a successful
collection; use run summaries for success-rate reporting. Issues acknowledgement/
resolution in Cloudflare is separate.

## Protected operations and review API

Provision a unique, high-entropy `OPERATIONS_TOKEN` (at least 32 characters).
Authorization uses SHA-256 digest comparison, fails closed for missing/short tokens,
and accepts only `Authorization: Bearer ...`, never a query parameter. Rotate it
independently of the internal API's Access service token. Restrict `/ops/*` with
an appropriate Cloudflare Access/WAF policy too if desired, but do not reuse the
API Access credentials or assume a bare Access identity header is proof of auth.

All operations responses use `Cache-Control: no-store`. There is no run, publication,
retry or credential endpoint. Incident acknowledgement changes alert state only.
Summaries expose selected URLs but not raw pages,
model transcripts, feed bodies or arbitrary SQL.

```sh
# Load this secret from your secret manager, not shell history or committed files.
export PERCEPTOR_ORIGIN=https://perceptor.soubiran.dev
curl --fail-with-body -H "Authorization: Bearer $OPERATIONS_TOKEN" \
  "$PERCEPTOR_ORIGIN/ops/health"
curl --fail-with-body -H "Authorization: Bearer $OPERATIONS_TOKEN" \
  "$PERCEPTOR_ORIGIN/ops/runs?limit=26"
curl --fail-with-body -H "Authorization: Bearer $OPERATIONS_TOKEN" \
  "$PERCEPTOR_ORIGIN/ops/runs/discovery-1794211200000"
curl --fail-with-body -H "Authorization: Bearer $OPERATIONS_TOKEN" \
  "$PERCEPTOR_ORIGIN/ops/runs/discovery-1794211200000/evidence"
```

`GET /ops/runs/:collectionId` returns the summary, current reviews and evaluation.
`GET .../evidence` returns the frozen selection's dates/evidence/relevance/rationale,
not arbitrary fetched pages. Reviews are bounded to 16 KiB and must match a retained
terminal collection, exact `batchId` and selected canonical URL. They never publish
or alter the frozen batch:

```sh
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $OPERATIONS_TOKEN" -H 'Content-Type: application/json' \
  "$PERCEPTOR_ORIGIN/ops/runs/discovery-1794211200000/review" \
  --data '{"batchId":"<actual 64-character batch hash>","url":"https://example.com/article","decision":"accepted","reason":"useful","reviewer":"editor-1"}'
```

Decisions: `accepted`, `edited`, `rejected`. Reasons: `useful`, `description_edit`,
`title_edit`, `irrelevant`, `duplicate`, `wrong_date`, `weak_source`, `inaccurate`,
`other`. Reviewer is a pseudonymous audit label (letters/digits/`_.-`, 1–64 chars),
not an email address or an independently authenticated user identity. The shared
operations credential authorizes feedback. To distinguish operators cryptographically,
place a verified identity layer in front rather than trusting this label.

Review PUTs upsert by collection + canonical URL: retries do not inflate counts;
changing a decision updates the evaluation. Review events provide the audit trail
within configured log retention. `accepted` includes accepted-with-edits. Acceptance
rate uses **reviewed** articles as denominator; unreviewed articles are not failures.
Observed model cost per accepted article includes the run's observed model cost,
not complete billing. Group exports by source host and prompt/execution version.

Improve **acceptance rate**, **cost per accepted article**, fetch success and
validation failures, not article count. Zero selections are valid. Validation codes
measure attempted submissions; they do not reveal every candidate the model silently
discarded or establish search recall. Inspect evidence/replay for qualitative review.

## Retention and export

Current [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
retention is 3 days on Free / 7 on Paid; Agent/Workers traces retain 7 days. Gateway
retention depends on account logging eligibility. These defaults are too short for
week-over-week evaluation. Review Cloudflare's announced pricing/retention changes
rather than assuming these limits never change.

The watchdog retains summaries, reviews and full per-run evidence for **180 days**.
It deletes only terminal objects, after both their schedule and completion are at
least 180 days old: dispose Pi, remove alarm, delete object storage including Pi
transcripts, and leave a tiny expired-run tombstone. The compact summary/reviews
are removed only after that deletion succeeds. Up to eight objects are swept per
tick. Failed retention operations log `perceptor.retention.retry` and retry on the
next hourly sweep. Active runs remain available for incident investigation rather
than being silently erased. This is application-level retention, not erasure from
external telemetry destinations, account audit logs, or backups.

For logs/traces longer than the native window:

1. Create an [OpenTelemetry destination](https://developers.cloudflare.com/workers/observability/opentelemetry-export/)
   in the account and configure its credentials/retention there.
2. Add the **real destination name** to `worker.observability.logs.destinations`
   and `.traces.destinations` in `cloudflare.config.ts`, keeping camelCase `cf`
   configuration keys. No fake default destination is configured in this repository.
3. Decide whether `persist` should remain true for the Cloudflare UIs or false for
   external-only storage. Keep it true to use the native Agents/Observability views.
4. Apply the same privacy rules and retention/deletion policy at the destination.
   Gateway Logpush, if used, is a separate account configuration with its own controls.

Workers OTel export supports logs/traces, **not infrastructure/custom metrics**.
Use Workers/DO dashboards/GraphQL for CPU, memory, duration and storage cost. The
compact summary/review API provides application evaluation history without exporting
full source bodies. No R2 bucket or third-party collector is required for that history.

## Required account setup and rollout

Repository code cannot choose your notification recipient, export destination,
operations secret or external monitoring provider. These are **required operator
steps**, not claims that alerts/exports were provisioned by this PR:

1. Provision `OPERATIONS_TOKEN`; verify existing Gateway funding, authenticated
   Gateway configuration and API Access secrets/policy. Default payload recording off.
2. In Workers Issues, configure an occurrence-threshold automation (threshold 1)
   and a recurrence-after-inactivity automation to your webhook/chat/on-call destination.
   Review [Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/).
   Include terminal errors, watchdog alerts, dispatch failures, memory resets and
   summary-publication failures. An occurrence-threshold automation does not page
   on every later occurrence; choose recurrence behavior deliberately.
3. Configure the external `/ops/health` check with its bearer credential and verify
   it pages for non-200, timeout and stale-watchdog state. No secret in URL or logs.
4. Configure optional OTel export if full logs/traces must outlive seven days, and
   set destination retention. Durable summaries/reviews already retain 180 days.
5. Deploy a CI-built artifact intentionally. The hourly cron creates no research
   work. Review initial enrollment and version upload time above.
6. Perform an explicitly authorized **supervised** research/delivery run with a
   safe destination/companion API arrangement. This repository has no public run
   trigger. Do not invoke production `begin` or model calls merely to test telemetry.
7. Inspect Agents spans and optional replay, Gateway joins, durable summary revisions,
   coded errors and empty-run behavior. Exercise missing/stalled/failed incident
   routing, watchdog silence, safe authorization failures and duplicate feedback.
   Confirm generated source maps and exported telemetry arrive at the intended account.
8. Review recommendations, record decisions, and compare multiple weeks before
   changing budgets/prompts based on sparse data.

No builds, tests, type/lint/format checks, CI verification, deployment, real model
run, notification delivery or production API submission were performed while
implementing this change. Added tests use fakes/local bindings and are not evidence
of a successful deployment or end-to-end run.
