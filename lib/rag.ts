import { env } from "./config";
import { embedTexts, openai } from "./openai";
import { getDocument, getStore } from "./store";
import { RAG_SYSTEM_PROMPT } from "@/prompts/rag";
import type { Chunk } from "./types";

import { cosineSimilarity } from "./similarity";

export function selectCandidates(query: string, documentId?: string) {
  const normalizedId = documentId?.trim();
  const candidates = normalizedId
    ? (getDocument(normalizedId)?.chunks ?? [])
    : Array.from(getStore().documents.values()).flatMap((doc) => doc.chunks);

  return { query: query.trim(), candidates };
}

export async function retrieve(query: string, documentId?: string) {
  const { candidates } = selectCandidates(query, documentId);
  if (!candidates.length) return [] as Array<Chunk & { similarity: number }>;

  const [queryEmbedding] = await embedTexts([query]);
  const ranked = candidates
    .map((chunk) => ({ chunk, similarity: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .filter(({ similarity }) => similarity >= env().RAG_MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.min(env().RAG_TOP_K, env().RAG_MAX_CONTEXT_CHUNKS));

  return ranked.map(({ chunk, similarity }): Chunk & { similarity: number } => ({
    id: chunk.id,
    text: chunk.text,
    documentId: chunk.documentId,
    documentName: chunk.documentName,
    pageNumber: chunk.pageNumber,
    chunkIndex: chunk.chunkIndex,
    similarity,
  }));
}

export async function answerQuery(query: string, documentId?: string) {
  const chunks = await retrieve(query, documentId);
  if (!chunks.length) {
    const hasDocuments = getStore().documents.size > 0;
    return {
      answer: hasDocuments
        ? "I couldn't find sufficiently relevant evidence in the indexed documents to answer that question."
        : "I couldn't find any indexed document content. Upload a PDF first.",
      sources: [],
      retrievedChunks: [],
      retrieved: 0,
    };
  }

  let contextChars = 0;
  const contextParts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = `[S${i + 1}] ${chunks[i].documentName} — page ${chunks[i].pageNumber}\n${chunks[i].text}`;
    if (contextParts.length > 0 && contextChars + part.length > env().RAG_MAX_CONTEXT_CHARS) break;
    contextParts.push(part);
    contextChars += part.length;
  }

  const context = contextParts.join("\n\n---\n\n");
  const response = await openai().responses.create({
    model: env().OPENAI_CHAT_MODEL,
    instructions: RAG_SYSTEM_PROMPT,
    input: `USER QUESTION:\n${query}\n\nRETRIEVED DOCUMENT CONTEXT:\n${context}`,
  });

  const answer = response.output_text?.trim();
  if (!answer) throw new Error("The language model returned an empty answer.");

  const usedChunks = chunks.slice(0, contextParts.length);
  return {
    answer,
    sources: usedChunks.map((chunk, i) => ({
      id: `S${i + 1}`,
      documentName: chunk.documentName,
      pageNumber: chunk.pageNumber,
      chunkId: chunk.id,
      similarity: chunk.similarity,
    })),
    retrievedChunks: usedChunks.map((chunk, i) => ({
      id: `S${i + 1}`,
      documentName: chunk.documentName,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      similarity: Number(chunk.similarity.toFixed(3)),
    })),
    retrieved: usedChunks.length,
  };
}
