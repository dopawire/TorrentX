import type { MediaType, Region, SearchRequest, SourceAdapter } from "../types/search.js";
import type { HttpClient } from "../services/http-client.js";
import { buildMagnet } from "../utils/magnet.js";
import { PIRATEBAY_HOST } from "./mirrors.js";
import { createResult } from "./source-utils.js";

interface PirateBayItem {
  id: string;
  name: string;
  info_hash: string;
  leechers: string;
  seeders: string;
  num_files: string;
  size: string;
  username: string;
  added: string;
  status: string;
  category: string;
  imdb?: string;
}

const PIRATEBAY_ID = "piratebay";
const PIRATEBAY_RELIABILITY = 0.72;

/**
 * Media type of a TPB category code: 1xx audio, 2xx video, 3xx apps,
 * 4xx games, 5xx porn, 6xx other. Undefined leaves title detection to it.
 */
export function pirateBayMediaType(category: string | number | undefined): MediaType | undefined {
  const code = Number(category);
  if (!Number.isInteger(code)) return undefined;
  if (code === 102) return "book"; // audio books
  if (code >= 100 && code < 200) return "music";
  if (code === 203) return "music"; // music videos
  if (code === 205 || code === 208 || code === 212) return "tv";
  if ([201, 202, 204, 207, 209, 211].includes(code)) return "movie";
  if (code >= 300 && code < 400) return "software";
  if (code >= 400 && code < 500) return "game";
  if (code >= 500 && code < 600) return "adult";
  if (code === 601 || code === 602) return "book"; // e-books, comics
  return undefined;
}

/** Server-side category filter (apibay `cat`) for a requested media type. */
const PIRATEBAY_CATEGORY: Partial<Record<MediaType, string>> = {
  movie: "200",
  tv: "200",
  music: "100",
  software: "300",
  game: "400",
  adult: "500",
  book: "601",
};

/**
 * Pure mapper: turn an apibay q.php payload into search results.
 * Exported for parser tests.
 */
export function mapPirateBayResults(
  items: PirateBayItem[],
  limit: number,
  region?: Region,
): ReturnType<typeof createResult>[] {
  return items.slice(0, limit * 2).map((item) =>
    createResult({
      title: item.name,
      source: PIRATEBAY_ID,
      sourceReliability: PIRATEBAY_RELIABILITY,
      sourceId: item.id,
      detailsUrl: `https://thepiratebay.org/description.php?id=${item.id}`,
      magnetUri: buildMagnet(item.info_hash, item.name),
      sizeBytes: Number(item.size) || undefined,
      seeders: Number(item.seeders) || 0,
      leechers: Number(item.leechers) || 0,
      uploadedAt: toIsoDate(item.added),
      mediaType: pirateBayMediaType(item.category),
      region,
      trusted: item.status === "trusted" || item.status === "vip",
    }),
  );
}

export class PirateBayAdapter implements SourceAdapter {
  readonly id = PIRATEBAY_ID;
  readonly name = "The Pirate Bay";
  readonly reliability = PIRATEBAY_RELIABILITY;
  readonly mediaTypes = [
    "movie", "tv", "anime", "game", "software", "documentary", "music", "book", "adult", "other",
  ] as const;
  readonly regions = ["global", "usa", "india", "japan", "korea", "china", "europe"] as const;

  constructor(private readonly http: HttpClient) {}

  async search(request: SearchRequest) {
    if (request.top) return [];
    const category = request.intent.mediaType
      ? PIRATEBAY_CATEGORY[request.intent.mediaType]
      : undefined;
    const url =
      `https://${PIRATEBAY_HOST}/q.php?q=${encodeURIComponent(request.intent.query)}` +
      (category ? `&cat=${category}` : "");
    const items = await this.http.json<PirateBayItem[]>(url, request.signal);
    if (!Array.isArray(items) || (items.length === 1 && items[0]?.id === "0")) return [];

    return mapPirateBayResults(items, request.limit, request.intent.region);
  }
}

function toIsoDate(epoch: string): string | undefined {
  const value = Number(epoch);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined;
}
