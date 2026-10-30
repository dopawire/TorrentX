import type { MediaType, SearchRequest, SearchResult, SourceAdapter } from "../types/search.js";
import type { HttpClient } from "../services/http-client.js";
import { buildMagnet } from "../utils/magnet.js";
import { BITSEARCH_DOMAINS as DOMAINS } from "./mirrors.js";
import { createResult, raceMirrors, safeIsoDate } from "./source-utils.js";

/** Bitsearch api/v1/search payload (also served for the former SolidTorrents). */
export interface BitsearchResponse {
  success?: boolean;
  results?: Array<{
    id: string;
    infohash: string;
    title: string;
    size: number;
    category: number;
    seeders: number;
    leechers: number;
    downloads: number;
    verified: boolean;
    updatedAt: string;
  }>;
  pagination?: { total: number };
}

const BITSEARCH_ID = "bitsearch";
const BITSEARCH_RELIABILITY = 0.82;

/**
 * Bitsearch category ids (verified against live results): 1 other,
 * 2 movies, 3 TV, 4 anime, 5 software, 6 games, 7 music, 8 audiobooks,
 * 9 e-books, 10 adult.
 */
const BITSEARCH_MEDIA_TYPES: Record<number, MediaType> = {
  2: "movie",
  3: "tv",
  4: "anime",
  5: "software",
  6: "game",
  7: "music",
  8: "book",
  9: "book",
  10: "adult",
};

/** Server-side `category` filter for a requested media type. */
const BITSEARCH_CATEGORY: Partial<Record<MediaType, number>> = {
  movie: 2,
  tv: 3,
  anime: 4,
  software: 5,
  game: 6,
  music: 7,
  book: 9,
  adult: 10,
};

/**
 * Pure mapper: turn a Bitsearch api/v1/search payload into search results.
 * Exported for parser tests.
 */
export function mapBitsearchResults(
  payload: BitsearchResponse,
  domain: string,
  limit: number,
): SearchResult[] {
  return (payload.results ?? []).slice(0, limit * 2).map((item) =>
    createResult({
      title: item.title,
      source: BITSEARCH_ID,
      sourceReliability: BITSEARCH_RELIABILITY,
      sourceId: item.id,
      detailsUrl: `https://${domain}/view/${item.id}`,
      magnetUri: buildMagnet(item.infohash, item.title),
      sizeBytes: item.size || undefined,
      seeders: item.seeders,
      leechers: item.leechers,
      uploadedAt: safeIsoDate(item.updatedAt),
      mediaType: BITSEARCH_MEDIA_TYPES[item.category],
      trusted: item.verified,
    }),
  );
}

/**
 * Bitsearch adapter. SolidTorrents was folded into Bitsearch (its domains
 * now redirect here), so this one adapter covers both indexes.
 */
export class BitsearchAdapter implements SourceAdapter {
  readonly id = BITSEARCH_ID;
  readonly name = "Bitsearch";
  readonly reliability = BITSEARCH_RELIABILITY;
  readonly mediaTypes = [
    "movie", "tv", "anime", "game", "software", "documentary", "music", "book", "adult", "other",
  ] as const;
  readonly regions = ["global", "usa", "india", "europe"] as const;

  constructor(private readonly http: HttpClient) {}

  async search(request: SearchRequest) {
    if (request.top) return [];
    return raceMirrors(
      DOMAINS,
      async (domain, signal) => {
        const url = new URL(`https://${domain}/api/v1/search`);
        url.searchParams.set("q", request.intent.query);
        const category = request.intent.mediaType
          ? BITSEARCH_CATEGORY[request.intent.mediaType]
          : undefined;
        if (category) url.searchParams.set("category", String(category));

        const payload = await this.http.json<BitsearchResponse>(url.toString(), signal);
        return mapBitsearchResults(payload, domain, request.limit);
      },
      request.signal,
      { isEmpty: (results) => results.length === 0 },
    );
  }
}
