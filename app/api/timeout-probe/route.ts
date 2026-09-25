import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Temporary: empirically checks this deployment's actual function timeout
// (Vercel's Fluid Compute changed Hobby defaults from 10s to 300s in June
// 2026; confirming which applies here rather than assuming). Delete after use.
export async function GET() {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 15000));
  return NextResponse.json({ slept_ms: Date.now() - start });
}
