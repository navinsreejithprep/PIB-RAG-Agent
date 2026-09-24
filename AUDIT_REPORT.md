# DocQuery V1 — Two-Pass Engineering Audit

## Pass 1 — Microsoft-level senior engineer / runtime correctness

The original implementation was reviewed for build/runtime failures, API boundaries, data flow, state management, dependency assumptions, and RAG correctness.

### Findings fixed

1. **PDF.js worker failure**
   - Removed the v2 `PDFParse`/worker path that was producing `pdf.worker.mjs` resolution failures.
   - Kept V1 on `pdf-parse` 1.1.1 and explicitly use Next.js Webpack for dev/build.
   - PDF parsing remains server-side.

2. **Incorrect document-store summary typing**
   - The original `listDocuments()` stripped the stored chunk array but also failed to reconstruct the required numeric `chunks` summary field.
   - Fixed by deriving `chunks: chunks.length` when returning summaries.

3. **Embedding request sizing**
   - Reduced embedding batch size to 16 for predictable request sizes.

4. **Embedding integrity**
   - Added validation for embedding count and vector dimensions, including cross-batch dimension consistency.

5. **Vector math safety**
   - Cosine similarity now rejects empty or dimension-mismatched vectors instead of silently truncating to the shorter vector.

6. **Unnecessary API spend**
   - Retrieval now checks for candidate documents before embedding the user's question.

7. **Weak retrieval**
   - Added a configurable minimum similarity threshold.
   - If no sufficiently relevant evidence exists, the app does not call the LLM.

8. **Context growth**
   - Added an explicit context character budget before calling the LLM.

9. **Document/cost guardrails**
   - Added PDF size, page-count, and chunk-count limits.

10. **Error leakage**
    - Raw server/OpenAI errors are logged server-side and converted to safer browser-facing messages.

11. **API validation**
    - Query length and document IDs are validated.
    - Delete now returns 400 for malformed IDs and 404 for missing documents.

12. **Client robustness**
    - Added response validation, deletion error handling, stable message IDs, accessible labels, and status announcements.

## Pass 2 — AI architect / adversarial review

### Prompt injection

Retrieved document text is explicitly treated as untrusted data. The system prompt tells the model to ignore instructions embedded in documents and to cite only supplied source identifiers.

### Hallucination / unsupported answers

The system prompt requires evidence-backed answers. Retrieval also has a similarity floor, so weak matches are not automatically passed to the model.

### Provenance

Every stored chunk retains document ID, document name, page number, and chunk index. Answers expose source IDs and page numbers, and the UI exposes the exact retrieved chunks for teaching/debugging.

### State isolation

The app deliberately uses one in-memory process-local store. This is explicitly documented as non-production, non-persistent, and non-multi-user. It is suitable for V1 classroom demonstrations only.

### File handling

The app validates the extension/content type, checks the PDF magic header, rejects empty files, and applies size/page/chunk limits. Uploaded filenames are truncated before storage/display.

### Failure modes

The app handles empty stores, duplicate documents, empty extraction, oversized PDFs, malformed document IDs, missing documents, inconsistent embeddings, zero vectors, weak retrieval, empty model responses, and OpenAI timeout/auth/rate-limit errors.

## Verification performed

- TypeScript source files: transpilation/syntax check passed.
- Chunking/cleaning regression checks: passed.
- Cosine-similarity checks: passed.
- Static scan for the old PDF.js worker code path: passed.
- Package/runtime invariants: passed.

## Environment limitation

A full `npm install`, `next build`, and Vitest run could not be executed in the audit sandbox because external npm registry/network access was unavailable. The ZIP therefore does **not** claim a green production build from this environment. The code was statically parsed and the pure-function regression tests were executed directly.

On the target machine, run:

```bash
npm install
npm run lint
npm test
npm run build
```

Then start the application with:

```bash
npm run dev
```
