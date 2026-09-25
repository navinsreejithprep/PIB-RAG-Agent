import { NextResponse } from "next/server";
import { getMediaStore } from "@/lib/media/store";
import { fetchPibReleases } from "@/lib/media/sources/pib";
import { embedTexts } from "@/lib/openai";
import { publicErrorMessage } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

// A daily PIB pull is bounded to roughly a few dozen items (59 on a typical
// day, tested), unlike PDF ingestion's potentially-thousands-of-chunks case
// (lib/store.ts, which deliberately uses small batches of 16 for that
// reason). Fewer, larger OpenAI calls here materially reduces round-trip
// time, which matters because this route also runs as a scheduled cron job
// (vercel.json) inside Vercel Hobby's hard 10-second function timeout,
// which applies regardless of the maxDuration above -- Hobby caps every
// function at 10s no matter what a project configures. Measured end-to-end
// (feed fetch + one embedding call + the bulk upsert in
// lib/media/store.ts): ~5-6s locally, with roughly half of that shaved off
// by batching the store's schema-check into one round trip instead of four
// (see ensureSchema() there). If this ever does time out on Hobby, the fix
// is either the Pro plan's longer maxDuration or trimming this further
// (e.g. dropping the trailing count() call below).
const EMBEDDING_BATCH_SIZE = 100;

async function runIngest() {
  const { items, fetchedAt } = await fetchPibReleases();
  if (!items.length) {
    return { ok: true, inserted: 0, skipped: 0, fetched: 0, fetchedAt, message: "The PIB feed returned no usable releases (it only carries the previous day's items, and can occasionally be empty or unreachable)." };
  }

  const texts = items.map((item) => `${item.title}\n\n${item.content}`);
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = await embedTexts(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
    embeddings.push(...batch);
  }

  const { inserted, skipped } = await getMediaStore().seed(items, embeddings);
  const total = await getMediaStore().count();
  return {
    ok: true,
    inserted,
    skipped,
    fetched: items.length,
    total,
    fetchedAt,
    message: `Pulled ${items.length} PIB release(s); ${inserted} new, ${skipped} already indexed.`,
  };
}

// POST: triggered by the dashboard (auto-pull on load, and the manual "Pull
// latest releases" button) — same-origin, no auth, consistent with every
// other ingestion route in this project (see README's Limitations).
export async function POST() {
  try {
    return NextResponse.json(await runIngest());
  } catch (error) {
    console.error("pib_ingest_error", error);
    return NextResponse.json({ error: publicErrorMessage(error, "Could not pull the PIB feed. Check the terminal for the detailed server error.") }, { status: 502 });
  }
}

// GET: Vercel Cron Jobs only ever send GET requests (see vercel.json), so
// this is the path a scheduled daily pull actually uses. Unlike POST, this
// checks Vercel's own CRON_SECRET convention: Vercel signs every cron
// invocation with `Authorization: Bearer <CRON_SECRET>`, and this route
// requires that to match before doing anything -- otherwise the same public
// URL would let anyone trigger (paid) OpenAI embedding calls just by
// GETting it. If CRON_SECRET isn't configured, GET is disabled entirely
// (fails closed, not open).
export async function GET(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured on the server; scheduled ingestion is disabled." }, { status: 501 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${configuredSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    return NextResponse.json(await runIngest());
  } catch (error) {
    console.error("pib_ingest_cron_error", error);
    return NextResponse.json({ error: publicErrorMessage(error, "Scheduled PIB ingestion failed. Check the deployment logs.") }, { status: 502 });
  }
}
