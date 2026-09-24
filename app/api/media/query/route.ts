import { z } from "zod";
import { runAgent } from "@/lib/media/orchestrator";
import { publicErrorMessage } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  query: z.string().trim().min(4, "Question is too short.").max(500, "Question is too long."),
});

// Streams newline-delimited JSON: one line per activity-log event, then a
// final {"type":"result", state} line. Plain fetch + ReadableStream (not
// EventSource) because EventSource cannot send a POST body.
export async function POST(request: Request) {
  let parsed;
  try {
    parsed = schema.parse(await request.json());
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid request." : "Invalid request.";
    return new Response(JSON.stringify({ type: "error", error: message }) + "\n", { status: 400, headers: { "Content-Type": "application/x-ndjson" } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runAgent(parsed.query)) {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        }
      } catch (error) {
        console.error("media_agent_error", error);
        const message = publicErrorMessage(error, "The agent pipeline failed. Check the terminal for the detailed server error.");
        controller.enqueue(encoder.encode(JSON.stringify({ type: "error", error: message }) + "\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
