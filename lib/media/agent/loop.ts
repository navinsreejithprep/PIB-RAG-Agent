import type OpenAI from "openai";
import { openai } from "../../openai";
import { env } from "../../config";
import { AUTONOMOUS_PLANNER_SYSTEM_PROMPT } from "../../../prompts/agent";
import { AGENT_TOOLS, executeAgentTool } from "./tools";
import type { EvidenceItem } from "../types";

// The autonomous research loop -- the actual "agentic" part. Everything
// downstream of this (clustering, impact analysis, brief writing, citation
// verification) stays the same deterministic pipeline the fixed orchestrator
// uses (see lib/media/agent/orchestrator.ts), so output quality/safety
// guarantees don't regress; only HOW evidence gets gathered is autonomous.
//
// No built-in "runTools" helper exists for the Responses API in the
// installed OpenAI SDK (only Chat Completions has one) -- this loop is
// hand-rolled: call the model, execute any tool calls it requests, feed
// results back in, repeat until it replies with plain text instead of a
// tool call.

// Derived structurally from the client itself rather than deep-importing
// openai's internal Responses type modules (whose exact subpath export
// varies by SDK version) -- this stays correct automatically if the SDK's
// input shape ever changes.
type ResponsesCreateParams = Parameters<InstanceType<typeof OpenAI>["responses"]["create"]>[0];
type ResponsesInput = Extract<ResponsesCreateParams["input"], unknown[]>;
type ResponsesInputItem = ResponsesInput[number];

const MAX_ROUNDS = 8;
const MAX_LOOP_MS = 90_000; // generous margin under this deployment's measured 300s function budget (see README), leaving room for the deterministic finishing phase afterward

export type AgentTraceEvent =
  | { type: "round_start"; round: number; at: string }
  | { type: "tool_call"; round: number; tool: string; args: Record<string, unknown>; at: string }
  | { type: "tool_result"; round: number; tool: string; summary: string; at: string }
  | { type: "wrap_up"; reason: "round_cap" | "time_cap"; at: string };

export type LoopResult = {
  summary: string;
  relevantSourceIds: string[];
  evidencePool: Map<string, EvidenceItem>;
  roundsUsed: number;
  stopReason: "model_finished" | "round_cap" | "time_cap";
};

function now() {
  return new Date().toISOString();
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pure and unit-tested (tests/media-agent-loop.test.ts): finds which known
// evidence IDs the model's free-text summary actually names, rather than
// requiring the model to format a parseable list (which it can get wrong).
export function extractSourceIds(summary: string, knownIds: Iterable<string>): string[] {
  const found: string[] = [];
  for (const id of knownIds) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_:-])${escapeRegExp(id)}([^A-Za-z0-9_:-]|$)`);
    if (pattern.test(summary)) found.push(id);
  }
  return found;
}

export async function* runResearchLoop(query: string): AsyncGenerator<AgentTraceEvent, LoopResult, unknown> {
  const evidencePool = new Map<string, EvidenceItem>();
  let input: ResponsesInputItem[] = [{ role: "user", content: query } as ResponsesInputItem];
  const startedAt = Date.now();
  let round = 0;
  let stopReason: LoopResult["stopReason"] = "model_finished";

  while (true) {
    round++;
    const elapsed = Date.now() - startedAt;
    const overRoundCap = round > MAX_ROUNDS;
    const overTimeCap = elapsed > MAX_LOOP_MS;
    const forceConclude = overRoundCap || overTimeCap;

    yield { type: "round_start", round, at: now() };

    if (forceConclude) {
      stopReason = overTimeCap ? "time_cap" : "round_cap";
      input.push({
        role: "user",
        content: "You have reached the research limit. Stop researching now and reply in plain text with your summary and the relevant source IDs, as instructed.",
      } as ResponsesInputItem);
      yield { type: "wrap_up", reason: stopReason, at: now() };
    }

    const response = await openai().responses.create({
      model: env().OPENAI_CHAT_MODEL,
      instructions: AUTONOMOUS_PLANNER_SYSTEM_PROMPT,
      input,
      // Omitting `tools` entirely (not just tool_choice: "none") when
      // forcing a conclusion, so the model has no way to keep calling tools
      // even if it tried to.
      ...(forceConclude ? {} : { tools: AGENT_TOOLS }),
    });

    const calls = response.output.filter(
      (item): item is Extract<typeof item, { type: "function_call" }> => item.type === "function_call",
    );

    if (!calls.length) {
      const summary = response.output_text?.trim() || "No summary produced.";
      return {
        summary,
        relevantSourceIds: extractSourceIds(summary, evidencePool.keys()),
        evidencePool,
        roundsUsed: round,
        stopReason,
      };
    }

    input.push(...(response.output as ResponsesInputItem[]));

    for (const call of calls) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = {};
      }
      yield { type: "tool_call", round, tool: call.name, args: (args ?? {}) as Record<string, unknown>, at: now() };

      let result;
      try {
        result = await executeAgentTool(call.name, args, evidencePool);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { output: JSON.stringify({ error: message }), summary: `error: ${message}` };
      }
      yield { type: "tool_result", round, tool: call.name, summary: result.summary, at: now() };

      input.push({ type: "function_call_output", call_id: call.call_id, output: result.output } as ResponsesInputItem);
    }
  }
}
