import { NextResponse } from "next/server";
import { deleteDocument, getDocument } from "@/lib/store";

export const runtime = "nodejs";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-f0-9]{64}$/.test(id)) {
    return NextResponse.json({ error: "Invalid document id." }, { status: 400 });
  }
  if (!getDocument(id)) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  deleteDocument(id);
  return NextResponse.json({ ok: true });
}
