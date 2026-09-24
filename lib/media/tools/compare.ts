import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { openai } from "../../openai";
import { env } from "../../config";
import { COMPARE_SOURCES_SYSTEM_PROMPT } from "../../../prompts/media";
import type { EventCluster, EvidenceItem, SourceComparison } from "../types";

// USER PROBLEM: when several outlets cover one event, they often disagree on
// specifics (a subsidy figure, a tariff, whether a project is "on schedule"
// or "delayed") and an executive reading only one article won't know that.
// AI CAPABILITY: for each multi-source event cluster, extract what sources
// agree on, what only some report, and where they genuinely conflict —
// without picking a winner.
// OUTPUT: SourceComparison per cluster.
// MEASURABLE VALUE: surfaces exactly the kind of discrepancy (e.g. "₹1.2
// lakh crore" vs "₹1.5 lakh crore" for the same policy) that a single-
// article summary would silently drop; the sample dataset includes several
// such cases by design so this is directly testable (see
// tests/evaluation-dataset.json).

const ComparisonSchema = z.object({
  commonFacts: z.array(z.string()).max(10),
  differences: z.array(z.string()).max(10),
  conflicts: z.array(z.object({
    issue: z.string(),
    positions: z.array(z.object({ sourceId: z.string(), claim: z.string() })).max(6),
  })).max(8),
  unsupportedAssertions: z.array(z.string()).max(6),
});

export async function compareSources(cluster: EventCluster, evidenceById: Map<string, EvidenceItem>): Promise<SourceComparison | null> {
  if (cluster.sourceCount < 2) return null;

  const excerpts = cluster.sourceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is EvidenceItem => Boolean(item))
    .map((item) => `[${item.id}] ${item.source} (${item.date}) — ${item.title}\n${item.content}`)
    .join("\n\n---\n\n");

  const response = await openai().responses.parse({
    model: env().OPENAI_CHAT_MODEL,
    instructions: COMPARE_SOURCES_SYSTEM_PROMPT,
    input: `ARTICLES COVERING THE SAME EVENT:\n\n${excerpts}`,
    text: { format: zodTextFormat(ComparisonSchema, "source_comparison") },
  });

  const parsed = response.output_parsed;
  if (!parsed) return null;
  return { clusterId: cluster.id, ...parsed };
}
