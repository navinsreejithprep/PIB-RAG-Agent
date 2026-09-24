import { NextResponse } from "next/server";
import { getMediaStore } from "@/lib/media/store";
import { loadSampleDataset } from "@/lib/media/seed-data";
import { embedTexts } from "@/lib/openai";
import { publicErrorMessage } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

const EMBEDDING_BATCH_SIZE = 16;

// Idempotent: safe to call on every dashboard load. Skips items already
// present (by id) instead of re-embedding the whole dataset each time.
export async function POST() {
  try {
    const store = getMediaStore();
    const existing = await store.count();
    const items = await loadSampleDataset();

    if (existing >= items.length) {
      return NextResponse.json({ ok: true, inserted: 0, skipped: existing, total: existing, message: "Sample dataset already indexed." });
    }

    const texts = items.map((item) => `${item.title}\n\n${item.content}`);
    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = await embedTexts(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
      embeddings.push(...batch);
    }

    const { inserted, skipped } = await store.seed(items, embeddings);
    const total = await store.count();
    return NextResponse.json({ ok: true, inserted, skipped, total, message: `Indexed ${inserted} new item(s); ${skipped} already present.` });
  } catch (error) {
    console.error("media_seed_error", error);
    return NextResponse.json({ error: publicErrorMessage(error, "Could not seed the sample dataset. Check the terminal for the detailed server error.") }, { status: 500 });
  }
}
