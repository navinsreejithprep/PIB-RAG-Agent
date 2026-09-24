import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_CHAT_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  RAG_MAX_CONTEXT_CHUNKS: z.coerce.number().int().min(1).max(10).default(5),
  RAG_MIN_SIMILARITY: z.coerce.number().min(-1).max(1).default(0.15),
  RAG_MAX_CONTEXT_CHARS: z.coerce.number().int().min(1000).max(50000).default(12000),
  MAX_PDF_MB: z.coerce.number().int().min(1).max(50).default(20),
  MAX_PDF_PAGES: z.coerce.number().int().min(1).max(1000).default(250),
  MAX_CHUNKS_PER_DOCUMENT: z.coerce.number().int().min(1).max(10000).default(5000),
});

let cached: z.infer<typeof envSchema> | undefined;

export function env() {
  if (!cached) cached = envSchema.parse(process.env);
  return cached;
}
