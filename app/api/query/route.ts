import { NextResponse } from "next/server";
import { z } from "zod";
import { answerQuery } from "@/lib/rag";
import { publicErrorMessage } from "@/lib/http";

const schema = z.object({
  query: z.string().trim().min(2, "Question is too short.").max(2000, "Question is too long."),
  documentId: z.string().regex(/^[a-f0-9]{64}$/, "Invalid document id.").optional(),
});

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const result = await answerQuery(body.query, body.documentId);
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json({
      error: error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid request."
        : publicErrorMessage(error, "Query failed. Check the terminal for the detailed server error."),
    }, { status });
  }
}
