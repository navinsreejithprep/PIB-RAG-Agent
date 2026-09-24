export function cleanText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function findBoundary(text: string, start: number, target: number) {
  const window = text.slice(start, Math.min(text.length, start + target + 180));
  const candidates = [
    window.lastIndexOf("\n\n"),
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
    window.lastIndexOf(" "),
  ];
  const boundary = Math.max(...candidates);
  if (boundary >= Math.max(200, target - 180)) return start + boundary + (window[boundary] === " " ? 1 : 2);
  return Math.min(text.length, start + target);
}

export function chunkText(text: string, size = 1000, overlap = 100) {
  if (!text.trim()) return [] as { text: string; start: number; end: number }[];
  if (overlap >= size) throw new Error("Chunk overlap must be smaller than chunk size.");
  const chunks: { text: string; start: number; end: number }[] = [];
  let start = 0;
  while (start < text.length) {
    const end = findBoundary(text, start, size);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push({ text: chunk, start, end });
    if (end >= text.length) break;
    const next = Math.max(start + 1, end - overlap);
    start = next;
  }
  return chunks;
}

export function chunkPages(pages: { num: number; text: string }[], size = 1000, overlap = 100) {
  const output: Array<{ text: string; pageNumber: number; chunkIndex: number }> = [];
  let index = 0;
  for (const page of pages) {
    const cleaned = cleanText(page.text);
    if (!cleaned) continue;
    for (const chunk of chunkText(cleaned, size, overlap)) {
      output.push({ text: chunk.text, pageNumber: page.num, chunkIndex: index++ });
    }
  }
  return output;
}
