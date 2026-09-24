import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { openai } from "../../openai";
import { env } from "../../config";
import { INTENT_SYSTEM_PROMPT } from "../../../prompts/media";
import { INTENTS, type IntentClassification } from "../types";

const IntentSchema = z.object({
  intent: z.enum(INTENTS),
  entities: z.array(z.string()).max(10),
  topics: z.array(z.string()).max(6),
  dateRange: z.object({ start: z.string().nullable(), end: z.string().nullable() }),
  needsResearch: z.boolean(),
});

// USER PROBLEM: executives phrase requests loosely ("what's going on with
// India solar", "compare the two reports on X"). Routing every request
// through the same fixed pipeline either over-processes simple asks or
// under-processes complex ones.
// AI CAPABILITY: classify intent + extract entities/dates so the orchestrator
// can skip steps a simple request doesn't need (e.g. skip clustering for a
// single-fact lookup).
// OUTPUT: structured IntentClassification.
// MEASURABLE VALUE: fewer LLM calls (lower cost/latency) on simple queries;
// see docs/architecture.md for the step-skipping logic this enables.
export async function classifyIntent(query: string): Promise<IntentClassification> {
  const response = await openai().responses.parse({
    model: env().OPENAI_CHAT_MODEL,
    instructions: INTENT_SYSTEM_PROMPT,
    input: `USER REQUEST:\n${query}\n\nKnown dataset topics: policy, manufacturing, auctions, grid, offshore-wind, storage, hydrogen, rooftop-solar, wind, technology, transport, reference.`,
    text: { format: zodTextFormat(IntentSchema, "intent_classification") },
  });

  const parsed = response.output_parsed;
  if (!parsed) throw new Error("Intent classification returned no structured output.");
  return parsed;
}
