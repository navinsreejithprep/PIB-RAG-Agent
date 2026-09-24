import { NextResponse } from "next/server";
import { listDocuments } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ documents: listDocuments() });
}
