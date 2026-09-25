import { describe, expect, it } from "vitest";
import { executeAgentTool } from "@/lib/media/agent/tools";
import type { EvidenceItem } from "@/lib/media/types";

function item(id: string): EvidenceItem {
  return { id, kind: "article", title: `Title ${id}`, source: "Source", date: "2026-01-01", url: "", content: "Content.", similarity: 0.5 };
}

describe("executeAgentTool: compare_sources argument validation", () => {
  // These paths return before ever calling the LLM-backed compareSources(),
  // so they're testable without mocking OpenAI -- unlike search_news etc.,
  // whose happy paths call embedTexts() and belong to lib/media/tools/search.ts's
  // own concerns rather than this adapter layer.

  it("rejects source IDs that were never returned by a previous search", async () => {
    const pool = new Map<string, EvidenceItem>([["A01", item("A01")], ["A02", item("A02")]]);
    const result = await executeAgentTool("compare_sources", { sourceIds: ["A01", "A99"] }, pool);
    const parsed = JSON.parse(result.output);
    expect(parsed.error).toMatch(/unknown source ID/i);
    expect(parsed.error).toContain("A99");
    expect(result.summary).toBe(parsed.error);
  });

  it("reports all missing IDs, not just the first, when multiple are unknown", async () => {
    const pool = new Map<string, EvidenceItem>([["A01", item("A01")]]);
    const result = await executeAgentTool("compare_sources", { sourceIds: ["A98", "A99"] }, pool);
    const parsed = JSON.parse(result.output);
    expect(parsed.error).toContain("A98");
    expect(parsed.error).toContain("A99");
  });

  it("rejects fewer than 2 source IDs via schema validation before reaching the handler", async () => {
    await expect(executeAgentTool("compare_sources", { sourceIds: ["A01"] }, new Map([["A01", item("A01")]]))).rejects.toThrow();
  });

  it("throws for an unknown tool name", async () => {
    await expect(executeAgentTool("not_a_real_tool", {}, new Map())).rejects.toThrow(/unknown tool/i);
  });
});
