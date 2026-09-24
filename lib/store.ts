import type { DocumentSummary } from "./types";

type StoredChunk = {
  id: string;
  text: string;
  documentId: string;
  documentName: string;
  pageNumber: number;
  chunkIndex: number;
  embedding: number[];
};

type StoredDocument = Omit<DocumentSummary, "chunks"> & { chunks: StoredChunk[] };

type RagStore = {
  documents: Map<string, StoredDocument>;
};

declare global {
  // eslint-disable-next-line no-var
  var __docQueryRagStore: RagStore | undefined;
}

export function getStore(): RagStore {
  if (!globalThis.__docQueryRagStore) {
    globalThis.__docQueryRagStore = { documents: new Map() };
  }
  return globalThis.__docQueryRagStore;
}

export function listDocuments(): DocumentSummary[] {
  return Array.from(getStore().documents.values())
    .map(({ chunks, ...summary }) => ({ ...summary, chunks: chunks.length }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export function addDocument(document: StoredDocument) {
  getStore().documents.set(document.id, document);
}

export function getDocument(id: string) {
  return getStore().documents.get(id);
}

export function deleteDocument(id: string) {
  return getStore().documents.delete(id);
}

export type { StoredChunk, StoredDocument };
