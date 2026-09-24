// Shared types for the Executive Media Intelligence Agent. Kept separate from
// lib/types.ts (the V1 PDF chatbot's types) so the two features stay decoupled.

export type MediaItemKind = "article" | "background";

export type MediaItem = {
  id: string;
  kind: MediaItemKind;
  title: string;
  source: string;
  date: string; // ISO date, e.g. "2026-03-10"
  url: string;
  topic: string;
  content: string;
};

export type MediaSearchResult = MediaItem & {
  similarity: number;
  embedding: number[];
};

export const INTENTS = [
  "summarize",
  "research",
  "compare",
  "investigate",
  "monitor",
  "identify_developments",
  "analyze_implications",
  "explain_topic",
  "generate_executive_brief",
] as const;
export type Intent = (typeof INTENTS)[number];

export type IntentClassification = {
  intent: Intent;
  entities: string[];
  topics: string[];
  dateRange: { start: string | null; end: string | null };
  needsResearch: boolean;
};

export type EventCluster = {
  id: string;
  headline: string;
  sourceIds: string[];
  sourceCount: number;
  dateRange: { earliest: string; latest: string };
  sources: Array<{ id: string; title: string; source: string; date: string; url: string; similarity: number }>;
  keyFacts: string[];
};

export type ConflictClaim = { issue: string; positions: Array<{ sourceId: string; claim: string }> };

export type SourceComparison = {
  clusterId: string;
  commonFacts: string[];
  differences: string[];
  conflicts: ConflictClaim[];
  unsupportedAssertions: string[];
};

export type ImpactAnalysis = {
  whatHappened: string;
  whyItMatters: string;
  potentialImplications: string[];
  risksAndUncertainties: string[];
  whatToWatch: string[];
};

export type KeyDevelopment = { headline: string; summary: string; sourceIds: string[] };

export type ExecutiveBrief = {
  headline: string;
  executiveSummary: string;
  whatHappened: string;
  whyItMatters: string;
  keyDevelopments: KeyDevelopment[];
  potentialImplications: string[];
  risksAndUncertainties: string[];
  whatToWatch: string[];
};

export type CitationCheck = {
  citationId: string;
  existsInEvidence: boolean;
  claimExcerpt: string;
  supported: boolean;
  note: string;
};

export type CitationVerification = {
  checks: CitationCheck[];
  unsupportedCount: number;
  fabricatedCitationCount: number;
};

export type SourceRef = { id: string; title: string; source: string; date: string; url: string; kind: MediaItemKind };

// A uniform shape for anything the agent can cite, whether it came from the
// sample news dataset or from a PDF the user uploaded through the V1
// DocQuery pipeline (lib/rag.ts). Keeping one shape lets every downstream
// tool (clustering, comparison, impact analysis, brief writing) treat both
// evidence sources identically.
export type EvidenceItem = {
  id: string;
  kind: MediaItemKind | "uploaded_pdf";
  title: string;
  source: string;
  date: string;
  url: string;
  content: string;
  similarity: number;
};

export type ActivityStep = {
  step: string;
  label: string;
  status: "running" | "done";
  detail?: string;
  at: string;
};

export type AgentState = {
  userQuery: string;
  intent: Intent;
  entities: string[];
  dateRange: { start: string | null; end: string | null };
  retrievedSources: SourceRef[];
  clusters: EventCluster[];
  comparisons: SourceComparison[];
  backgroundContext: SourceRef[];
  impact: ImpactAnalysis | null;
  brief: ExecutiveBrief | null;
  citations: CitationVerification | null;
  confidence: number | null;
  confidenceNotes: string[];
};
