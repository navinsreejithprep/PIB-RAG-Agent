export type Chunk = {
  id: string;
  text: string;
  documentId: string;
  documentName: string;
  pageNumber: number;
  chunkIndex: number;
  similarity?: number;
};

export type DocumentSummary = {
  id: string;
  name: string;
  pages: number;
  chunks: number;
  uploadedAt: string;
  status: string;
};
