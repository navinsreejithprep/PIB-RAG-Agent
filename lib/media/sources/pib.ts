import type { MediaItem } from "../types";

// Live data source: Press Information Bureau (Government of India) English
// press releases, via a community-maintained static mirror that rebuilds
// daily from PIB's own site (https://github.com/gkgangavarapu/pibindia-rss).
//
// Why PIB, and why this mirror specifically:
// - PIB releases are primary-source government announcements, not licensed
//   news content, so there is no publisher paywall/attribution restriction —
//   genuinely free, indefinitely, including for a project like this one.
// - Unlike most free news APIs (NewsAPI, GNews, NewsData.io), PIB releases
//   include full text, which the comparison/citation-verification tools
//   need to do more than restate a headline.
// - PIB's own site serves RSS without a reliable English-language, full-text
//   feed (its native RssMain.aspx endpoint returns Hindi titles/links only,
//   confirmed by hand against several region/language parameter
//   combinations); the community mirror above already solved that problem,
//   so this reuses it rather than screen-scraping PIB's ASP.NET pages.
//
// Known limitation (documented, not hidden): this feed carries only the
// *previous calendar day's* English releases across ALL ministries — it is
// not filterable by topic server-side, and on any given day it may contain
// zero renewable-energy-related releases. Re-running ingestion on different
// days accumulates a real historical archive (existing IDs are skipped, see
// lib/media/store.ts's seed()); it does not, by itself, guarantee coverage
// of any specific sector on demand. Cross-outlet comparison does not apply
// to PIB alone, since every item shares one ultimate source (the Indian
// government) — see README's Data sources section.

const FEED_URL = "https://gkgangavarapu.github.io/pibindia-rss/feed.xml";
const FETCH_TIMEOUT_MS = 15_000;

const ENERGY_KEYWORDS = ["renewable", "solar", "wind power", "wind energy", "mnre", "clean energy", "green hydrogen", "battery storage", "power ministry", "electricity"];

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractDepartment(descriptionHtml: string): string | null {
  // PIB's release template opens with a centered <td> containing the issuing
  // ministry/office name, immediately followed by a spacer <div>. This is a
  // convention observed across the feed's items, not a documented format, so
  // it is treated as best-effort: fall back to "Press Information Bureau"
  // when it doesn't match.
  const match = descriptionHtml.match(/<td[^>]*>\s*([\s\S]*?)\s*<div/);
  if (!match) return null;
  const text = stripTags(match[1]).replace(/\s+/g, " ").trim();
  if (!text || text.length > 100 || /posted on/i.test(text)) return null;
  return text;
}

function parseRssDate(pubDate: string): string {
  const parsed = new Date(pubDate);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function inferTopic(title: string, content: string): string {
  const haystack = `${title} ${content}`.toLowerCase();
  return ENERGY_KEYWORDS.some((kw) => haystack.includes(kw)) ? "policy" : "government-affairs";
}

function prIdFromLink(link: string): string {
  const match = link.match(/PRID=(\d+)/i);
  return match ? match[1] : link;
}

export type PibFetchResult = { items: MediaItem[]; fetchedAt: string };

export async function fetchPibReleases(): Promise<PibFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let xml: string;
  try {
    const response = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ExecutiveMediaIntelligenceAgent/1.0)" },
    });
    if (!response.ok) throw new Error(`PIB feed request failed with status ${response.status}.`);
    xml = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The PIB feed did not respond in time.");
    }
    throw new Error(`Could not reach the PIB feed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  const rawItems = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const items: MediaItem[] = [];

  for (const raw of rawItems) {
    const title = raw.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const link = raw.match(/<link>([\s\S]*?)<\/link>/)?.[1];
    const pubDate = raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const descriptionMatch = raw.match(/<description>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/description>/);

    if (!title || !link || !descriptionMatch) continue; // malformed item; skip rather than fail the whole batch

    const decodedTitle = decodeEntities(title).trim();
    const content = stripTags(descriptionMatch[1]);
    if (!content || content.length < 40) continue; // no usable body text

    const date = pubDate ? parseRssDate(pubDate) : "";
    const department = extractDepartment(descriptionMatch[1]);

    items.push({
      id: `PIB-${prIdFromLink(link.trim())}`,
      kind: "article",
      title: decodedTitle,
      source: department ? `${department} (via PIB)` : "Press Information Bureau",
      date,
      url: link.trim(),
      topic: inferTopic(decodedTitle, content),
      content,
    });
  }

  return { items, fetchedAt: new Date().toISOString() };
}
