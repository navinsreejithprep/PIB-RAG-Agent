import { neon } from "@neondatabase/serverless";
import { cosineSimilarity } from "./similarity";
import type { Chunk, DocumentSummary } from "./types";

// Two interchangeable backends:
// - Postgres + pgvector when DATABASE_URL is set (required on Vercel, where
//   each request can run on a different serverless instance).
// - A process-local Map otherwise, which keeps local V1 demos dependency-free.

type StoredChunk = {
  id: string;
  text: string;
  documentId: string;
  documentName: string;
  pageNumber: number;
  chunkIndex: number;
  embedding: number[];
};

type StoredDocument = Omit<DocumentSummary, "chunks"> & { chunks: StoredChunk[] };

type ScoredChunk = Chunk & { similarity: number };

type SearchOptions = { documentId?: string; limit: number; minSimilarity: number };

type RagStore = {
  listDocuments(): Promise<DocumentSummary[]>;
  hasDocument(id: string): Promise<boolean>;
  hasAnyDocuments(): Promise<boolean>;
  addDocument(document: StoredDocument): Promise<void>;
  deleteDocument(id: string): Promise<boolean>;
  searchChunks(embedding: number[], options: SearchOptions): Promise<ScoredChunk[]>;
};

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __docQueryRagStore: Map<string, StoredDocument> | undefined;
}

function memoryStore(): RagStore {
  const documents = (globalThis.__docQueryRagStore ??= new Map<string, StoredDocument>());

  return {
    async listDocuments() {
      return Array.from(documents.values())
        .map(({ chunks, ...summary }) => ({ ...summary, chunks: chunks.length }))
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    },
    async hasDocument(id) {
      return documents.has(id);
    },
    async hasAnyDocuments() {
      return documents.size > 0;
    },
    async addDocument(document) {
      documents.set(document.id, document);
    },
    async deleteDocument(id) {
      return documents.delete(id);
    },
    async searchChunks(embedding, { documentId, limit, minSimilarity }) {
      const candidates = documentId
        ? (documents.get(documentId)?.chunks ?? [])
        : Array.from(documents.values()).flatMap((doc) => doc.chunks);

      return candidates
        .map(({ embedding: chunkEmbedding, ...chunk }) => ({
          ...chunk,
          similarity: cosineSimilarity(embedding, chunkEmbedding),
        }))
        .filter(({ similarity }) => similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres + pgvector backend
// ---------------------------------------------------------------------------

const INSERT_BATCH_SIZE = 100;

function toVector(embedding: number[]) {
  return `[${embedding.join(",")}]`;
}

function postgresStore(databaseUrl: string): RagStore {
  const sql = neon(databaseUrl);

  let schemaReady: Promise<void> | undefined;
  function ensureSchema() {
    schemaReady ??= (async () => {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await sql`
        CREATE TABLE IF NOT EXISTS documents (
          id text PRIMARY KEY,
          name text NOT NULL,
          pages integer NOT NULL,
          uploaded_at timestamptz NOT NULL,
          status text NOT NULL
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS chunks (
          id text PRIMARY KEY,
          document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          page_number integer NOT NULL,
          chunk_index integer NOT NULL,
          text text NOT NULL,
          embedding vector NOT NULL
        )`;
      await sql`CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id)`;
    })().catch((error) => {
      schemaReady = undefined; // allow a retry on the next request
      throw error;
    });
    return schemaReady;
  }

  return {
    async listDocuments() {
      await ensureSchema();
      const rows = await sql`
        SELECT d.id, d.name, d.pages, d.uploaded_at, d.status, count(c.id)::int AS chunks
        FROM documents d
        LEFT JOIN chunks c ON c.document_id = d.id
        GROUP BY d.id
        ORDER BY d.uploaded_at DESC`;
      return rows.map((row) => ({
        id: row.id as string,
        name: row.name as string,
        pages: row.pages as number,
        chunks: row.chunks as number,
        uploadedAt: new Date(row.uploaded_at as string).toISOString(),
        status: row.status as string,
      }));
    },

    async hasDocument(id) {
      await ensureSchema();
      // A 'processing' row is an interrupted upload; let it be re-ingested.
      const rows = await sql`SELECT 1 FROM documents WHERE id = ${id} AND status = 'ready'`;
      return rows.length > 0;
    },

    async hasAnyDocuments() {
      await ensureSchema();
      const rows = await sql`SELECT 1 FROM documents WHERE status = 'ready' LIMIT 1`;
      return rows.length > 0;
    },

    async addDocument(document) {
      await ensureSchema();
      // Insert the document row last so a partially written upload is never
      // listed; ON DELETE CASCADE can't help before the parent row exists, so
      // clean up any orphaned chunks from a previous failed attempt first.
      await sql`DELETE FROM chunks WHERE document_id = ${document.id}`;
      await sql`
        INSERT INTO documents (id, name, pages, uploaded_at, status)
        VALUES (${document.id}, ${document.name}, ${document.pages}, ${document.uploadedAt}, 'processing')
        ON CONFLICT (id) DO NOTHING`;
      try {
        for (let i = 0; i < document.chunks.length; i += INSERT_BATCH_SIZE) {
          const batch = document.chunks.slice(i, i + INSERT_BATCH_SIZE);
          await sql`
            INSERT INTO chunks (id, document_id, page_number, chunk_index, text, embedding)
            SELECT id, ${document.id}, page_number, chunk_index, text, embedding::vector
            FROM unnest(
              ${batch.map((c) => c.id)}::text[],
              ${batch.map((c) => c.pageNumber)}::int[],
              ${batch.map((c) => c.chunkIndex)}::int[],
              ${batch.map((c) => c.text)}::text[],
              ${batch.map((c) => toVector(c.embedding))}::text[]
            ) AS t(id, page_number, chunk_index, text, embedding)`;
        }
        await sql`UPDATE documents SET status = ${document.status} WHERE id = ${document.id}`;
      } catch (error) {
        await sql`DELETE FROM documents WHERE id = ${document.id}`;
        throw error;
      }
    },

    async deleteDocument(id) {
      await ensureSchema();
      const rows = await sql`DELETE FROM documents WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    },

    async searchChunks(embedding, { documentId, limit, minSimilarity }) {
      await ensureSchema();
      const vector = toVector(embedding);
      // <=> is pgvector's cosine distance; similarity = 1 - distance.
      const rows = await sql`
        SELECT c.id, c.text, c.document_id, d.name AS document_name, c.page_number, c.chunk_index,
               1 - (c.embedding <=> ${vector}::vector) AS similarity
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.status = 'ready'
          AND (${documentId ?? null}::text IS NULL OR c.document_id = ${documentId ?? null})
          AND 1 - (c.embedding <=> ${vector}::vector) >= ${minSimilarity}
        ORDER BY c.embedding <=> ${vector}::vector
        LIMIT ${limit}`;
      return rows.map((row) => ({
        id: row.id as string,
        text: row.text as string,
        documentId: row.document_id as string,
        documentName: row.document_name as string,
        pageNumber: row.page_number as number,
        chunkIndex: row.chunk_index as number,
        similarity: Number(row.similarity),
      }));
    },
  };
}

// ---------------------------------------------------------------------------

let store: RagStore | undefined;

export function getStore(): RagStore {
  if (!store) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    store = databaseUrl ? postgresStore(databaseUrl) : memoryStore();
  }
  return store;
}

export type { RagStore, ScoredChunk, StoredChunk, StoredDocument };
