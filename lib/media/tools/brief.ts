import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { openai } from "../../openai";
import { env } from "../../config";
import { BRIEF_SYSTEM_PROMPT } from "../../../prompts/media";
import type { EventCluster, EvidenceItem, ExecutiveBrief, ImpactAnalysis, SourceComparison } from "../types";

// USER PROBLEM: even the intermediate outputs above (clusters, comparisons,
// impact analysis) are still analyst-shaped, not something you hand to an
// executive.
// AI CAPABILITY: synthesize everything upstream into the fixed executive
// brief format from the product spec, with inline [S#] citations on every
// material claim.
// OUTPUT: ExecutiveBrief.
// MEASURABLE VALUE: this is the artifact the product exists to produce;
// citation density/accuracy on this output is what
// lib/media/tools/verify.ts and the evaluation harness score.

const BriefSchema = z.object({
  headline: z.string(),
  executiveSummary: z.string(),
  whatHappened: z.string(),
  whyItMatters: z.string(),
  keyDevelopments: z.array(z.object({
    headline: z.string(),
    summary: z.string(),
    sourceIds: z.array(z.string()).max(6),
  })).max(8),
  potentialImplications: z.array(z.string()).max(8),
  risksAndUncertainties: z.array(z.string()).max(8),
  whatToWatch: z.array(z.string()).max(8),
});

export async function generateBrief(
  query: string,
  clusters: EventCluster[],
  comparisons: SourceComparison[],
  impact: ImpactAnalysis | null,
  evidenceById: Map<string, EvidenceItem>,
): Promise<ExecutiveBrief | null> {
  if (!clusters.length) return null;

  const evidenceText = [...evidenceById.values()]
    .map((item) => `[${item.id}] ${item.source}${item.date ? ` (${item.date})` : ""} — ${item.title}\n${item.content}`)
    .join("\n\n---\n\n");

  const comparisonText = comparisons
    .map((c) => `Comparison ${c.clusterId}: common=${c.commonFacts.join("; ") || "none"}; conflicts=${c.conflicts.map((cf) => cf.issue).join("; ") || "none"}`)
    .join("\n");

  const impactText = impact
    ? `whatHappened: ${impact.whatHappened}\nwhyItMatters: ${impact.whyItMatters}\nimplications: ${impact.potentialImplications.join("; ")}\nrisks: ${impact.risksAndUncertainties.join("; ")}\nwatch: ${impact.whatToWatch.join("; ")}`
    : "none";

  const response = await openai().responses.parse({
    model: env().OPENAI_CHAT_MODEL,
    instructions: BRIEF_SYSTEM_PROMPT,
    input: `USER QUESTION:\n${query}\n\nAVAILABLE SOURCES (cite only these IDs):\n${[...evidenceById.keys()].join(", ")}\n\nEVIDENCE:\n${evidenceText}\n\nSOURCE COMPARISONS:\n${comparisonText || "none"}\n\nDRAFT IMPACT ANALYSIS (for reference, rewrite in your own words with citations):\n${impactText}`,
    text: { format: zodTextFormat(BriefSchema, "executive_brief") },
  });

  return response.output_parsed;
}
