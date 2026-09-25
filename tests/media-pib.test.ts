import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPibReleases } from "@/lib/media/sources/pib";

// The fixture is two real items captured from the live PIB community RSS
// mirror (https://github.com/gkgangavarapu/pibindia-rss) on 2026-09-25, not
// synthesized — this test locks in the parser's behavior against PIB's
// actual (undocumented) markup rather than a hand-written approximation of it.
const FIXTURE = readFileSync(path.join(process.cwd(), "tests/fixtures/pib-sample.xml"), "utf-8");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPibReleases", () => {
  it("parses real PIB feed markup into MediaItems with department, date, and clean text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(FIXTURE, { status: 200 })));

    const { items } = await fetchPibReleases();
    expect(items).toHaveLength(2);

    const energyItem = items.find((i) => i.title.includes("Shripad Naik"))!;
    expect(energyItem).toBeDefined();
    expect(energyItem.id).toBe("PIB-2314488");
    expect(energyItem.source).toBe("Ministry of Power (via PIB)");
    expect(energyItem.date).toBe("2026-09-24");
    expect(energyItem.url).toContain("PRID=2314488");
    expect(energyItem.kind).toBe("article");
    // Body text should be stripped of HTML and not contain leftover tags/entities.
    expect(energyItem.content).not.toMatch(/<[^>]+>/);
    expect(energyItem.content).not.toContain("&amp;");
    expect(energyItem.content.length).toBeGreaterThan(100);
  });

  it("classifies an energy-related release as topic 'policy' via keyword match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(FIXTURE, { status: 200 })));
    const { items } = await fetchPibReleases();
    const energyItem = items.find((i) => i.title.includes("Renewable Energy"))!;
    expect(energyItem.topic).toBe("policy");
  });

  it("classifies a non-energy release as 'government-affairs'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(FIXTURE, { status: 200 })));
    const { items } = await fetchPibReleases();
    const other = items.find((i) => !i.title.includes("Renewable Energy"))!;
    expect(other.topic).toBe("government-affairs");
  });

  it("throws a clear error when the feed request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await expect(fetchPibReleases()).rejects.toThrow(/status 500/);
  });

  it("returns an empty list rather than throwing when the feed has no items", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<rss><channel></channel></rss>", { status: 200 })));
    const { items } = await fetchPibReleases();
    expect(items).toEqual([]);
  });

  it("skips an item with a missing or unparseable pubDate instead of producing an empty date", async () => {
    // Regression test: MediaItem.date feeds a NOT NULL `date` column
    // (lib/media/store.ts) and is unnest()'d as ::date[] in the bulk
    // upsert — an empty string there would fail the whole insert batch,
    // not just this one item.
    const badItem = `<item>
      <title>Some release with a broken date</title>
      <link>https://www.pib.gov.in/PressReleseDetailm.aspx?PRID=9999999</link>
      <guid isPermaLink="false">pib-9999999</guid>
      <pubDate>not a real date</pubDate>
      <description><![CDATA[<table><tr><td>Some Ministry<div></div><div>${"x".repeat(60)}</div></tr></table>]]></description>
    </item>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`<rss><channel>${badItem}</channel></rss>`, { status: 200 })));
    const { items } = await fetchPibReleases();
    expect(items).toEqual([]);
  });
});
