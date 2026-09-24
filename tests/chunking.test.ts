import { describe, expect, it } from "vitest";
import { chunkText } from "@/lib/text";

describe("chunkText", () => {
  it("creates overlapping chunks near the target size", () => {
    const input = Array.from({ length: 3200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const chunks = chunkText(input, 1000, 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].text.length).toBeLessThanOrEqual(1000);
    expect(chunks[1].start).toBeLessThan(chunks[0].end);
  });

  it("rejects invalid overlap", () => {
    expect(() => chunkText("hello", 100, 100)).toThrow();
  });
});
