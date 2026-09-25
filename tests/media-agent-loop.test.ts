import { describe, expect, it, vi, afterEach } from "vitest";
import { extractSourceIds } from "@/lib/media/agent/loop";

describe("extractSourceIds", () => {
  it("finds known IDs that appear as whole tokens in free text", () => {
    const found = extractSourceIds("The key sources are A01 and PIB-2314488, plus B03.", ["A01", "PIB-2314488", "B03", "A02"]);
    expect(found.sort()).toEqual(["A01", "B03", "PIB-2314488"].sort());
  });

  it("does not match an ID that is only a substring of a longer token (A1 inside A10)", () => {
    const found = extractSourceIds("Source A10 is the most relevant.", ["A1", "A10"]);
    expect(found).toEqual(["A10"]);
  });

  it("returns nothing when no known ID appears", () => {
    expect(extractSourceIds("No relevant evidence was found.", ["A01", "A02"])).toEqual([]);
  });

  it("matches IDs at the very start or end of the text", () => {
    expect(extractSourceIds("A01 is relevant", ["A01"])).toEqual(["A01"]);
    expect(extractSourceIds("relevant: A01", ["A01"])).toEqual(["A01"]);
  });
});

// Control-flow tests for the loop's round/time caps -- the single most
// safety-critical property of the autonomous agent (an unbounded loop is a
// real cost/availability risk, not just a quality one). Mocks the OpenAI
// client rather than hitting the real API, so these run in CI without cost
// or network flakiness.
vi.mock("@/lib/openai", () => ({
  openai: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  env: () => ({ OPENAI_CHAT_MODEL: "test-model" }),
}));
vi.mock("@/lib/media/agent/tools", () => ({
  AGENT_TOOLS: [],
  executeAgentTool: vi.fn().mockResolvedValue({ output: "{}", summary: "mock result" }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("runResearchLoop", () => {
  it("stops naturally when the model returns text instead of a tool call", async () => {
    const { openai } = await import("@/lib/openai");
    vi.mocked(openai).mockReturnValue({
      responses: {
        create: vi.fn().mockResolvedValue({ output: [{ type: "message" }], output_text: "Found nothing relevant. No source IDs." }),
      },
    } as never);

    const { runResearchLoop } = await import("@/lib/media/agent/loop");
    const gen = runResearchLoop("test query");
    let result;
    while (true) {
      const { done, value } = await gen.next();
      if (done) {
        result = value;
        break;
      }
    }
    expect(result.stopReason).toBe("model_finished");
    expect(result.roundsUsed).toBe(1);
  });

  it("enforces the round cap and never exceeds it, even if the model always wants to call another tool", async () => {
    const { openai } = await import("@/lib/openai");
    const create = vi.fn().mockImplementation(async (params: { tools?: unknown[] }) => {
      // Once the loop stops passing `tools` (forcing conclusion), simulate
      // the model complying and returning plain text.
      if (!params.tools) {
        return { output: [{ type: "message" }], output_text: "Wrapping up now. No source IDs." };
      }
      return {
        output: [{ type: "function_call", name: "search_news", arguments: "{\"query\":\"x\"}", call_id: "call_1" }],
        output_text: "",
      };
    });
    vi.mocked(openai).mockReturnValue({ responses: { create } } as never);

    const { runResearchLoop } = await import("@/lib/media/agent/loop");
    const gen = runResearchLoop("test query");
    let rounds = 0;
    let result;
    while (true) {
      const { done, value } = await gen.next();
      if (done) {
        result = value;
        break;
      }
      if (value.type === "round_start") rounds = value.round;
    }
    expect(result.stopReason).toBe("round_cap");
    // The loop must actually terminate -- this is the property under test.
    expect(rounds).toBeLessThanOrEqual(9); // MAX_ROUNDS + 1 forced wrap-up round
    expect(create.mock.calls.length).toBeLessThanOrEqual(9);
  });
});
