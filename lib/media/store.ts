import { neon } from "@neondatabase/serverless";
import { cosineSimilarity } from "../similarity";
import type { MediaItem, MediaSearchResult } from "./types";

// Mirrors the two-backend pattern in lib/store.ts: Postgres/pgvector when
// DATABASE_URL is set (required for Vercel), an in-memory Map otherwise.
// Kept as a separate table/namespace from the PDF chatbot's documents/chunks
// so the two features never collide.

export type MediaSearchOptions = {
  queryEmbedding?: number[] | null;
  kind?: MediaItem["kind"];
  topic?: string;
  source?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  minSimilarity?: number;
};

export type MediaStore = {
  seed(items: MediaItem[], embeddings: number[][]): Promise<{ inserted: number; skipped: number }>;
  count(): Promise<number>;
  listTopicsAndSources(): Promise<{ topics: string[]; sources: string[]; count: number }>;
  search(options: MediaSearchOptions): Promise<MediaSearchResult[]>;
  getByIds(ids: string[]): Promise<MediaItem[]>;
};

declare global {
  // eslint-disable-next-line no-var
  var __mediaStoreMemory: Map<string, MediaItem & { embedding: number[] }> | undefined;
}

function matchesFilters(item: MediaItem, options: MediaSearchOptions) {
  if (options.kind && item.kind !== options.kind) return false;
  if (options.topic && item.topic !== options.topic) return false;
  if (options.source && item.source !== options.source) return false;
  if (options.startDate && item.date < options.startDate) return false;
  if (options.endDate && item.date > options.endDate) return false;
  return true;
}

function memoryStore(): MediaStore {
  const items = (globalThis.__mediaStoreMemory ??= new Map());

  return {
    async seed(newItems, embeddings) {
      let inserted = 0;
      let skipped = 0;
      newItems.forEach((item, i) => {
        if (items.has(item.id)) {
          skipped++;
          return;
        }
        items.set(item.id, { ...item, embedding: embeddings[i] });
        inserted++;
      });
      return { inserted, skipped };
    },
    async count() {
      return items.size;
    },
    async listTopicsAndSources() {
      const topics = new Set<string>();
      const sources = new Set<string>();
      for (const item of items.values()) {
        topics.add(item.topic);
        sources.add(item.source);
      }
      return { topics: [...topics].sort(), sources: [...sources].sort(), count: items.size };
    },
    async search(options) {
      const limit = options.limit ?? 20;
      const minSimilarity = options.minSimilarity ?? 0;
      const candidates = [...items.values()].filter((item) => matchesFilters(item, options));

      const scored = candidates.map(({ embedding, ...item }) => ({
        ...item,
        embedding,
        similarity: options.queryEmbedding ? cosineSimilarity(options.queryEmbedding, embedding) : 1,
      }));

      const ordered = options.queryEmbedding
        ? scored.filter((item) => item.similarity >= minSimilarity).sort((a, b) => b.similarity - a.similarity)
        : scored.sort((a, b) => b.date.localeCompare(a.date));

      return ordered.slice(0, limit);
    },
    async getByIds(ids) {
      return ids
        .map((id) => items.get(id))
        .filter((v): v is MediaItem & { embedding: number[] } => Boolean(v))
        .map(({ embedding: _embedding, ...item }) => item);
    },
  };
}

function toVector(embedding: number[]) {
  return `[${embedding.join(",")}]`;
}

function postgresStore(databaseUrl: string): MediaStore {
  const sql = neon(databaseUrl);

  let schemaReady: Promise<void> | undefined;
  function ensureSchema() {
    // All four DDL statements as one HTTP round trip (sql.transaction), not
    // four. This module-level cache only survives within one warm serverless
    // instance -- a cron-triggered cold start (see /api/media/ingest-pib and
    // vercel.json) pays this cost on every invocation, so it needs to be as
    // cheap as possible to help the whole route fit inside Vercel Hobby's
    // 10-second function timeout.
    schemaReady ??= sql
      .transaction([
        sql`CREATE EXTENSION IF NOT EXISTS vector`,
        sql`
          CREATE TABLE IF NOT EXISTS media_items (
            id text PRIMARY KEY,
            kind text NOT NULL,
            title text NOT NULL,
            source text NOT NULL,
            date date NOT NULL,
            url text NOT NULL,
            topic text NOT NULL,
            content text NOT NULL,
            embedding vector NOT NULL
          )`,
        sql`CREATE INDEX IF NOT EXISTS media_items_topic_idx ON media_items (topic)`,
        sql`CREATE INDEX IF NOT EXISTS media_items_date_idx ON media_items (date)`,
      ])
      .then(() => undefined)
      .catch((error) => {
        schemaReady = undefined;
        throw error;
      });
    return schemaReady;
  }

  function rowToItem(row: Record<string, unknown>): MediaItem {
    return {
      id: row.id as string,
      kind: row.kind as MediaItem["kind"],
      title: row.title as string,
      source: row.source as string,
      date: (row.date as string).slice(0, 10),
      url: row.url as string,
      topic: row.topic as string,
      content: row.content as string,
    };
  }

  return {
    async seed(newItems, embeddings) {
      await ensureSchema();
      if (!newItems.length) return { inserted: 0, skipped: 0 };

      // A single bulk upsert via unnest(), not one SELECT+INSERT round trip
      // per item. This matters beyond general efficiency: Vercel's Hobby
      // plan hard-caps serverless functions at 10 seconds regardless of
      // maxDuration, and a scheduled daily PIB pull (see /api/media/ingest-pib
      // and vercel.json) needs to embed and store dozens of items within
      // that budget. The previous per-item loop made up to 2*N sequential
      // round trips to Postgres; this makes one.
      const rows = await sql`
        INSERT INTO media_items (id, kind, title, source, date, url, topic, content, embedding)
        SELECT id, kind, title, source, date, url, topic, content, embedding::vector
        FROM unnest(
          ${newItems.map((i) => i.id)}::text[],
          ${newItems.map((i) => i.kind)}::text[],
          ${newItems.map((i) => i.title)}::text[],
          ${newItems.map((i) => i.source)}::text[],
          ${newItems.map((i) => i.date)}::date[],
          ${newItems.map((i) => i.url)}::text[],
          ${newItems.map((i) => i.topic)}::text[],
          ${newItems.map((i) => i.content)}::text[],
          ${embeddings.map(toVector)}::text[]
        ) AS t(id, kind, title, source, date, url, topic, content, embedding)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;

      const inserted = rows.length;
      return { inserted, skipped: newItems.length - inserted };
    },

    async count() {
      await ensureSchema();
      const rows = await sql`SELECT count(*)::int AS n FROM media_items`;
      return rows[0]?.n ?? 0;
    },

    async listTopicsAndSources() {
      await ensureSchema();
      const topics = await sql`SELECT DISTINCT topic FROM media_items ORDER BY topic`;
      const sources = await sql`SELECT DISTINCT source FROM media_items ORDER BY source`;
      const count = await sql`SELECT count(*)::int AS n FROM media_items`;
      return {
        topics: topics.map((r) => r.topic as string),
        sources: sources.map((r) => r.source as string),
        count: count[0]?.n ?? 0,
      };
    },

    async search(options) {
      await ensureSchema();
      const limit = options.limit ?? 20;
      const minSimilarity = options.minSimilarity ?? 0;

      if (!options.queryEmbedding) {
        const rows = await sql`
          SELECT id, kind, title, source, date, url, topic, content
          FROM media_items
          WHERE (${options.kind ?? null}::text IS NULL OR kind = ${options.kind ?? null})
            AND (${options.topic ?? null}::text IS NULL OR topic = ${options.topic ?? null})
            AND (${options.source ?? null}::text IS NULL OR source = ${options.source ?? null})
            AND (${options.startDate ?? null}::date IS NULL OR date >= ${options.startDate ?? null}::date)
            AND (${options.endDate ?? null}::date IS NULL OR date <= ${options.endDate ?? null}::date)
          ORDER BY date DESC
          LIMIT ${limit}`;
        return rows.map((row) => ({ ...rowToItem(row), similarity: 1, embedding: [] }));
      }

      const vector = toVector(options.queryEmbedding);
      const rows = await sql`
        SELECT id, kind, title, source, date, url, topic, content,
               1 - (embedding <=> ${vector}::vector) AS similarity
        FROM media_items
        WHERE (${options.kind ?? null}::text IS NULL OR kind = ${options.kind ?? null})
          AND (${options.topic ?? null}::text IS NULL OR topic = ${options.topic ?? null})
          AND (${options.source ?? null}::text IS NULL OR source = ${options.source ?? null})
          AND (${options.startDate ?? null}::date IS NULL OR date >= ${options.startDate ?? null}::date)
          AND (${options.endDate ?? null}::date IS NULL OR date <= ${options.endDate ?? null}::date)
          AND 1 - (embedding <=> ${vector}::vector) >= ${minSimilarity}
        ORDER BY embedding <=> ${vector}::vector
        LIMIT ${limit}`;
      return rows.map((row) => ({ ...rowToItem(row), similarity: Number(row.similarity), embedding: [] }));
    },

    async getByIds(ids) {
      if (!ids.length) return [];
      await ensureSchema();
      const rows = await sql`SELECT id, kind, title, source, date, url, topic, content FROM media_items WHERE id = ANY(${ids})`;
      return rows.map(rowToItem);
    },
  };
}

let store: MediaStore | undefined;

export function getMediaStore(): MediaStore {
  if (!store) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    store = databaseUrl ? postgresStore(databaseUrl) : memoryStore();
  }
  return store;
}
