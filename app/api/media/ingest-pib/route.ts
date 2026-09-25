import { NextResponse } from "next/server";
import { getMediaStore } from "@/lib/media/store";
import { fetchPibReleases } from "@/lib/media/sources/pib";
import { embedTexts } from "@/lib/openai";
import { publicErrorMessage } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMBEDDING_BATCH_SIZE = 16;

// Explicit, opt-in live-data ingestion — separate from /api/media/seed (the
// synthetic dataset auto-loaded on every dashboard visit). Keeping this a
// distinct, manually-triggered action means the tested/evaluated demo flow
// (which depends on the synthetic dataset's known content) is unaffected
// unless a user deliberately pulls live data on top of it.
export async function POST() {
  try {
    const { items, fetchedAt } = await fetchPibReleases();
    if (!items.length) {
      return NextResponse.json({ ok: true, inserted: 0, skipped: 0, fetched: 0, fetchedAt, message: "The PIB feed returned no usable releases (it only carries the previous day's items, and can occasionally be empty or unreachable)." });
    }

    const texts = items.map((item) => `${item.title}\n\n${item.content}`);
    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = await embedTexts(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
      embeddings.push(...batch);
    }

    const { inserted, skipped } = await getMediaStore().seed(items, embeddings);
    const total = await getMediaStore().count();
    return NextResponse.json({
      ok: true,
      inserted,
      skipped,
      fetched: items.length,
      total,
      fetchedAt,
      message: `Pulled ${items.length} PIB release(s); ${inserted} new, ${skipped} already indexed.`,
    });
  } catch (error) {
    console.error("pib_ingest_error", error);
    return NextResponse.json({ error: publicErrorMessage(error, "Could not pull the PIB feed. Check the terminal for the detailed server error.") }, { status: 502 });
  }
}
