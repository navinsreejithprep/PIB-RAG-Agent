# Architecture — Executive Media Intelligence Agent

## System overview

```mermaid
flowchart TD
    U["User (browser)"] -->|"POST /api/media/query\n(NDJSON stream)"| API["Next.js Route Handler\napp/api/media/query"]
    API --> ORCH["Orchestrator\nlib/media/orchestrator.ts"]

    ORCH --> INTENT["Query Understanding\ntools/intent.ts"]
    ORCH --> SEARCH["News Search Tool\ntools/search.ts"]
    ORCH --> PDF["Document Search Tool\n(reuses lib/rag.ts)"]
    ORCH --> CLUSTER["Article Clustering Tool\ntools/cluster.ts (deterministic)"]
    ORCH --> CTX["Context Retrieval Tool\ntools/search.ts"]
    ORCH --> COMPARE["Source Comparison Tool\ntools/compare.ts"]
    ORCH --> IMPACT["Impact Analysis Tool\ntools/impact.ts"]
    ORCH --> BRIEF["Executive Brief\ntools/brief.ts"]
    ORCH --> VERIFY["Citation Verification\ntools/verify.ts"]

    SEARCH --> MSTORE[("lib/media/store.ts\nPostgres+pgvector or in-memory")]
    PDF --> PSTORE[("lib/store.ts\nDocQuery's PDF store, unchanged")]
    INTENT -.->|"OpenAI structured output"| OAI[("OpenAI API")]
    COMPARE -.-> OAI
    IMPACT -.-> OAI
    BRIEF -.-> OAI
    VERIFY -.-> OAI

    ORCH -->|"status events, then result"| API
    API -->|"NDJSON stream"| DASH["MediaDashboard\ncomponents/media-dashboard.tsx"]
```

## Pipeline sequence

```mermaid
sequenceDiagram
    participant UI as MediaDashboard
    participant API as /api/media/query
    participant O as Orchestrator
    participant T as Tools

    UI->>API: POST { query }
    API->>O: runAgent(query)
    O->>T: classifyIntent(query)
    T-->>O: intent, entities, dateRange
    O-->>API: status "understanding" done
    API-->>UI: stream event

    par News search
        O->>T: newsSearch() + searchUploadedDocuments()
        T-->>O: EvidenceItem[]
    end
    O-->>API: status "searching" done
    API-->>UI: stream event

    O->>T: clusterArticles(evidence)
    T-->>O: EventCluster[]
    O-->>API: status "clustering" done

    O->>T: retrieveBackground(query)
    T-->>O: background EvidenceItem[]
    O-->>API: status "context" done

    loop each multi-source cluster (capped)
        O->>T: compareSources(cluster)
        T-->>O: SourceComparison
    end
    O-->>API: status "comparing" done

    O->>T: analyzeImpact(...)
    T-->>O: ImpactAnalysis
    O-->>API: status "impact" done

    O->>T: generateBrief(...)
    T-->>O: ExecutiveBrief
    O-->>API: status "brief" done

    O->>T: verifyCitations(brief, evidence)
    T-->>O: CitationVerification
    O-->>API: status "verifying" done

    O-->>API: result { AgentState }
    API-->>UI: final stream event
    UI->>UI: render brief, clusters, comparisons, confidence
```

## Why a fixed pipeline, not a free-form agent loop

The product spec explicitly warns against "unnecessary autonomous complexity." A ReAct-style loop where the model picks its own next tool call would make behavior harder to predict, harder to bound in cost/latency, and harder to test (the evaluation harness assumes each step runs in a known order). Instead:

- **Every step runs in the same order** for any non-empty evidence set — this is what "explainable" means here: you can point at `orchestrator.ts` and read the exact sequence of tool calls that produced any given brief.
- **Query-understanding output *does* steer the pipeline**, just narrowly: `intent.dateRange` filters the news search, and `intent.intent` is surfaced as a UI label. This is the "planner decides which tools are necessary" requirement, kept lightweight rather than expanded into full dynamic tool selection.
- **Extension point for more dynamic behavior**: `runAgent()` in `lib/media/orchestrator.ts` is the single place to add, for example, skipping the comparison/impact/brief steps entirely for a single-cluster "summarize" intent and returning a shorter direct answer instead. Not implemented in this prototype to keep the pipeline predictable and testable; noted here rather than half-implemented.

## Data model

```mermaid
erDiagram
    MEDIA_ITEMS {
        text id PK
        text kind "article | background"
        text title
        text source
        date date
        text url
        text topic
        text content
        vector embedding
    }
    DOCUMENTS {
        text id PK
        text name
        int pages
        timestamptz uploaded_at
        text status
    }
    CHUNKS {
        text id PK
        text document_id FK
        int page_number
        int chunk_index
        text text
        vector embedding
    }
    DOCUMENTS ||--o{ CHUNKS : contains
```

`media_items` (this feature) and `documents`/`chunks` (DocQuery, unchanged) are independent tables in the same Postgres database when `DATABASE_URL` is set — they never join or share rows. `lib/media/tools/search.ts`'s `searchUploadedDocuments` bridges them at the application layer by wrapping both result shapes in a common `EvidenceItem` type, not at the database layer.

## Retrieval tuning (measured, not assumed)

Cosine similarity between `text-embedding-3-small` embeddings does not cleanly separate "genuinely relevant" from "topically adjacent but off-topic" for short news text. Measured against the sample dataset (see `lib/media/tools/search.ts` for the script this came from):

| Query | Top match | Median (top 24) | Min |
|---|---|---|---|
| "Major developments in India's renewable energy sector" (on-topic) | 0.592 | 0.420 | 0.237 |
| "India's nuclear energy capacity target" (off-topic — not in dataset) | 0.504 | 0.313 | 0.216 |

The off-topic query's best match (0.504) scores *higher* than the on-topic query's median (0.420) — a single similarity threshold cannot fully separate the two. `newsSearch`'s default `minSimilarity` (0.28) trims the weakest noise but is not, by itself, a reliable "is this relevant" gate. **The brief-writing prompt is what is responsible for the honest "evidence insufficient" behavior** (tested in evaluation case T14) — it is instructed to say so explicitly when the retrieved evidence doesn't address the question, rather than relying on retrieval alone to return nothing.

## Confidence score

Computed deterministically in `orchestrator.ts` from the citation-verification pass, not a separate LLM call:

1. Start from the fraction of extracted claims whose citations both exist in evidence and were judged supported on re-check.
2. Subtract up to 0.2 total for unresolved cross-source conflicts (0.05 per conflict, capped).
3. Clamp to `[0, 1]`.
4. Attach human-readable notes for every factor that reduced it (fabricated citations, unsupported claims, conflicts, single-source developments).

This keeps confidence auditable — every point it lost is listed in `confidenceNotes`, rather than being an opaque model-generated number.
