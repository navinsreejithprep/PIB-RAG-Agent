import { embedTexts } from "../../openai";
import { getMediaStore, type MediaSearchOptions } from "../store";
import { retrieve as retrievePdfChunks } from "../../rag";
import type { EvidenceItem, MediaSearchResult } from "../types";

// USER PROBLEM: an executive can't manually read hundreds of articles to
// find the handful relevant to a question.
// AI CAPABILITY: semantic + metadata search over the sample news dataset
// (News Search Tool), with an optional pass over any PDFs the user uploaded
// via the V1 DocQuery pipeline (Document Search Tool) so internal documents
// and public coverage are searched side by side.
// OUTPUT: ranked EvidenceItem[], a shape shared by both tools so downstream
// steps (clustering, comparison, impact analysis) don't need to know which
// source a piece of evidence came from.
// MEASURABLE VALUE: replaces manual keyword search with ranked semantic
// retrieval; retrieval relevance is scored in the evaluation harness
// (scripts/evaluate-media.mjs).

function toEvidence(item: MediaSearchResult): EvidenceItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    source: item.source,
    date: item.date,
    url: item.url,
    content: item.content,
    similarity: item.similarity,
  };
}

// Calibrated against this sample dataset (see docs/architecture.md "Retrieval
// tuning"): a clearly on-topic query's real matches score roughly 0.24-0.59
// cosine similarity, while an off-topic query's *best* match can still score
// ~0.50 because text-embedding-3-small does not separate short, topically-
// adjacent news cleanly on cosine similarity alone. 0.28 trims the weakest
// noise without cutting genuinely relevant items; it does not, by itself,
// guarantee off-topic queries retrieve nothing — the brief-writing prompt is
// what is responsible for saying evidence is insufficient when the retrieved
// set does not actually answer the question.
const DEFAULT_MIN_SIMILARITY = 0.28;

export async function newsSearch(query: string, options: Omit<MediaSearchOptions, "queryEmbedding"> = {}): Promise<EvidenceItem[]> {
  const [queryEmbedding] = await embedTexts([query]);
  const results = await getMediaStore().search({ ...options, queryEmbedding, minSimilarity: options.minSimilarity ?? DEFAULT_MIN_SIMILARITY });
  return results.map(toEvidence);
}

export async function searchByTopic(topic: string, limit = 20): Promise<EvidenceItem[]> {
  const results = await getMediaStore().search({ topic, limit });
  return results.map(toEvidence);
}

export async function searchByDateRange(query: string, startDate?: string, endDate?: string, limit = 20): Promise<EvidenceItem[]> {
  return newsSearch(query, { startDate, endDate, limit });
}

export async function searchBySource(query: string, source: string, limit = 20): Promise<EvidenceItem[]> {
  return newsSearch(query, { source, limit });
}

// Context Retrieval Tool: pulls reference/explainer material (e.g. "how do
// renewable auctions work") rather than news events, so the impact-analysis
// and brief-writing steps have definitions and context to draw on, not just
// raw headlines.
export async function retrieveBackground(query: string, limit = 4): Promise<EvidenceItem[]> {
  const [queryEmbedding] = await embedTexts([query]);
  const results = await getMediaStore().search({ kind: "background", queryEmbedding, limit, minSimilarity: 0.1 });
  return results.map(toEvidence);
}

// Document Search Tool: reuses the V1 PDF RAG pipeline unchanged (lib/rag.ts)
// so any PDFs the user has uploaded through the original DocQuery UI are
// available as additional evidence for the same question, in the same
// EvidenceItem shape as news articles.
export async function searchUploadedDocuments(query: string): Promise<EvidenceItem[]> {
  try {
    const chunks = await retrievePdfChunks(query);
    return chunks.map((chunk) => ({
      id: `pdf:${chunk.id}`,
      kind: "uploaded_pdf" as const,
      title: `${chunk.documentName} — page ${chunk.pageNumber}`,
      source: chunk.documentName,
      date: "",
      url: "",
      content: chunk.text,
      similarity: chunk.similarity,
    }));
  } catch {
    // Uploaded-document search is best-effort: if it fails (e.g. store
    // unavailable), the agent still works off the sample news dataset alone.
    return [];
  }
}
