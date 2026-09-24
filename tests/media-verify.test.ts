import { describe, expect, it } from "vitest";
import { extractClaims } from "@/lib/media/tools/verify";
import type { ExecutiveBrief } from "@/lib/media/types";

function brief(overrides: Partial<ExecutiveBrief> = {}): ExecutiveBrief {
  return {
    headline: "Headline",
    executiveSummary: "Summary",
    whatHappened: "",
    whyItMatters: "",
    keyDevelopments: [],
    potentialImplications: [],
    risksAndUncertainties: [],
    whatToWatch: [],
    ...overrides,
  };
}

describe("extractClaims", () => {
  it("pairs inline citations in whatHappened/whyItMatters with their sentence", () => {
    const claims = extractClaims(brief({
      whatHappened: "The cabinet approved the framework [A01]. It raises the purchase obligation to 43% [A02].",
      whyItMatters: "This affects state utilities [A02].",
    }));
    expect(claims).toHaveLength(3);
    expect(claims[0]).toEqual({ text: "The cabinet approved the framework [A01].", citationIds: ["A01"] });
    expect(claims[1].citationIds).toEqual(["A02"]);
    expect(claims[2].citationIds).toEqual(["A02"]);
  });

  it("ignores sentences with no citation", () => {
    const claims = extractClaims(brief({ whatHappened: "This sentence has no citation. Neither does this one." }));
    expect(claims).toHaveLength(0);
  });

  it("pairs each key development's summary with its own sourceIds, not a trailing tag-only fragment", () => {
    const claims = extractClaims(brief({
      keyDevelopments: [
        { headline: "Storage funding expands", summary: "Viability gap funding was expanded to 30 GWh.", sourceIds: ["A14", "A15"] },
      ],
    }));
    // Regression test: this used to produce a second, bogus claim consisting
    // only of "[A14] [A15]" with no actual claim text (see lib/media/tools/verify.ts).
    expect(claims).toHaveLength(1);
    expect(claims[0]).toEqual({ text: "Viability gap funding was expanded to 30 GWh.", citationIds: ["A14", "A15"] });
  });

  it("skips key developments with no sourceIds", () => {
    const claims = extractClaims(brief({
      keyDevelopments: [{ headline: "H", summary: "Uncited summary.", sourceIds: [] }],
    }));
    expect(claims).toHaveLength(0);
  });

  it("deduplicates repeated source IDs on a key development", () => {
    const claims = extractClaims(brief({
      keyDevelopments: [{ headline: "H", summary: "Summary.", sourceIds: ["A01", "A01", "A02"] }],
    }));
    expect(claims[0].citationIds).toEqual(["A01", "A02"]);
  });
});
