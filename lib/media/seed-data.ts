import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MediaItem } from "./types";

type RawDataset = { dataset: string; notice: string; articles?: RawItem[]; documents?: RawItem[] };
type RawItem = { id: string; title: string; source: string; date: string; url: string; topic: string; content: string };

export async function loadSampleDataset(): Promise<MediaItem[]> {
  const dataDir = path.join(process.cwd(), "data");
  const [articlesRaw, backgroundRaw] = await Promise.all([
    readFile(path.join(dataDir, "sample-articles.json"), "utf-8"),
    readFile(path.join(dataDir, "sample-background.json"), "utf-8"),
  ]);

  const articles = JSON.parse(articlesRaw) as RawDataset;
  const background = JSON.parse(backgroundRaw) as RawDataset;

  const items: MediaItem[] = [
    ...(articles.articles ?? []).map((a): MediaItem => ({ ...a, kind: "article" })),
    ...(background.documents ?? []).map((b): MediaItem => ({ ...b, kind: "background" })),
  ];

  return items;
}
