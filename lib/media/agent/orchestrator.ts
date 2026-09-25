import { classifyIntent } from "../tools/intent";
import { clusterArticles } from "../tools/cluster";
import { compareSources } from "../tools/compare";
import { analyzeImpact } from "../tools/impact";
import { generateBrief } from "../tools/brief";
import { verifyCitations } from "../tools/verify";
import { runResearchLoop, type AgentTraceEvent, type LoopResult } from "./loop";
import type { AgentState, EvidenceItem } from "../types";

// Autonomous counterpart to lib/media/orchestrator.ts's runAgent(). Deliberately
// reuses that file's deterministic finishing phase verbatim in structure
// (clustering -> comparison -> impact -> brief -> citation verification ->
// confidence scoring) -- the only thing that's actually autonomous here is
// HOW evidence gets gathered (lib/media/agent/loop.ts's ReAct loop), not
// whether the output is verified before being shown. Kept as a fully
// separate module rather than merged into orchestrator.ts so the fixed
// pipeline -- tested, evaluated, and what the demo/eval suite depend on --
// is untouched by this.

export type AutonomousEvent =
  | { type: "status"; step: string; label: string; status: "running" | "done"; detail?: string; at: string }
  | { type: "trace"; event: AgentTraceEvent }
  | { type: "result"; state: AgentState; trace: AgentTraceEvent[] };

const MAX_CLUSTERS_FOR_SYNTHESIS = 8;
const MAX_CLUSTERS_TO_COMPARE = 5;

function now() {
  return new Date().toISOString();
}

function emptyState(query: string, intent: Awaited<ReturnType<typeof classifyIntent>>, loop: LoopResult): AgentState {
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
    confidenceNotes: [
      "The autonomous agent found no relevant sources.",
      loop.summary,
      `Stopped after ${loop.roundsUsed} round(s) (${loop.stopReason.replace(/_/g, " ")}).`,
    ].filter(Boolean),
  };
}

export async function* runAutonomousAgent(query: string): AsyncGenerator<AutonomousEvent, void, unknown> {
  const step = (s: string, label: string, status: "running" | "done", detail?: string): AutonomousEvent =>
    ({ type: "status", step: s, label, status, detail, at: now() });

  yield step("understanding", "Understanding request", "running");
  const intent = await classifyIntent(query);
  yield step("understanding", "Understanding request", "done", `Intent: ${intent.intent.replace(/_/g, " ")}`);

  yield step("research", "Autonomous research (agent deciding what to search)", "running");
  const trace: AgentTraceEvent[] = [];
  const loopGenerator = runResearchLoop(query);
  let loopResult: LoopResult | undefined;
  while (true) {
    const { value, done } = await loopGenerator.next();
    if (done) {
      loopResult = value;
      break;
    }
    trace.push(value);
    yield { type: "trace", event: value };
  }
  yield step(
    "research",
    "Autonomous research (agent deciding what to search)",
    "done",
    `${loopResult.roundsUsed} round${loopResult.roundsUsed === 1 ? "" : "s"}, ${loopResult.evidencePool.size} source${loopResult.evidencePool.size === 1 ? "" : "s"} found, stopped: ${loopResult.stopReason.replace(/_/g, " ")}`,
  );

  const evidence = [...loopResult.evidencePool.values()];
  if (!evidence.length) {
    yield { type: "result", state: emptyState(query, intent, loopResult), trace };
    return;
  }

  const background = evidence.filter((item) => item.kind === "background");
  const newsAndDocs = evidence.filter((item): item is EvidenceItem => item.kind !== "background");

  yield step("clustering", "Clustering related coverage", "running");
  const allClusters = await clusterArticles(newsAndDocs);
  const clusters = allClusters.slice(0, MAX_CLUSTERS_FOR_SYNTHESIS);
  yield step("clustering", "Clustering related coverage", "done", `${newsAndDocs.length} sources → ${allClusters.length} distinct event${allClusters.length === 1 ? "" : "s"}`);

  const evidenceById = new Map<string, EvidenceItem>(evidence.map((item) => [item.id, item]));

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

  confidenceNotes.push(`Agent used ${loopResult.roundsUsed} research round${loopResult.roundsUsed === 1 ? "" : "s"} (stopped: ${loopResult.stopReason.replace(/_/g, " ")}).`);

  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  const state: AgentState = {
    userQuery: query,
    intent: intent.intent,
    entities: intent.entities,
    dateRange: intent.dateRange,
    retrievedSources: newsAndDocs.map((item) => ({
      id: item.id,
      title: item.title,
      source: item.source,
      date: item.date,
      url: item.url,
      kind: item.kind === "uploaded_pdf" ? "article" : item.kind,
    })),
    clusters,
    comparisons: validComparisons,
    backgroundContext: background.map((item) => ({ id: item.id, title: item.title, source: item.source, date: item.date, url: item.url, kind: "background" as const })),
    impact,
    brief,
    citations,
    confidence,
    confidenceNotes,
  };

  yield { type: "result", state, trace };
}
