import { embedTexts } from "../../openai";
import { cosineSimilarity } from "../../similarity";
import type { EvidenceItem, EventCluster } from "../types";

// USER PROBLEM: the same event is usually covered by several outlets with
// different headlines ("Cabinet approves...", "Government announces...",
// "New framework unveiled..."). Without grouping, an executive brief would
// list near-duplicate coverage as separate "developments," burying the
// signal.
// AI CAPABILITY: group retrieved articles that discuss the same underlying
// event. Implemented as deterministic embedding-similarity clustering
// (union-find over cosine similarity), not an LLM call — this keeps
// clustering fast, cheap, and fully explainable (every grouping decision is
// a similarity number you can inspect), matching the "lightweight,
// explainable agent" requirement rather than adding an LLM call whose
// grouping behavior would be harder to predict or test.
// OUTPUT: EventCluster[], each with its member source IDs, date range, and a
// deterministic headline (the member most similar to the user's query).
// MEASURABLE VALUE: turns N retrieved articles into ~N/cluster-size distinct
// events, which is what the "Clustering N articles into M events" status
// line and the evaluation harness's retrieval-relevance metric report on.

const DEFAULT_THRESHOLD = 0.6;

// Pure grouping step: given articles and a precomputed pairwise-similarity
// vector per article, decide which ones belong to the same event. Separated
// from clusterArticles() below so this logic — the part that actually
// determines clustering behavior — is unit-testable without an OpenAI call.
// See tests/media-cluster.test.ts.
export function groupBySimilarity(articles: EvidenceItem[], vectors: number[][], threshold = DEFAULT_THRESHOLD): EventCluster[] {
  if (articles.length <= 1) {
    return articles.map((item, index) => ({
      id: `E${index + 1}`,
      headline: item.title,
      sourceIds: [item.id],
      sourceCount: 1,
      dateRange: { earliest: item.date, latest: item.date },
      sources: [{ id: item.id, title: item.title, source: item.source, date: item.date, url: item.url, similarity: item.similarity }],
      keyFacts: [],
    }));
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  articles.forEach((item) => parent.set(item.id, item.id));

  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      if (cosineSimilarity(vectors[i], vectors[j]) >= threshold) union(articles[i].id, articles[j].id);
    }
  }

  const groups = new Map<string, EvidenceItem[]>();
  for (const item of articles) {
    const root = find(item.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(item);
  }

  const clusters: EventCluster[] = [...groups.values()].map((members, index) => {
    const sorted = [...members].sort((a, b) => b.similarity - a.similarity);
    const dates = members.map((m) => m.date).filter(Boolean).sort();
    return {
      id: `E${index + 1}`,
      headline: sorted[0].title,
      sourceIds: members.map((m) => m.id),
      sourceCount: members.length,
      dateRange: { earliest: dates[0] ?? "", latest: dates[dates.length - 1] ?? "" },
      sources: members.map((m) => ({ id: m.id, title: m.title, source: m.source, date: m.date, url: m.url, similarity: m.similarity })),
      keyFacts: [],
    };
  });

  // Largest / most-corroborated events first — that is what an executive
  // scanning "key developments" wants to see at the top.
  return clusters.sort((a, b) => b.sourceCount - a.sourceCount || b.sources[0].similarity - a.sources[0].similarity);
}

export async function clusterArticles(items: EvidenceItem[], threshold = DEFAULT_THRESHOLD): Promise<EventCluster[]> {
  const articles = items.filter((item) => item.kind === "article" || item.kind === "uploaded_pdf");
  if (articles.length <= 1) return groupBySimilarity(articles, [], threshold);

  // Clustering needs pairwise similarity between articles, not their
  // similarity to the query, so embed a short signature (title + opening
  // sentences) for each retrieved article. Bounded by the retrieved-set size
  // (typically under 20), so this stays cheap.
  const signatures = articles.map((item) => `${item.title}\n${item.content.slice(0, 400)}`);
  const vectors = await embedTexts(signatures);

  return groupBySimilarity(articles, vectors, threshold);
}
