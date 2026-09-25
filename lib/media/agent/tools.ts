import { z } from "zod";
import { zodResponsesFunction } from "openai/helpers/zod";
import { newsSearch, retrieveBackground, searchUploadedDocuments } from "../tools/search";
import { compareSources } from "../tools/compare";
import type { EvidenceItem, EventCluster } from "../types";

// Tool definitions the autonomous planner (lib/media/agent/loop.ts) can call.
// Deliberately a SUBSET of the 8 tools the fixed pipeline (orchestrator.ts)
// always runs: only the ones with a genuine decision behind them (what to
// search, whether results are strong enough, whether two sources conflict).
// Clustering, impact analysis, brief-writing and citation verification stay
// deterministic post-processing in lib/media/agent/orchestrator.ts's finish
// phase -- there's no autonomy benefit to letting the model "decide" to skip
// citation verification, for instance, and real safety cost if it could.

// OpenAI's strict function-calling schemas require every property to be
// present in `required`, with optionality expressed as nullable rather than
// `.optional()` (an all-fields-required constraint of structured outputs) --
// so "not provided" arrives as `null`, not `undefined`; executeAgentTool
// below normalizes that back to `undefined` before calling the underlying
// search functions.
const SearchNewsArgs = z.object({
  query: z.string().min(2).describe("What to search for. Be specific -- narrow queries return more useful results than broad ones."),
  topic: z.string().nullable().describe("Restrict to one known topic if the question clearly names one (e.g. \"policy\", \"auctions\", \"storage\"). Null if unsure."),
  source: z.string().nullable().describe("Restrict to one named outlet/ministry if the question asks about a specific one. Null otherwise."),
  startDate: z.string().nullable().describe("YYYY-MM-DD. Only set if the question implies a date range, else null."),
  endDate: z.string().nullable().describe("YYYY-MM-DD, else null."),
});

const SearchBackgroundArgs = z.object({
  query: z.string().min(2).describe("What background/reference concept to look up (e.g. how an auction works, what a term means)."),
});

const SearchUploadedDocsArgs = z.object({
  query: z.string().min(2).describe("What to search for within any PDFs the user has separately uploaded."),
});

const CompareSourcesArgs = z.object({
  sourceIds: z.array(z.string()).min(2).max(6).describe("2-6 source IDs previously returned by a search_* call, believed to cover the same event."),
});

export const AGENT_TOOLS = [
  zodResponsesFunction({
    name: "search_news",
    description: "Semantic search over a live index of news articles and government press releases. Returns up to 8 ranked results with a short preview, not full text.",
    parameters: SearchNewsArgs,
  }),
  zodResponsesFunction({
    name: "search_background",
    description: "Search reference/explainer material (definitions, how things work) -- not news events. Use for context needed to interpret a news result, not to find developments themselves.",
    parameters: SearchBackgroundArgs,
  }),
  zodResponsesFunction({
    name: "search_uploaded_documents",
    description: "Search any PDFs the user has separately uploaded through the document chatbot. Only call this if the question could plausibly relate to an uploaded document.",
    parameters: SearchUploadedDocsArgs,
  }),
  zodResponsesFunction({
    name: "compare_sources",
    description: "Compare 2-6 already-found source IDs for agreement, differences, and direct conflicts on the same facts. Use to decide whether evidence is consistent enough to stop researching.",
    parameters: CompareSourcesArgs,
  }),
];

const SEARCH_RESULT_LIMIT = 8;

export type ToolCallResult = { output: string; summary: string };

function compactSearchResult(items: EvidenceItem[]): ToolCallResult {
  if (!items.length) return { output: JSON.stringify({ results: [] }), summary: "0 results" };
  // Compact, not full content: the loop's own context must stay small across
  // several rounds. Full text is available from the shared evidencePool for
  // the deterministic finishing phase afterward (orchestrator.ts), which is
  // the only place the model's context size doesn't bound what's usable.
  const compact = items.map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    date: item.date,
    similarity: Number(item.similarity.toFixed(2)),
    preview: item.content.slice(0, 160),
  }));
  return {
    output: JSON.stringify({ results: compact }),
    summary: `${items.length} result(s): ${items.slice(0, 3).map((item) => item.id).join(", ")}${items.length > 3 ? "…" : ""}`,
  };
}

// Executes one tool call by name. evidencePool accumulates every EvidenceItem
// any search_* call has ever surfaced this session (deduped by id) -- it's
// the running memory the loop can't hold in the model's own context, and
// it's what gets handed to the deterministic finishing phase once the loop
// concludes.
export async function executeAgentTool(name: string, rawArgs: unknown, evidencePool: Map<string, EvidenceItem>): Promise<ToolCallResult> {
  switch (name) {
    case "search_news": {
      const args = SearchNewsArgs.parse(rawArgs);
      const results = await newsSearch(args.query, {
        topic: args.topic ?? undefined,
        source: args.source ?? undefined,
        startDate: args.startDate ?? undefined,
        endDate: args.endDate ?? undefined,
        limit: SEARCH_RESULT_LIMIT,
      });
      for (const item of results) evidencePool.set(item.id, item);
      return compactSearchResult(results);
    }

    case "search_background": {
      const args = SearchBackgroundArgs.parse(rawArgs);
      const results = await retrieveBackground(args.query, SEARCH_RESULT_LIMIT);
      for (const item of results) evidencePool.set(item.id, item);
      return compactSearchResult(results);
    }

    case "search_uploaded_documents": {
      const args = SearchUploadedDocsArgs.parse(rawArgs);
      const results = await searchUploadedDocuments(args.query);
      for (const item of results) evidencePool.set(item.id, item);
      return compactSearchResult(results);
    }

    case "compare_sources": {
      const args = CompareSourcesArgs.parse(rawArgs);
      const items = args.sourceIds.map((id) => evidencePool.get(id)).filter((item): item is EvidenceItem => Boolean(item));
      const missing = args.sourceIds.filter((id) => !evidencePool.has(id));

      if (items.length < 2) {
        const message = missing.length
          ? `Could not compare: unknown source ID(s) ${missing.join(", ")} -- only IDs returned by a previous search call can be compared.`
          : "Could not compare: need at least 2 valid source IDs.";
        return { output: JSON.stringify({ error: message }), summary: message };
      }

      const adHocCluster: EventCluster = {
        id: "adhoc",
        headline: items[0].title,
        sourceIds: items.map((item) => item.id),
        sourceCount: items.length,
        dateRange: { earliest: "", latest: "" },
        sources: items.map((item) => ({ id: item.id, title: item.title, source: item.source, date: item.date, url: item.url, similarity: item.similarity })),
        keyFacts: [],
      };
      const comparison = await compareSources(adHocCluster, evidencePool);
      if (!comparison) {
        const message = "Comparison could not be produced.";
        return { output: JSON.stringify({ error: message }), summary: message };
      }
      const summary = `${comparison.commonFacts.length} common fact(s), ${comparison.conflicts.length} conflict(s), ${comparison.differences.length} difference(s)` +
        (comparison.conflicts.length ? `: ${comparison.conflicts.map((c) => c.issue).join("; ")}` : "");
      return { output: JSON.stringify(comparison), summary };
    }

    default:
      throw new Error(`Unknown tool requested by the model: ${name}`);
  }
}
