import { NextResponse } from "next/server";
import { sha256 } from "@/lib/hash";
import { extractPdf } from "@/lib/pdf";
import { chunkPages } from "@/lib/text";
import { embedTexts } from "@/lib/openai";
import { env } from "@/lib/config";
import { getStore } from "@/lib/store";
import { publicErrorMessage } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;
const EMBEDDING_BATCH_SIZE = 16;

export async function POST(request: Request) {
  try {
    const config = env();
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Please upload a PDF file." }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "The uploaded PDF is empty." }, { status: 400 });
    }
    if (file.size > config.MAX_PDF_MB * 1024 * 1024) {
      return NextResponse.json({ error: `PDF exceeds ${config.MAX_PDF_MB} MB.` }, { status: 413 });
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Only PDF files are supported." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      return NextResponse.json({ error: "The uploaded file is not a valid PDF." }, { status: 400 });
    }

    const documentId = sha256(buffer);
    if (await getStore().hasDocument(documentId)) {
      return NextResponse.json({
        ok: true,
        documentId,
        duplicate: true,
        message: "This PDF is already indexed in this session.",
      });
    }

    const parsed = await extractPdf(buffer);
    if (parsed.totalPages > config.MAX_PDF_PAGES) {
      return NextResponse.json({
        error: `PDF has ${parsed.totalPages} pages. V1 limits documents to ${config.MAX_PDF_PAGES} pages to keep local demos predictable.`,
      }, { status: 413 });
    }
    if (!parsed.text || parsed.text.length < 20) {
      return NextResponse.json({
        error: "No usable text could be extracted. This may be a scanned/image-only PDF; OCR is not enabled in V1.",
      }, { status: 422 });
    }

    const chunksData = chunkPages(parsed.pages, CHUNK_SIZE, CHUNK_OVERLAP);
    if (!chunksData.length) {
      return NextResponse.json({ error: "The PDF produced no usable chunks." }, { status: 422 });
    }
    if (chunksData.length > config.MAX_CHUNKS_PER_DOCUMENT) {
      return NextResponse.json({
        error: `PDF produced ${chunksData.length} chunks. V1 limits a document to ${config.MAX_CHUNKS_PER_DOCUMENT} chunks.`,
      }, { status: 413 });
    }

    const texts = chunksData.map((chunk) => chunk.text);
    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = await embedTexts(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
      embeddings.push(...batch);
    }
    if (embeddings.length !== texts.length) {
      throw new Error("Embedding count does not match chunk count.");
    }
    const embeddingDimension = embeddings[0]?.length ?? 0;
    if (!embeddingDimension || embeddings.some((embedding) => embedding.length !== embeddingDimension)) {
      throw new Error("Embedding vectors have inconsistent dimensions.");
    }

    const uploadedAt = new Date().toISOString();
    const safeName = file.name.trim().slice(0, 240) || "document.pdf";
    const chunks = chunksData.map((chunk, i) => ({
      id: `${documentId}:${i}`,
      text: chunk.text,
      documentId,
      documentName: safeName,
      pageNumber: chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
      embedding: embeddings[i],
    }));

    await getStore().addDocument({
      id: documentId,
      name: safeName,
      pages: parsed.totalPages,
      uploadedAt,
      status: "ready",
      chunks,
    });

    return NextResponse.json({
      ok: true,
      documentId,
      duplicate: false,
      pages: parsed.totalPages,
      chunks: chunks.length,
      message: `Indexed ${chunks.length} chunks from ${parsed.totalPages} pages.`,
    });
  } catch (error) {
    console.error("ingestion_error", error);
    return NextResponse.json({
      error: publicErrorMessage(error, "Ingestion failed. Check the terminal for the detailed server error."),
    }, { status: 500 });
  }
}
