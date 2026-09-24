import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { openai } from "../../openai";
import { env } from "../../config";
import { IMPACT_ANALYSIS_SYSTEM_PROMPT } from "../../../prompts/media";
import type { EventCluster, EvidenceItem, ImpactAnalysis, SourceComparison } from "../types";

// USER PROBLEM: a list of facts ("cabinet approved X", "duty raised to Y%")
// tells an executive what happened but not whether they should care, or what
// to do next.
// AI CAPABILITY: turn clustered, compared evidence into a structured
// what-happened / why-it-matters / implications / risks / what-to-watch
// analysis, keeping cited fact separate from forward-looking judgment.
// OUTPUT: ImpactAnalysis.
// MEASURABLE VALUE: this is the step that answers "why does it matter?" and
// "what should I monitor next?" — the two questions the product brief
// (section 1) says plain summarization does not answer.

const ImpactSchema = z.object({
  whatHappened: z.string(),
  whyItMatters: z.string(),
  potentialImplications: z.array(z.string()).max(8),
  risksAndUncertainties: z.array(z.string()).max(8),
  whatToWatch: z.array(z.string()).max(8),
});

export async function analyzeImpact(
  query: string,
  clusters: EventCluster[],
  comparisons: SourceComparison[],
  background: EvidenceItem[],
): Promise<ImpactAnalysis | null> {
  if (!clusters.length) return null;

  const clusterText = clusters
    .map((c) => `EVENT ${c.id}: ${c.headline}\nSources: ${c.sourceIds.join(", ")}\nDate range: ${c.dateRange.earliest} to ${c.dateRange.latest}`)
    .join("\n\n");

  const comparisonText = comparisons
    .map((c) => {
      const conflicts = c.conflicts.map((cf) => `  - ${cf.issue}: ${cf.positions.map((p) => `[${p.sourceId}] ${p.claim}`).join(" vs. ")}`).join("\n");
      return `COMPARISON for ${c.clusterId}:\nCommon: ${c.commonFacts.join("; ") || "none"}\nConflicts:\n${conflicts || "  none"}`;
    })
    .join("\n\n");

  const backgroundText = background.map((b) => `[${b.id}] ${b.title}\n${b.content}`).join("\n\n");

  const response = await openai().responses.parse({
    model: env().OPENAI_CHAT_MODEL,
    instructions: IMPACT_ANALYSIS_SYSTEM_PROMPT,
    input: `USER QUESTION:\n${query}\n\nCLUSTERED EVENTS:\n${clusterText}\n\nSOURCE COMPARISONS:\n${comparisonText || "none"}\n\nBACKGROUND CONTEXT:\n${backgroundText || "none"}`,
    text: { format: zodTextFormat(ImpactSchema, "impact_analysis") },
  });

  return response.output_parsed;
}
