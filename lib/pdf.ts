import { cleanText } from "./text";

// V1 deliberately uses the stable v1 pdf-parse API. It avoids PDF.js worker
// bundling issues that can occur with Next.js/Turbopack and keeps the demo
// focused on the RAG pipeline rather than PDF infrastructure.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require("pdf-parse") as (data: Uint8Array, options?: {
  pagerender?: (pageData: { getTextContent: (options?: unknown) => Promise<{ items: Array<{ str?: string }> }> }) => Promise<string>;
}) => Promise<{ numpages: number; text: string }>;

export async function extractPdf(buffer: Buffer) {
  const pageTexts: string[] = [];

  // Pass a plain Uint8Array copy, not the Node Buffer. The PDF.js build bundled
  // with pdf-parse mishandles Buffers, which makes every upload after the first
  // distinct PDF fail with "bad XRef entry" until the server restarts.
  const result = await pdfParse(new Uint8Array(buffer), {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent({ normalizeWhitespace: true });
      const text = content.items.map((item) => item.str ?? "").join(" ");
      pageTexts.push(cleanText(text));
      return text;
    },
  });

  const pages = pageTexts.map((text, index) => ({
    num: index + 1,
    text,
  }));

  // Fallback for PDFs where the custom page renderer did not return pages.
  if (pages.length === 0 && result.text.trim()) {
    pages.push({ num: 1, text: cleanText(result.text) });
  }

  return {
    pages,
    totalPages: result.numpages,
    text: pages.map((p) => p.text).join("\n\n").trim() || cleanText(result.text),
  };
}
