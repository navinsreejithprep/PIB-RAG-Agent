# Executive Media Intelligence Agent

An agentic RAG prototype that turns a pile of news coverage into an evidence-backed executive brief — with source clustering, cross-source comparison, impact analysis, and citation verification before anything is shown to the user. Built on top of, and alongside, **DocQuery**, a simpler PDF question-answering chatbot (see [V1 — DocQuery](#v1--docquery-pdf-chatbot) below). Both apps run from this one repository.

> **All news content in this prototype is synthetic sample data**, written for demonstration. See [Data sources](#data-sources).

## 1. Product overview

Ask a question like *"What are the major developments affecting India's renewable energy sector?"* and the agent:

1. Classifies what you're asking (summarize / compare / investigate / monitor / etc.).
2. Searches a news dataset (and, if you've uploaded PDFs through DocQuery, those too).
3. Clusters articles that cover the same underlying event.
4. Retrieves background/reference material for context.
5. Compares sources within each event for agreement, differences, and outright conflicts.
6. Analyzes implications — what happened, why it matters, what to watch — keeping fact separate from inference.
7. Writes a structured executive brief with inline citations.
8. Verifies every citation against the evidence before showing you anything.

## 2. User problem

Reading enough coverage to answer "what happened, why does it matter, and what should I watch next" for a sector takes an analyst hours: finding articles, noticing which ones cover the same event, spotting where outlets disagree, and writing it up so an executive can read it in two minutes. A single-document Q&A chatbot (DocQuery's V1) doesn't help here — it answers "what does this article say," not "what's the overall picture across 20 articles, and what in it is actually agreed-upon fact versus reporting that conflicts."

## 3. Target users

Executives, corporate affairs teams, policy/government-affairs teams, and strategy analysts who need a fast, sourced read on a sector or topic — not a chat interface for one document.

## 4. Why AI is appropriate

- **Semantic clustering** of near-duplicate coverage ("Cabinet approves...", "Government announces...", "New framework unveiled...") isn't reliably doable with keyword matching.
- **Cross-source comparison** and **implication analysis** require synthesis across many documents, which is exactly what an LLM does well — provided its claims stay grounded in retrieved evidence (see [Responsible AI considerations](#12-responsible-ai-considerations)).
- **Citation verification** as a distinct, separate step catches a real failure mode (misattributed or fabricated citations) that a single "write the answer" prompt does not reliably self-correct.

## 5. Current workflow (without this tool)

An analyst manually searches for coverage, opens each article, mentally tracks which ones cover the same event, notices discrepancies by memory, and writes up findings — a process that scales linearly with the number of articles and doesn't leave an audit trail of which claim came from which source.

## 6. Proposed workflow (with this tool)

Type one question. Watch a short, honest status log (searching → clustering → comparing → analyzing → verifying) while the agent runs, then read a brief where every material claim is traceable to a specific retrieved source, and every unresolved disagreement between sources is called out rather than silently resolved.

## 7. Agent architecture

```
USER QUESTION
   ↓
ORCHESTRATOR (lib/media/orchestrator.ts)
   ↓
 1. Query Understanding (intent, entities, date range)
 2. News Search Tool + Document Search Tool  (parallel)
 3. Article Clustering Tool                  (deterministic, embedding similarity)
 4. Context Retrieval Tool                   (background/reference docs)
 5. Source Comparison Tool                   (per multi-source event cluster)
 6. Impact Analysis Tool
 7. Executive Brief Generation
 8. Citation Verification Tool
   ↓
EXECUTIVE BRIEF (streamed to the UI with a live activity log)
```

This is a **fixed, explainable pipeline**, not a free-form autonomous agent loop. Query-understanding output (intent, date range) steers filtering and status labels; every other step runs in the same order every time, with clear, bounded LLM-call counts. See [docs/architecture.md](docs/architecture.md) for the full diagram, each tool's exact inputs/outputs, and the extension points for making step-selection more dynamic later.

## 8. RAG architecture

Two independent stores share the same building blocks (`lib/openai.ts` embeddings, `lib/similarity.ts` cosine similarity):

- **`lib/store.ts`** — the original DocQuery PDF store (unchanged).
- **`lib/media/store.ts`** — the news/background dataset, with metadata filtering (topic, source, date range) and semantic search, backed by Postgres + pgvector when `DATABASE_URL` is set, or an in-memory Map for local runs (same two-backend pattern as `lib/store.ts`).

Every retrieved item carries its source ID, title, outlet, date, and URL through the entire pipeline so the final brief's `[S#]`-style citations are traceable end to end.

## 9. Tool definitions

Each tool is documented in its source file with a `USER PROBLEM → AI CAPABILITY → OUTPUT → MEASURABLE VALUE` header, per the product requirement that no tool exists just to look agentic:

| Tool | File | Problem it solves |
|---|---|---|
| Query Understanding | `lib/media/tools/intent.ts` | Route the request without over- or under-processing simple asks |
| News Search Tool | `lib/media/tools/search.ts` (`newsSearch`, `searchByTopic`, `searchByDateRange`, `searchBySource`), searching whatever's indexed — synthetic sample data plus any live PIB releases pulled in via `lib/media/sources/pib.ts` | Find relevant coverage without manual reading |
| Document Search Tool | `lib/media/tools/search.ts` (`searchUploadedDocuments`) | Include the user's own uploaded PDFs (DocQuery) as evidence |
| Context Retrieval Tool | `lib/media/tools/search.ts` (`retrieveBackground`) | Pull definitions/explainers, not just headlines |
| Article Clustering Tool | `lib/media/tools/cluster.ts` | Stop near-duplicate coverage from looking like separate developments |
| Source Comparison Tool | `lib/media/tools/compare.ts` | Surface agreement vs. conflict between outlets, without picking a winner |
| Impact Analysis Tool | `lib/media/tools/impact.ts` | Answer "why does it matter" and "what to watch," not just "what happened" |
| Executive Brief Generation | `lib/media/tools/brief.ts` | Produce the one artifact the product exists to produce |
| Citation Verification Tool | `lib/media/tools/verify.ts` | Catch fabricated or misattributed citations before the user sees them |

## 10. Data sources

Two sources feed the same searchable index, clearly distinguishable by their `source` field in the UI:

**Synthetic sample data** (default, always loaded) — see `data/sample-articles.json` (24 articles, fictional outlets and companies, `example.com` URLs) and `data/sample-background.json` (5 reference explainers). Built around a coherent domain (India's renewable energy sector) and deliberately constructed with:

- The **same event reported by multiple outlets** with slightly different framing (A01/A02/A03/A04).
- **Genuinely conflicting figures** for the same fact (₹1.2 lakh crore vs. ₹1.5 lakh crore central support).
- A **denial pattern** (a delay report vs. the company's on-schedule statement).
- An **embedded prompt-injection attempt** inside one article's text (A20), to test that retrieved content is treated as data, not instructions.
- At least one topic with **no coverage in the dataset** (nuclear energy), to test honest "insufficient evidence" behavior.

**Live data: Press Information Bureau (Government of India)** (optional, pulled on demand) — `lib/media/sources/pib.ts` fetches the previous day's English PIB press releases via a community-maintained mirror ([github.com/gkgangavarapu/pibindia-rss](https://github.com/gkgangavarapu/pibindia-rss)), free and keyless, with **full article text**, not just a headline/snippet (unlike most free news APIs — see the comparison this was chosen from in the section below). Click "Pull latest PIB releases" on the `/media` dashboard, or `curl -X POST localhost:3000/api/media/ingest-pib`.

Why PIB, and why not the more commonly recommended options: most free news APIs (NewsAPI.org, GNews, NewsData.io) either restrict the free tier to non-production use, or only return a short snippet rather than full article body text — which would weaken the comparison and citation-verification tools, since there'd be little actual text to compare or verify against. PIB releases are primary-source government announcements, not licensed news content, so they carry no such restriction, and the community mirror above provides them as full, clean English text.

**Honest limitations of the PIB integration** (see `lib/media/sources/pib.ts` for the full reasoning):
- It is **not filterable by topic server-side** — it's whatever the Government of India published in the last 24 hours, across every ministry. On any given day it may contain zero renewable-energy items (tested: a live pull on 2026-09-25 returned 59 releases, of which exactly 1 was energy-related).
- **No cross-outlet comparison applies to PIB releases** — every item ultimately comes from one source (the Indian government), so the Source Comparison Tool has nothing to compare it against unless the same story also appears in the synthetic dataset.
- Re-pulling on different days **accumulates a real historical archive** (existing items are skipped, not duplicated) rather than replacing what's there.

The architecture supports adding a further, broader news API later: `lib/media/tools/search.ts`'s functions are the seam — add another source alongside `lib/media/sources/pib.ts` and nothing above that layer needs to change.

## 11. Evaluation methodology

`tests/evaluation-dataset.json` has 24 test cases across 11 categories (simple factual retrieval, multi-document synthesis, comparison, conflicting sources, numerical claims, date-sensitive questions, executive summary, implication analysis, citation correctness, insufficient evidence, prompt injection), each with real `expected_sources` IDs from the sample dataset.

`scripts/evaluate-media.mjs` runs every case against a live server and scores what can be scored **without** a human:

- **Retrieval relevance** — recall of `expected_sources` against what was actually retrieved.
- **Citation existence validity** — do cited IDs correspond to real supplied evidence (deterministic, not LLM-graded).
- **Citation support** — LLM-graded (a second model call checks whether the cited text actually supports the claim); reported as *approximate*, not ground truth.
- **Latency** — measured wall-clock time per question.
- **Insufficient-evidence and prompt-injection pass/fail** — keyword-checked against the actual output.

**Not** automatically scored: factual accuracy and completeness. These are marked `"human_review_required": true` in every result rather than assigned a fabricated number.

Run it with:
```bash
npm run dev                 # start the app
# open http://localhost:3000/media once to trigger sample-data seeding, or:
curl -X POST http://localhost:3000/api/media/seed
npm run eval:media          # runs all 24 cases against localhost:3000
```

See `tests/evaluation-results.json` for the results of the run performed while building this prototype (timestamped; re-running will vary since it calls a live LLM).

## 12. Responsible AI considerations

- **Retrieved text is data, not instructions.** Every LLM-backed tool's system prompt (`prompts/media.ts`) states this explicitly, and the sample dataset includes an article with an embedded injection attempt specifically to test it (evaluation case T17).
- **Fact vs. inference is structurally separated**, not just worded carefully: `whatHappened`/`keyDevelopments` require citations; `potentialImplications`/`whatToWatch` are explicitly forward-looking judgment in the prompt and the UI.
- **Conflicts are reported, never resolved by guessing.** The comparison prompt explicitly forbids picking a winner between conflicting sources.
- **Citation verification is a separate, skeptical pass**, not the same model call that wrote the brief grading its own work uncritically — the verification prompt is instructed to default to "not supported" when unsure.
- **No claimed accuracy/throughput numbers are fabricated.** See [Baseline methodology](#13-baseline-methodology) and the `factualAccuracy`/`completeness` fields in evaluation output, which are left null with an explicit human-review note.

## 13. Baseline methodology

**Manual baseline** (an analyst reading the same ~24 articles and writing an equivalent brief by hand): **not yet measured** — `[TO BE MEASURED: have someone time a manual research+synthesis pass on the same query and dataset]`.

**AI-assisted (this tool), actually measured**, all 24 cases in `tests/evaluation-dataset.json`, run against the local dev server on the sample dataset (full detail and a note on two measurement anomalies in `tests/evaluation-results.json`):

| Metric | Result |
|---|---|
| Cases completed | 24/24 (0 failed) |
| Average end-to-end latency | 57.3s (excluding two runs inflated by the local machine sleeping mid-request; see the results file's `note`) |
| p95 latency | 92.7s (same exclusion) |
| Avg. retrieval recall against expected sources | 96.3% |
| Avg. citation existence validity (deterministic — no fabricated citation IDs) | 100% |
| Avg. citation support (LLM-graded, approximate) | 73.1% |
| Insufficient-evidence cases correctly flagged | 3/3 |
| Prompt-injection case resisted | 1/1 |

Read the 73.1% citation-support figure carefully: it is a second LLM call grading the first LLM call's citations, instructed to default to "not supported" when unsure (see `prompts/media.ts`) — it is a useful skepticism check, not a formally verified accuracy number, and some of what it flags are legitimate nitpicks (e.g. the brief calling something a "surge" when the source only supports the underlying figures) rather than actual errors. Treat it as a lower bound, not a precise score, until it's been spot-checked by a human against a sample of flagged claims.

Do not quote a "research time reduced by X%" figure until a real manual baseline has been timed on the same task — the numbers above are the AI-assisted side only.

## 14. Limitations

- **Evaluation numbers are against synthetic data only.** The 24-case evaluation suite (see below) was run against the synthetic dataset, not live PIB data — PIB coverage varies day to day and has no known-correct `expected_sources`, so it can't be scored the same way. Treat the live PIB integration as functionally tested (see `tests/media-pib.test.ts` and the manual run in the README's PIB section) but not evaluation-scored.
- **PIB is a single source.** It gives real, full-text government announcements, but comparison/conflict-detection only shows its value on the synthetic dataset (or if a PIB story happens to also appear there). A broader multi-outlet real-data source is the natural next step — see [Future roadmap](#17-future-roadmap).
- **Clustering can over-merge topically-adjacent-but-distinct articles.** Embedding-similarity clustering on short news text is not perfect; in testing, articles about different auctions in the same region occasionally clustered together. This is a known, measured limitation, not a hidden one.
- **Retrieval cannot perfectly separate on-topic from off-topic by similarity score alone.** `text-embedding-3-small` cosine similarity for short, topically-adjacent news does not cleanly separate a genuinely relevant query from a related-but-different one (measured: an off-topic query's best match scored ~0.50, inside the range of genuinely relevant matches for a different query). The brief-writing prompt, not the retrieval threshold, is what is responsible for saying evidence is insufficient — see `lib/media/tools/search.ts` for the calibration numbers.
- **No persistence for agent runs.** Each query re-runs the full pipeline; there's no caching or run history yet.
- **In-memory store on local runs.** Same limitation as DocQuery V1 — set `DATABASE_URL` for persistence across restarts/serverless instances.
- **No authentication.** Anyone with the deployed URL can run queries against your OpenAI key.
- **Citation "support" checking is itself an LLM call**, not a formally verified proof — treat it as a second opinion that catches obvious misattribution, not a guarantee.

## 15. Setup instructions

```bash
node -v                      # Node 22+
npm install
cp .env.example .env.local   # then add OPENAI_API_KEY
npm run dev
```

Open http://localhost:3000 for DocQuery (PDF chatbot), or http://localhost:3000/media for the Executive Media Intelligence Agent. The media dashboard seeds the sample dataset automatically on first load.

For persistent storage (required on Vercel), set `DATABASE_URL` to a Postgres connection string with the `vector` extension available (e.g. a Neon database) — see [Deploying to Vercel](#deploying-to-vercel-persistent-storage) below. Both DocQuery and the media agent use the same `DATABASE_URL`, in separate tables.

## 16. Demo instructions

1. Open `/media`. Wait for "Sample dataset ready" (a few seconds).
2. Click the first example query chip (India renewable energy developments), or type your own.
3. Watch the activity log: Understanding → Searching → Clustering → Context → Comparing → Impact → Brief → Verifying.
4. Read the executive brief. Expand **Key developments** to see the underlying event clusters and their sources. Expand **Source comparison** to see where outlets agreed or conflicted (try the clean-energy-framework funding figure: ₹1.2 lakh crore vs. ₹1.5 lakh crore). Check the confidence score and notes at the top.
5. Try `"What is India's nuclear energy capacity target?"` to see the honest "evidence insufficient" behavior.
6. Try `"Summarize the opinion piece about rooftop solar and distribution companies"` to see prompt-injection resistance — article A20 contains a hidden instruction that the agent should not follow.
7. Click **"Pull latest PIB releases"** to index real, live Government of India press releases, then ask a question about whatever's actually in that day's releases (check the retrieved-sources list for anything with `(via PIB)` as its source) — the brief will cite and summarize a real government announcement, not the synthetic dataset.

## 17. Future roadmap

- Add a second, multi-outlet real news source (e.g. NewsData.io filtered to `country=in`) alongside PIB, so real cross-source comparison becomes possible on live data, not just the synthetic dataset. PIB (`lib/media/sources/pib.ts`) is the first real source, added as an explicit opt-in pull rather than the default, so the tested/evaluated demo flow stays deterministic.
- Cache/persist agent runs so repeat questions don't re-run the full pipeline.
- A real manual-baseline timing study (see [Baseline methodology](#13-baseline-methodology)).
- Reranking and hybrid (keyword + semantic) retrieval for better precision than cosine similarity alone.
- Authentication and per-user rate limiting before any public deployment.
- Expand clustering beyond O(n²) union-find once article volume grows past a few dozen per query.

---

# V1 — DocQuery (PDF chatbot)

The original, deliberately simple classroom RAG app this prototype was built on top of. Preserved as-is and still fully functional at `/`.

## Architecture

PDF → text extraction → chunks → OpenAI embeddings → vector store (in-memory locally, Postgres/pgvector when `DATABASE_URL` is set) → cosine similarity → relevant chunks → OpenAI answer → source citations

## What V1 deliberately does NOT do

- OCR for scanned/image-only PDFs
- metadata filtering
- hybrid retrieval
- reranking
- agents

Those are useful teaching steps for later; V1 stays intentionally simple. (The Executive Media Intelligence Agent above is where agentic, metadata-filtered, multi-tool RAG lives — DocQuery itself is unchanged.)

## Requirements

- Node.js 22+
- An OpenAI API key

Node 20 is intentionally not the target runtime for this version. Current OpenAI Node releases no longer support Node 20, and current Next.js releases require Node 20.9+ at minimum. Use Node 22 for this project.

## Run locally

```bash
node -v
npm install
cp .env.example .env.local
```

Add your key to `.env.local`:

```text
OPENAI_API_KEY=your_key_here
```

Then:

```bash
npm run dev
```

Open http://localhost:3000

The dev and build scripts explicitly use Webpack. This is intentional: the original V1 used a newer PDF.js worker path that caused a Next.js/Turbopack worker-resolution failure. V1 now uses the stable `pdf-parse` v1 API and keeps PDF parsing server-side.

## V1 teaching flow

1. Upload a text-based PDF.
2. Validate the file type and size.
3. Extract page text.
4. Split each page into ~1,000-character chunks with 100-character overlap.
5. Generate an embedding for every chunk.
6. Store embeddings.
7. Embed the user's question.
8. Compute cosine similarity against candidate chunks.
9. Keep the highest-scoring relevant chunks.
10. Give those chunks to the LLM as context.
11. Return a grounded answer with source pages.
12. Expand "Show retrieved chunks" to inspect what retrieval actually found.

## Safety and engineering guardrails in V1

- PDF size, page-count, and chunk-count limits prevent accidental runaway embedding cost or memory use.
- Embedding batches are intentionally small.
- Embedding count and vector dimensions are validated.
- Retrieval checks vector dimensions instead of silently comparing incompatible vectors.
- A minimum similarity threshold prevents obviously weak matches from being sent to the LLM.
- The context passed to the LLM has an explicit character budget.
- Retrieved PDF text is treated as untrusted data; instructions embedded inside documents are explicitly ignored.
- API responses avoid returning raw server/OpenAI exception messages to the browser while detailed errors remain in the terminal.
- Document IDs are validated before query/delete operations.
- API keys are server-side only; they are never sent to the browser.

## Deploying to Vercel (persistent storage)

The in-memory store does not work on Vercel: each request can run on a different serverless instance, so a document uploaded on one instance is missing on the next. When `DATABASE_URL` is set, both `lib/store.ts` (DocQuery) and `lib/media/store.ts` (media agent) use Postgres with the pgvector extension instead, creating their tables on first use.

1. Import the repository in Vercel and set `OPENAI_API_KEY`.
2. Add a Neon database from the Vercel Marketplace (Storage → Create Database → Neon) and connect it to the project. This sets `DATABASE_URL`.
3. Redeploy.

Vercel limits request bodies to 4.5 MB, so larger PDFs are rejected there even though `MAX_PDF_MB` defaults to 20.

## Troubleshooting the previous PDF worker error

If you previously ran an older ZIP, do not install this version on top of that directory. Create a clean directory from this ZIP. If necessary:

```bash
rm -rf node_modules .next package-lock.json
npm install
npm run dev
```

The expected package versions include:

```text
next 16.3.6
openai 7.22.0
pdf-parse 1.1.1
```

The expected dev command is:

```text
next dev --webpack
```

If the terminal mentions `pdf.worker.mjs` or Turbopack while running V1, you are almost certainly running an older copy of the project rather than this package.
