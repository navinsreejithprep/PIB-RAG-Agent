"use client";

import { useEffect, useRef, useState } from "react";
import type { DocumentSummary } from "@/lib/types";

type Source = { id: string; documentName: string; pageNumber: number; similarity?: number };
type RetrievedChunk = { id: string; documentName: string; pageNumber: number; text: string; similarity: number };
type Message = { id: string; role: "user" | "assistant"; text: string; sources?: Source[]; retrievedChunks?: RetrievedChunk[] };

async function readJson(response: Response) {
  const data: unknown = await response.json().catch(() => ({}));
  if (!data || typeof data !== "object") return {} as Record<string, unknown>;
  return data as Record<string, unknown>;
}

function errorText(data: Record<string, unknown>, fallback: string) {
  return typeof data.error === "string" ? data.error : fallback;
}

export default function RagApp() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Ready. Upload a PDF to begin.");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refreshDocuments() {
    const response = await fetch("/api/documents", { cache: "no-store" });
    const data = await readJson(response);
    if (!response.ok) throw new Error(errorText(data, "Could not load documents."));
    setDocuments(Array.isArray(data.documents) ? data.documents as DocumentSummary[] : []);
  }

  useEffect(() => {
    refreshDocuments().catch((error) => setStatus(error instanceof Error ? error.message : "Could not load documents."));
  }, []);

  async function handleFile(file: File) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setStatus("Please select a PDF file.");
      return;
    }
    setBusy(true);
    try {
      setStatus("Reading PDF and building embeddings…");
      const form = new FormData();
      form.append("file", file);
      const ingest = await fetch("/api/ingest", { method: "POST", body: form });
      const data = await readJson(ingest);
      if (!ingest.ok) throw new Error(errorText(data, "Ingestion failed."));
      setStatus(typeof data.message === "string" ? data.message : "Document indexed and ready.");
      await refreshDocuments();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function ask() {
    const q = query.trim();
    if (!q || busy || documents.length === 0) return;

    const messageId = crypto.randomUUID();
    setMessages((m) => [...m, { id: messageId, role: "user", text: q }]);
    setQuery("");
    setBusy(true);
    setStatus("Embedding question and retrieving relevant chunks…");
    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, documentId: selectedDocument || undefined }),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(errorText(data, "Query failed."));
      setMessages((m) => [...m, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: typeof data.answer === "string" ? data.answer : "No answer returned.",
        sources: Array.isArray(data.sources) ? data.sources as Source[] : [],
        retrievedChunks: Array.isArray(data.retrievedChunks) ? data.retrievedChunks as RetrievedChunk[] : [],
      }]);
      setStatus(`Retrieved ${typeof data.retrieved === "number" ? data.retrieved : 0} relevant chunks.`);
    } catch (error) {
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: error instanceof Error ? error.message : "Query failed." }]);
      setStatus("Query failed.");
    } finally {
      setBusy(false);
    }
  }

  async function removeDocument(id: string) {
    if (!confirm("Delete this document from the current session?")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await readJson(response);
      if (!response.ok) throw new Error(errorText(data, "Could not delete document."));
      if (selectedDocument === id) setSelectedDocument("");
      await refreshDocuments();
      setStatus("Document deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete document.");
    } finally {
      setBusy(false);
    }
  }

  const selectedName = documents.find((d) => d.id === selectedDocument)?.name;

  return (
    <main className="shell">
      <div className="container">
        <header className="hero">
          <div>
            <div className="eyebrow">V1 · Basic RAG</div>
            <h1>DocQuery</h1>
            <p className="subtitle">Upload a PDF. Chunk it. Embed it. Retrieve relevant passages. Ask an LLM for a grounded answer.</p>
          </div>
          <div className="badge">Local · Next.js · OpenAI</div>
        </header>

        <section className="learning-strip" aria-label="RAG pipeline">
          <span>DOCUMENT</span><b>→</b><span>CHUNKS</span><b>→</b><span>EMBEDDINGS</span><b>→</b><span>RETRIEVAL</span><b>→</b><span>LLM</span>
        </section>

        <section className="grid">
          <aside className="panel">
            <div className="panel-head"><h2>Knowledge base</h2></div>
            <div className="panel-body">
              <div className="drop">
                <strong>Upload a PDF</strong>
                <p>V1 supports text PDFs. Scanned/image-only PDFs need OCR, which we intentionally leave for a later version.</p>
                <input ref={fileRef} className="file-input" type="file" accept="application/pdf,.pdf" aria-label="Choose PDF" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
                <button className="btn" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Working…" : "Choose PDF"}</button>
              </div>
              <div className="status" role="status" aria-live="polite">{status}</div>
              <div className="hint">Chunk size: ~1,000 characters · overlap: 100 · cosine similarity · top 5 chunks</div>
              <div className="local-note">V1 stores documents and embeddings in memory on one local Node process. Restarting the server clears the knowledge base; it is not a production persistence layer.</div>
              <div className="docs">
                {documents.length === 0 && <div className="hint">No documents indexed yet.</div>}
                {documents.map((doc) => (
                  <div className="doc" key={doc.id}>
                    <div className="doc-top">
                      <button className="doc-name" type="button" title={doc.name} disabled={busy} onClick={() => setSelectedDocument(doc.id)}>{selectedDocument === doc.id ? "✓ " : ""}{doc.name}</button>
                      <button className="btn danger" type="button" aria-label={`Delete ${doc.name}`} title="Delete document" disabled={busy} onClick={() => removeDocument(doc.id)}>×</button>
                    </div>
                    <div className="doc-meta">{doc.pages} pages · {doc.chunks} chunks</div>
                  </div>
                ))}
              </div>
            </div>
          </aside>

          <section className="panel chat">
            <div className="panel-head"><h2>{selectedDocument ? `Chat · ${selectedName ?? "Document"}` : "Chat · all documents"}</h2></div>
            <div className="messages" aria-live="polite">
              {messages.length === 0 ? (
                <div className="empty">Upload a document, then ask a question.<br /><br /><strong>Teaching view:</strong> each answer exposes the retrieved chunks and source pages.</div>
              ) : messages.map((message) => (
                <div className={`message ${message.role === "user" ? "user" : "ai"}`} key={message.id}>
                  <div className="bubble">{message.text}</div>
                  {message.sources?.length ? <div className="sources">{message.sources.map((s) => <span className="source" key={`${message.id}-${s.id}-${s.pageNumber}`}>[{s.id}] {s.documentName} · p.{s.pageNumber} · {s.similarity?.toFixed(2)}</span>)}</div> : null}
                  {message.retrievedChunks?.length ? (
                    <details className="retrieved">
                      <summary>Show retrieved chunks ({message.retrievedChunks.length})</summary>
                      {message.retrievedChunks.map((chunk) => (
                        <div className="retrieved-chunk" key={`${message.id}-${chunk.id}`}>
                          <div><strong>[{chunk.id}]</strong> page {chunk.pageNumber} · similarity {chunk.similarity}</div>
                          <p>{chunk.text}</p>
                        </div>
                      ))}
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
            <form className="composer" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ask something about the documents…" maxLength={2000} disabled={busy || documents.length === 0} aria-label="Question" />
              <button className="btn" type="submit" disabled={busy || !query.trim() || documents.length === 0}>Ask</button>
            </form>
          </section>
        </section>
        <div className="footer">V1 is intentionally local and ephemeral. Cloud storage, metadata filtering, hybrid search, reranking and evaluation come in later versions.</div>
      </div>
    </main>
  );
}
