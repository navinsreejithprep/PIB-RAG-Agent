import { classifyIntent } from "./tools/intent";
import { newsSearch, retrieveBackground, searchUploadedDocuments } from "./tools/search";
import { clusterArticles } from "./tools/cluster";
import { compareSources } from "./tools/compare";
import { analyzeImpact } from "./tools/impact";
import { generateBrief } from "./tools/brief";
import { verifyCitations } from "./tools/verify";
import type { AgentState, EvidenceItem } from "./types";

export type AgentEvent =
  | { type: "status"; step: string; label: string; status: "running" | "done"; detail?: string; at: string }
  | { type: "result"; state: AgentState };

// The orchestrator: a fixed, explainable pipeline (not a free-form ReAct
// loop) that runs the tools in section 4 of the product spec in sequence,
// bounded and cost-controlled at each step. "Planning" is intentionally
// lightweight here — intent classification decides date-range filtering and
// status labels now, and is the extension point noted in
// docs/architecture.md for routing simple lookups around the full pipeline
// later. This keeps behavior predictable and testable rather than adding
// autonomous complexity the product spec explicitly warns against.

const MAX_CLUSTERS_FOR_SYNTHESIS = 8;
const MAX_CLUSTERS_TO_COMPARE = 5;

function now() {
  return new Date().toISOString();
}

function emptyState(query: string, intent: Awaited<ReturnType<typeof classifyIntent>>): AgentState {
  return {
    userQuery: query,
    intent: intent.intent,
    entities: intent.entities,
    dateRange: intent.dateRange,
    retrievedSources: [],
    clusters: [],
    comparisons: [],
    backgroundContext: [],
    impact: null,
    brief: null,
    citations: null,
    confidence: 0,
    confidenceNotes: ["No relevant sources were found in the indexed news dataset or uploaded documents for this query."],
  };
}

export async function* runAgent(query: string): AsyncGenerator<AgentEvent, void, unknown> {
  const step = (s: string, label: string, status: "running" | "done", detail?: string): AgentEvent =>
    ({ type: "status", step: s, label, status, detail, at: now() });

  yield step("understanding", "Understanding request", "running");
  const intent = await classifyIntent(query);
  yield step("understanding", "Understanding request", "done", `Intent: ${intent.intent.replace(/_/g, " ")}`);

  yield step("searching", "Searching news coverage", "running");
  const [newsResults, pdfResults] = await Promise.all([
    newsSearch(query, {
      startDate: intent.dateRange.start ?? undefined,
      endDate: intent.dateRange.end ?? undefined,
      limit: 14,
    }),
    searchUploadedDocuments(query),
  ]);
  const evidence: EvidenceItem[] = [...newsResults, ...pdfResults];
  yield step("searching", "Searching news coverage", "done", `Found ${evidence.length} candidate source${evidence.length === 1 ? "" : "s"}`);

  if (!evidence.length) {
    yield { type: "result", state: emptyState(query, intent) };
    return;
  }

  yield step("clustering", "Clustering related coverage", "running");
  const allClusters = await clusterArticles(evidence);
  const clusters = allClusters.slice(0, MAX_CLUSTERS_FOR_SYNTHESIS);
  yield step("clustering", "Clustering related coverage", "done", `${evidence.length} sources → ${allClusters.length} distinct event${allClusters.length === 1 ? "" : "s"}`);

  yield step("context", "Retrieving background context", "running");
  const background = await retrieveBackground(query);
  yield step("context", "Retrieving background context", "done", `${background.length} reference document${background.length === 1 ? "" : "s"}`);

  const evidenceById = new Map<string, EvidenceItem>([...evidence, ...background].map((item) => [item.id, item]));

  let comparisons: Awaited<ReturnType<typeof compareSources>>[] = [];
  if (clusters.length) {
    yield step("comparing", "Checking supporting evidence across sources", "running");
    const multiSource = clusters.filter((c) => c.sourceCount >= 2).slice(0, MAX_CLUSTERS_TO_COMPARE);
    comparisons = await Promise.all(multiSource.map((cluster) => compareSources(cluster, evidenceById)));
    yield step(
      "comparing",
      "Checking supporting evidence across sources",
      "done",
      multiSource.length ? `Compared ${multiSource.length} multi-source event${multiSource.length === 1 ? "" : "s"}` : "No multi-source events to compare",
    );
  }
  const validComparisons = comparisons.filter((c): c is NonNullable<typeof c> => c !== null);

  yield step("impact", "Analyzing implications", "running");
  const impact = clusters.length ? await analyzeImpact(query, clusters, validComparisons, background) : null;
  yield step("impact", "Analyzing implications", "done");

  yield step("brief", "Generating executive brief", "running");
  const brief = clusters.length ? await generateBrief(query, clusters, validComparisons, impact, evidenceById) : null;
  yield step("brief", "Generating executive brief", "done");

  yield step("verifying", "Verifying citations", "running");
  const citations = brief ? await verifyCitations(brief, evidenceById) : null;
  yield step(
    "verifying",
    "Verifying citations",
    "done",
    citations ? `${citations.checks.length - citations.unsupportedCount - citations.fabricatedCitationCount}/${citations.checks.length} claims verified` : "No brief to verify",
  );

  const confidenceNotes: string[] = [];
  let confidence = 0.5;

  if (citations && citations.checks.length) {
    const verifiedFraction = (citations.checks.length - citations.unsupportedCount - citations.fabricatedCitationCount) / citations.checks.length;
    confidence = verifiedFraction;
    if (citations.fabricatedCitationCount > 0) {
      confidenceNotes.push(`${citations.fabricatedCitationCount} citation(s) referenced a source that was not part of the retrieved evidence.`);
    }
    if (citations.unsupportedCount > 0) {
      confidenceNotes.push(`${citations.unsupportedCount} claim(s) were not clearly supported by their cited source on re-check.`);
    }
  } else if (!brief) {
    confidence = clusters.length ? 0.3 : 0;
    confidenceNotes.push("No executive brief could be generated from the retrieved evidence.");
  }

  const conflictCount = validComparisons.reduce((sum, c) => sum + c.conflicts.length, 0);
  if (conflictCount > 0) {
    confidence = Math.max(0, confidence - Math.min(0.2, conflictCount * 0.05));
    confidenceNotes.push(`${conflictCount} unresolved conflict(s) between sources — see Source Comparison.`);
  }

  const singleSourceClusters = clusters.filter((c) => c.sourceCount === 1).length;
  if (singleSourceClusters > 0) {
    confidenceNotes.push(`${singleSourceClusters} of ${clusters.length} key development(s) are reported by only one source.`);
  }

  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  const state: AgentState = {
    userQuery: query,
    intent: intent.intent,
    entities: intent.entities,
    dateRange: intent.dateRange,
    retrievedSources: [...evidenceById.values()].map((item) => ({
      id: item.id,
      title: item.title,
      source: item.source,
      date: item.date,
      url: item.url,
      kind: item.kind === "uploaded_pdf" ? "article" : item.kind,
    })),
    clusters,
    comparisons: validComparisons,
    backgroundContext: background.map((item) => ({ id: item.id, title: item.title, source: item.source, date: item.date, url: item.url, kind: item.kind as "background" })),
    impact,
    brief,
    citations,
    confidence,
    confidenceNotes,
  };

  yield { type: "result", state };
}

// Non-streaming convenience wrapper used by the evaluation script and any
// caller that just wants the final state.
export async function runAgentToCompletion(query: string): Promise<{ state: AgentState; log: AgentEvent[] }> {
  const log: AgentEvent[] = [];
  let state: AgentState | undefined;
  for await (const event of runAgent(query)) {
    if (event.type === "result") state = event.state;
    else log.push(event);
  }
  if (!state) throw new Error("Agent did not produce a result.");
  return { state, log };
}
