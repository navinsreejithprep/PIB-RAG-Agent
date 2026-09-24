import { describe, expect, it } from "vitest";
import { groupBySimilarity } from "@/lib/media/tools/cluster";
import type { EvidenceItem } from "@/lib/media/types";

function article(id: string, date: string): EvidenceItem {
  return { id, kind: "article", title: `Title ${id}`, source: `Source ${id}`, date, url: "", content: "", similarity: 0.5 };
}

describe("groupBySimilarity", () => {
  it("groups articles whose embeddings are above the similarity threshold", () => {
    const items = [article("A", "2026-01-01"), article("B", "2026-01-02"), article("C", "2026-01-03")];
    // A and B are near-identical vectors; C points a different direction.
    const vectors = [
      [1, 0, 0],
      [0.99, 0.14, 0],
      [0, 0, 1],
    ];
    const clusters = groupBySimilarity(items, vectors, 0.6);
    expect(clusters).toHaveLength(2);
    const merged = clusters.find((c) => c.sourceCount === 2)!;
    expect(new Set(merged.sourceIds)).toEqual(new Set(["A", "B"]));
    expect(merged.dateRange).toEqual({ earliest: "2026-01-01", latest: "2026-01-02" });
  });

  it("keeps every article separate when nothing clears the threshold", () => {
    const items = [article("A", "2026-01-01"), article("B", "2026-01-02")];
    const vectors = [[1, 0], [0, 1]];
    const clusters = groupBySimilarity(items, vectors, 0.6);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.sourceCount === 1)).toBe(true);
  });

  it("transitively merges A-B and B-C into one cluster even if A-C alone would not qualify", () => {
    const items = [article("A", "2026-01-01"), article("B", "2026-01-02"), article("C", "2026-01-03")];
    // Unit vectors at 0°, 15°, 30°: cos(15°)≈0.966 (A-B and B-C both clear a
    // 0.9 threshold), but cos(30°)≈0.866 (A-C alone would not).
    const vectors: [number, number][] = [
      [1, 0],
      [Math.cos(Math.PI / 12), Math.sin(Math.PI / 12)],
      [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)],
    ];
    expect(vectors[0][0] * vectors[2][0] + vectors[0][1] * vectors[2][1]).toBeLessThan(0.9); // sanity-check A-C is sub-threshold
    const clusters = groupBySimilarity(items, vectors, 0.9);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sourceCount).toBe(3);
  });

  it("handles a single article without needing any vectors", () => {
    const clusters = groupBySimilarity([article("A", "2026-01-01")], []);
    expect(clusters).toEqual([
      {
        id: "E1",
        headline: "Title A",
        sourceIds: ["A"],
        sourceCount: 1,
        dateRange: { earliest: "2026-01-01", latest: "2026-01-01" },
        sources: [{ id: "A", title: "Title A", source: "Source A", date: "2026-01-01", url: "", similarity: 0.5 }],
        keyFacts: [],
      },
    ]);
  });

  it("sorts the largest, most-corroborated clusters first", () => {
    const items = [article("A", "2026-01-01"), article("B", "2026-01-02"), article("C", "2026-01-03"), article("D", "2026-01-04")];
    const vectors = [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const clusters = groupBySimilarity(items, vectors, 0.9);
    expect(clusters[0].sourceCount).toBe(3);
    expect(clusters[1].sourceCount).toBe(1);
  });
});
