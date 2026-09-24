import { NextResponse } from "next/server";
import { getMediaStore } from "@/lib/media/store";
import { publicErrorMessage } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const stats = await getMediaStore().listTopicsAndSources();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("media_stats_error", error);
    return NextResponse.json({ error: publicErrorMessage(error, "Could not load dataset stats.") }, { status: 500 });
  }
}
