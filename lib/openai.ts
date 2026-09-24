import OpenAI from "openai";
import { env } from "./config";

let client: OpenAI | undefined;

export function openai() {
  if (!client) {
    client = new OpenAI({
      apiKey: env().OPENAI_API_KEY,
      timeout: 60_000,
      maxRetries: 2,
    });
  }
  return client;
}

export async function embedTexts(texts: string[]) {
  if (!texts.length) return [] as number[][];

  // Keep batches deliberately small for predictable request size. The input
  // limit is model-dependent, so do not assume a large batch is always safe.
  const response = await openai().embeddings.create({
    model: env().OPENAI_EMBEDDING_MODEL,
    input: texts,
  });

  const ordered = [...response.data].sort((a, b) => a.index - b.index);
  if (ordered.length !== texts.length || ordered.some((item) => !Array.isArray(item.embedding) || item.embedding.length === 0)) {
    throw new Error("Embedding service returned an unexpected number or shape of vectors.");
  }

  const dimension = ordered[0].embedding.length;
  if (ordered.some((item) => item.embedding.length !== dimension)) {
    throw new Error("Embedding service returned vectors with inconsistent dimensions.");
  }

  return ordered.map((item) => item.embedding);
}
