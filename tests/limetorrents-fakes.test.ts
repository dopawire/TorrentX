import { describe, expect, it } from "vitest";
import type { HttpClient } from "../src/services/http-client.js";
import { dropFakeListings, LimeTorrentsAdapter } from "../src/sources/limetorrents.js";

const MB = 1_000_000;

function row(title: string, seeders: number, leechers: number, sizeMb: number) {
  return { title, seeders, leechers, sizeBytes: sizeMb * MB };
}

describe("dropFakeListings", () => {
  it("drops listings whose leechers are generated as two-thirds of seeders", () => {
    const kept = dropFakeListings([
      row("Windows 11 Pro ISO", 56_366, 37_561, 43),
      row("Adobe Photoshop 2026", 62_191, 41_454, 1_550),
      row("Real Linux ISO", 1_200, 340, 4_700),
    ]);
    expect(kept.map((r) => r.title)).toEqual(["Real Linux ISO"]);
  });

  it("drops clusters of different listings with the same size and swarm", () => {
    const kept = dropFakeListings([
      row("Inception 2010 Italian DVDRip", 1_474, 1_210, 755.53),
      row("Inception 2010 French DVDRip", 1_413, 1_004, 755.53),
      row("Inception 2010 English PDVD - 2012", 1_392, 1_032, 755.53),
      row("Inception 2010 Japanese DVDRip", 1_356, 1_087, 757.12),
      row("Inception 2010 1080p BluRay x264", 138, 20, 1_800),
    ]);
    expect(kept.map((r) => r.title)).toEqual(["Inception 2010 1080p BluRay x264"]);
  });

  it("keeps episodes of one series even though they share a size", () => {
    const episodes = [379, 386, 387, 375].map((n, i) =>
      row(`[HorribleSubs] Naruto Shippuuden - ${n} [720p]`, 2_965 - i * 60, 300, 315.5),
    );
    expect(dropFakeListings(episodes)).toHaveLength(4);
  });

  it("leaves ordinary, varied results untouched", () => {
    const results = [
      row("Dune Part Two 2024 1080p WEBRip", 1_136, 109, 2_760),
      row("Dune Part Two 2024 2160p WEB-DL", 437, 144, 29_260),
      row("Dune Part Two 2024 1080p x265", 387, 76, 2_000),
      row("Dune Part Two 2024 HDCAM", 14, 6, 996),
    ];
    expect(dropFakeListings(results)).toEqual(results);
  });
});

describe("LimeTorrents size cell", () => {
  it("reads the size column, not a size mentioned in the title", async () => {
    const html = `<table><tr bgcolor="#EAEAEA">
      <td class="tdleft"><div class="tt-name"><a href="http://itorrents.net/torrent/${"E".repeat(40)}.torrent">dl</a><a href="/dune-torrent-18434841.html">Dune Part Two 2024 1080p WEBRip 1600MB DD5 1 x264-GalaxyRG</a></div></td>
      <td class="tdnormal">1 Year+ - in Movies</a></td>
      <td class="tdnormal">1,600.5 MB</td><td class="tdseed">458</td><td class="tdleech">52</td>
    </tr></table>`;
    const http = { text: async () => html } as unknown as HttpClient;
    const [result] = await new LimeTorrentsAdapter(http).search({
      query: "dune",
      intent: { query: "dune", preferredSources: [], terms: ["dune"] },
      filters: {},
      limit: 10,
    });
    expect(result?.sizeBytes).toBe(1_600_500_000);
    expect(result?.mediaType).toBe("movie");
  });
});
