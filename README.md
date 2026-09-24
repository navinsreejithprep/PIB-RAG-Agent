# DocQuery — V1 Basic RAG (Local)

A deliberately simple, classroom-oriented RAG application. It keeps the architecture visible and avoids Vercel Blob, Chroma Cloud, authentication, and a cloud vector database.

## Architecture

PDF → text extraction → chunks → OpenAI embeddings → in-memory vector store → cosine similarity → relevant chunks → OpenAI answer → source citations

## What V1 deliberately does NOT do

- OCR for scanned/image-only PDFs
- persistent storage
- metadata filtering
- hybrid retrieval
- reranking
- evaluation harness
- agents
- authentication or multi-user isolation

Those are useful V2–V7 teaching steps. Do not add them to V1 merely to make the demo look more sophisticated.

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
6. Store embeddings in memory.
7. Embed the user's question.
8. Compute cosine similarity against candidate chunks.
9. Keep the highest-scoring relevant chunks.
10. Give those chunks to the LLM as context.
11. Return a grounded answer with source pages.
12. Expand “Show retrieved chunks” to inspect what retrieval actually found.

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

## Important limitation: local in-memory state

Documents and embeddings live in a global in-memory Map inside the Node process. Restarting the server clears the knowledge base. This is intentional for V1 teaching.

It is not a persistence mechanism, not multi-user safe, and not appropriate for a production deployment. A later version can replace `lib/store.ts` with a database/vector store without changing the conceptual RAG flow.

## Deploying to Vercel (persistent storage)

The in-memory store does not work on Vercel: each request can run on a different serverless instance, so a document uploaded on one instance is missing on the next. When `DATABASE_URL` is set, `lib/store.ts` uses Postgres with the pgvector extension instead, creating its tables on first use.

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

## Verification

Before handing off this ZIP, the code was reviewed in two explicit passes:

### Pass 1 — Senior engineer / runtime correctness

Reviewed module boundaries, request validation, PDF parsing, chunking, embedding batching, vector math, context construction, API error handling, state management, dependency/runtime assumptions, and the original PDF worker failure.

### Pass 2 — AI architect / adversarial review

Reviewed prompt-injection handling, unsupported-answer behavior, weak retrieval, embedding-dimension mismatch, context growth, accidental API spend, malformed PDFs, oversized documents, invalid document IDs, duplicate ingestion, deletion, client error handling, accessibility, and the limitations of in-memory state.

This is still a V1 teaching application, not a production RAG service.
