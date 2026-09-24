import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ documents: await getStore().listDocuments() });
}
