import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { openai } from "../../openai";
import { env } from "../../config";
import { CITATION_VERIFICATION_SYSTEM_PROMPT } from "../../../prompts/media";
import type { CitationCheck, CitationVerification, EvidenceItem, ExecutiveBrief } from "../types";

// USER PROBLEM: an executive brief with a wrong or fabricated citation is
// worse than no citation — it looks authoritative while being unverifiable
// or false, and undermines trust in the whole product.
// AI CAPABILITY: (1) programmatically confirm every citation ID in the brief
// actually refers to a source that was supplied (catches fabrication
// deterministically, no LLM needed); (2) have a separate model call check
// whether the cited text actually supports each claim (catches
// misattribution the writer step might make).
// OUTPUT: CitationVerification with a per-claim pass/fail and notes.
// MEASURABLE VALUE: this is the "Citation Verification Tool" the product
// spec requires before showing any answer; its pass rate is a headline
// metric in the evaluation harness.

const CITATION_PATTERN = /\[(S\d+|[A-Z]\d+)\]/g;

export function extractClaims(brief: ExecutiveBrief): Array<{ text: string; citationIds: string[] }> {
  // whatHappened / whyItMatters use inline [S#] citations mixed into prose,
  // so split into sentences and read the citation IDs out of each one.
  const claims: Array<{ text: string; citationIds: string[] }> = [];
  for (const prose of [brief.whatHappened, brief.whyItMatters]) {
    for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim();
      const citationIds = [...trimmed.matchAll(CITATION_PATTERN)].map((m) => m[1]);
      if (trimmed && citationIds.length > 0) claims.push({ text: trimmed, citationIds });
    }
  }

  // keyDevelopments carries its citations as a separate sourceIds field
  // rather than inline tags, so pair each summary with its own IDs directly
  // instead of appending "[A1] [A2]" text and re-splitting (that produced a
  // trailing pseudo-sentence made only of tags, with no claim to verify).
  for (const dev of brief.keyDevelopments) {
    const citationIds = [...new Set(dev.sourceIds)];
    if (dev.summary.trim() && citationIds.length > 0) claims.push({ text: dev.summary.trim(), citationIds });
  }

  return claims;
}

const VerifySchema = z.object({
  results: z.array(z.object({
    claimExcerpt: z.string(),
    supported: z.boolean(),
    note: z.string(),
  })),
});

export async function verifyCitations(brief: ExecutiveBrief, evidenceById: Map<string, EvidenceItem>): Promise<CitationVerification> {
  const claims = extractClaims(brief);
  if (!claims.length) return { checks: [], unsupportedCount: 0, fabricatedCitationCount: 0 };

  // Step 1 (deterministic): does every cited ID exist in the evidence we
  // actually supplied? This never requires an LLM call and can never be wrong.
  const withExistence = claims.map((claim) => ({
    ...claim,
    existsInEvidence: claim.citationIds.every((id) => evidenceById.has(id)),
  }));

  const checkable = withExistence.filter((c) => c.existsInEvidence);
  let supportResults = new Map<string, { supported: boolean; note: string }>();

  if (checkable.length) {
    const evidenceText = checkable
      .flatMap((c) => c.citationIds)
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .map((id) => `[${id}] ${evidenceById.get(id)!.content}`)
      .join("\n\n");

    const claimsText = checkable.map((c, i) => `${i + 1}. "${c.text}"`).join("\n");

    const response = await openai().responses.parse({
      model: env().OPENAI_CHAT_MODEL,
      instructions: CITATION_VERIFICATION_SYSTEM_PROMPT,
      input: `CITED SOURCE TEXT:\n${evidenceText}\n\nCLAIMS TO CHECK (in order):\n${claimsText}`,
      text: { format: zodTextFormat(VerifySchema, "citation_verification") },
    });

    const parsed = response.output_parsed;
    if (parsed) {
      parsed.results.forEach((r, i) => {
        const claim = checkable[i];
        if (claim) supportResults.set(claim.text, { supported: r.supported, note: r.note });
      });
    }
  }

  const checks: CitationCheck[] = withExistence.map((claim) => {
    if (!claim.existsInEvidence) {
      return {
        citationId: claim.citationIds.join(","),
        existsInEvidence: false,
        claimExcerpt: claim.text,
        supported: false,
        note: "Cited a source ID that was not part of the retrieved evidence.",
      };
    }
    const support = supportResults.get(claim.text);
    return {
      citationId: claim.citationIds.join(","),
      existsInEvidence: true,
      claimExcerpt: claim.text,
      supported: support?.supported ?? false,
      note: support?.note ?? "Verification model returned no result for this claim.",
    };
  });

  return {
    checks,
    unsupportedCount: checks.filter((c) => c.existsInEvidence && !c.supported).length,
    fabricatedCitationCount: checks.filter((c) => !c.existsInEvidence).length,
  };
}
