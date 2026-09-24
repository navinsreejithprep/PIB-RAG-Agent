# Product Requirements — Executive Media Intelligence Agent

## Problem statement

Executives, corporate affairs, policy, and strategy teams need to answer "what's happening in this sector and why does it matter" from public coverage. Doing this manually means reading dozens of articles, noticing by memory which ones cover the same event, spotting where outlets disagree, and writing up findings with no reliable audit trail back to sources. A single-document Q&A chatbot doesn't solve this — the problem is synthesis across many documents, not retrieval from one.

## Personas

- **Corporate affairs lead** — needs a defensible, cited brief before a leadership meeting; cares most about not being caught out by a fact the brief got wrong or a citation that doesn't hold up.
- **Policy/government-affairs analyst** — needs to track a fast-moving regulatory topic across many outlets and spot when a new detail contradicts an earlier report.
- **Strategy analyst** — needs to compress "what changed this month in sector X" into something a busy executive will actually read.

## User stories

1. As a corporate affairs lead, I want to ask a plain-language question about a sector and get a brief with inline citations, so I can trust and quickly verify what I present upward.
2. As a policy analyst, I want the system to tell me when two sources report a fact differently, rather than silently picking one, so I don't repeat an unresolved discrepancy as settled fact.
3. As a strategy analyst, I want near-duplicate coverage of the same event grouped together, so "key developments" reflects actual distinct events, not outlet count.
4. As any user, I want to be told explicitly when the available evidence doesn't answer my question, rather than getting a plausible-sounding but ungrounded answer.
5. As any user, I want to see the underlying sources and a live status of what the agent is doing, so the process isn't an opaque black box.

## Functional requirements

- FR1: Accept a free-text research question and classify its intent (summarize, research, compare, investigate, monitor, identify developments, analyze implications, explain a topic, generate executive brief).
- FR2: Search a news dataset by semantic similarity, with topic, source, and date-range filters.
- FR3: Search any PDFs the user has uploaded via the existing DocQuery pipeline as additional evidence.
- FR4: Cluster retrieved articles that cover the same underlying event.
- FR5: Retrieve background/reference material relevant to the question, separate from news events.
- FR6: For event clusters with 2+ sources, identify common facts, differences, and direct conflicts, without resolving conflicts by guessing.
- FR7: Produce an impact analysis (what happened / why it matters / implications / risks / what to watch) that keeps cited fact separate from forward-looking inference.
- FR8: Generate a structured executive brief (headline, executive summary, what happened, why it matters, key developments, implications, risks, what to watch, sources) with inline citations on every material claim.
- FR9: Verify every citation in the brief: (a) deterministically, that the cited ID exists in the retrieved evidence; (b) via a second model call, that the cited text actually supports the claim.
- FR10: Compute and display a confidence score and human-readable notes explaining what lowered it (unresolved conflicts, unsupported citations, single-source developments).
- FR11: Stream a concise, non-chain-of-thought activity log to the UI while the agent runs.
- FR12: Treat all retrieved document text as untrusted data; never follow instructions embedded inside it.
- FR13: Provide a reproducible evaluation harness with a fixed test set and automatically-scorable metrics, clearly marking metrics that require human review instead of fabricating them.
- FR14: Work end-to-end without any external news API configured, using a clearly-labeled synthetic sample dataset.

## Non-functional requirements

- NFR1: No secrets in source control; all configuration via environment variables (existing `lib/config.ts` pattern, extended).
- NFR2: Server-side-only API keys; never sent to the browser (existing DocQuery guarantee, preserved).
- NFR3: Errors shown to the user never leak raw provider exception text; detailed errors are logged server-side only (reuses `lib/http.ts`).
- NFR4: The agent pipeline must complete in a bounded, predictable number of LLM calls per query (no unbounded autonomous looping).
- NFR5: The system must degrade gracefully: uploaded-document search failing should not fail the whole query; an empty evidence set should produce an honest "insufficient evidence" result, not an error.
- NFR6: Works with the in-memory store locally (no database required) and with Postgres/pgvector when deployed (same pattern as the existing DocQuery store).

## Success metrics

Automatically measurable (see `scripts/evaluate-media.mjs` and `tests/evaluation-results.json` for actual measured values, not targets):

- Retrieval relevance (recall against a known-correct source set).
- Citation existence validity (no fabricated citation IDs) — should be 100%; this is deterministic and any failure is a real bug.
- Citation support rate (LLM-graded, approximate).
- Latency (avg and p95).
- Insufficient-evidence cases correctly flagged.
- Prompt-injection cases resisted.

Requires human review (not fabricated): factual accuracy against source articles, response completeness, and any comparison of research/synthesis time against a real manual baseline.

## MVP scope

A user can enter *"What are the major developments affecting India's renewable energy sector?"* and receive: key developments, clustered source coverage, an evidence-backed executive summary, potential implications, risks/uncertainties, what to watch, and source citations — end to end, on the synthetic sample dataset, with no external news API required. This is implemented and tested (see [README.md § Demo instructions](../README.md#16-demo-instructions)).

## Future features (out of MVP scope)

- Real news API integration (see `lib/media/tools/search.ts` as the seam).
- Persisted/cached agent runs and run history.
- A conducted manual-baseline timing study.
- Reranking, hybrid retrieval.
- Authentication and rate limiting.
- Scheduled/recurring monitoring ("alert me when X changes") rather than only on-demand queries.
