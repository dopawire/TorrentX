import type { MediaType, SearchRequest, SourceAdapter } from "../types/search.js";
import type { HttpClient } from "../services/http-client.js";
import { buildMagnet } from "../utils/magnet.js";
import { parseSize } from "../utils/size.js";
import { decodeEntities } from "../utils/text.js";
import { LIMETORRENTS_DOMAINS as DOMAINS } from "./mirrors.js";
import { createResult, raceMirrors } from "./source-utils.js";

/**
 * LimeTorrents adapter.
 *
 * LimeTorrents has no JSON API — we scrape the search results HTML.
 * Each result row is a `<tr bgcolor=...>` containing:
 *   - A `<div class="tt-name">` with:
 *       1. An itorrents.net `<a>` whose href contains the 40-char info_hash
 *       2. A second `<a>` linking to the details page with the title text
 *   - Subsequent `<td>` cells for: date/category, size, seeders, leechers
 *
 * The first few rows are ads (no itorrents link) and must be skipped.
 */
/** Media type of a LimeTorrents category ("1 Year+ - in Movies"). */
const LIME_MEDIA_TYPES: Record<string, MediaType> = {
  movies: "movie",
  "tv-shows": "tv",
  tv: "tv",
  anime: "anime",
  applications: "software",
  games: "game",
  music: "music",
};

export class LimeTorrentsAdapter implements SourceAdapter {
  readonly id = "limetorrents";
  readonly name = "LimeTorrents";
  readonly reliability = 0.75;
  // No book or adult categories on this index.
  readonly mediaTypes = ["movie", "tv", "anime", "game", "software", "documentary", "music", "other"] as const;
  readonly regions = ["global", "usa", "india", "europe"] as const;

  constructor(private readonly http: HttpClient) {}

  async search(request: SearchRequest) {
    if (request.top) return [];
    return raceMirrors(
      DOMAINS,
      async (domain, signal) => {
        const url = `https://${domain}/search/all/${encodeURIComponent(request.intent.query)}/seeds/1/`;
        const html = await this.http.text(url, signal);
        return this.parseResults(html, domain, request.limit);
      },
      request.signal,
      { isEmpty: (results) => results.length === 0 },
    );
  }

  parseResults(html: string, domain: string, limit: number) {
    const results = [];

    // Match each <tr bgcolor=...>...</tr> block
    const rowRegex = /<tr\s+bgcolor="[^"]*">([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(html)) !== null && results.length < limit * 2) {
      const rowHtml = rowMatch[1]!;

      // Must contain an itorrents.net link (skip ad rows that don't have one)
      const hashMatch = rowHtml.match(
        /href="[^"]*itorrents\.net\/torrent\/([A-Fa-f0-9]{40})\.torrent[^"]*"/i,
      );
      if (!hashMatch) continue;
      const infoHash = hashMatch[1]!;

      // Extract the title from the second <a> inside tt-name (the details link)
      const titleMatch = rowHtml.match(
        /<a\s+href="(\/[^"]+\.html)"[^>]*>([^<]+)<\/a>/,
      );
      if (!titleMatch) continue;

      const detailsPath = titleMatch[1]!;
      const title = decodeEntities(titleMatch[2]!.trim());
      if (!title || title.length < 3) continue;

      const detailsUrl = `https://${domain}${detailsPath}`;

      // Extract size from td cells — find all <td> content.
      // The content pattern must not swallow the closing </td> tag, or a row
      // with nested markup collapses into a single fake cell.
      const tdValues: string[] = [];
      const tdRegex = /<td[^>]*>([^<]*(?:<(?!\/td>)[^>]*>[^<]*)*)<\/td>/gi;
      let tdMatch;
      while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
        tdValues.push(tdMatch[1]!.replace(/<[^>]*>/g, "").trim());
      }

      // td order: [name_cell, date_category, size, seeders, leechers, health]
      // The first td contains the tt-name div, so useful data starts at index 1
      // The size cell holds only the size; a title like "...WEBRip 1600MB..."
      // must not be mistaken for it.
      const sizeStr = tdValues
        .find((v) => /^[\d.,]+\s*[KMGT]i?B$/i.test(v))
        ?.replace(/,/g, "");
      const seeders = Number(tdValues.find((v) => /^\d+$/.test(v.replace(/,/g, "")))?.replace(/,/g, "")) || 0;

      // Find seeders/leechers from tdseed/tdleech classes
      const seedMatch = rowHtml.match(/<td[^>]*class="tdseed"[^>]*>([^<]*)<\/td>/i);
      const leechMatch = rowHtml.match(/<td[^>]*class="tdleech"[^>]*>([^<]*)<\/td>/i);
      // Date cell: "1 Year+ - in Movies" (category sometimes linked).
      const categoryMatch = rowHtml.match(/ - in (?:<a[^>]*>)?([A-Za-z-]+)/i);

      results.push(
        createResult({
          title,
          source: this.id,
          sourceReliability: this.reliability,
          detailsUrl,
          magnetUri: buildMagnet(infoHash, title),
          sizeBytes: parseSize(sizeStr),
          seeders: Number(seedMatch?.[1]?.replace(/,/g, "")) || seeders,
          leechers: Number(leechMatch?.[1]?.replace(/,/g, "")) || 0,
          mediaType: categoryMatch ? LIME_MEDIA_TYPES[categoryMatch[1]!.toLowerCase()] : undefined,
          trusted: false,
        }),
      );
    }

    return dropFakeListings(results);
  }
}

/** Episode markers: S01E02, 1x02, "Episode 5", "Ep 5", " - 379" (not a year). */
const EPISODE_MARKER =
  /\bs\d{1,2}e\d{1,3}\b|\b\d{1,2}x\d{2}\b|\bep(?:isode)?\.?\s*\d{1,4}\b| - (?!(?:19|20)\d{2}\b)\d{1,4}\b/i;

/**
 * LimeTorrents mixes in fake listings with fabricated swarm numbers, which
 * otherwise outrank real torrents. Two patterns, verified against live
 * result pages:
 *
 * 1. Generated counts: leechers almost exactly two-thirds of seeders
 *    (e.g. 56,366 / 37,561), typically on tiny "Windows" or "Photoshop"
 *    uploads claiming tens of thousands of seeders.
 * 2. Clusters: several different listings with near-identical size and
 *    near-identical seeder counts, e.g. dozens of "Inception 2010 Italian/
 *    French/Japanese DVDRip" at exactly 755.53 MB with ~1,400 seeders each.
 *    Episodes of one series legitimately share a size, so clusters whose
 *    titles are mostly numbered episodes are left alone.
 */
export function dropFakeListings<
  T extends { title: string; seeders: number; leechers: number; sizeBytes?: number },
>(results: T[]): T[] {
  const fake = new Set<number>();

  results.forEach((result, index) => {
    if (
      result.seeders >= 1_000 &&
      Math.abs(result.leechers / result.seeders - 2 / 3) < 0.003
    ) {
      fake.add(index);
    }
  });

  results.forEach((result) => {
    const size = result.sizeBytes;
    if (result.seeders < 500 || !size) return;
    const cluster = results.flatMap((other, index) =>
      other.sizeBytes &&
      Math.abs(other.sizeBytes - size) <= 0.08 * size &&
      Math.abs(other.seeders - result.seeders) <= 0.12 * result.seeders
        ? [index]
        : [],
    );
    if (cluster.length < 4) return;
    const episodes = cluster.filter((index) => EPISODE_MARKER.test(results[index]!.title));
    if (episodes.length * 2 >= cluster.length) return;
    for (const index of cluster) fake.add(index);
  });

  return results.filter((_, index) => !fake.has(index));
}
