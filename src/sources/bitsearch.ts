import type { SearchRequest, SourceAdapter } from "../types/search.js";
import type { HttpClient } from "../services/http-client.js";
import { buildMagnet } from "../utils/magnet.js";
import { BITSEARCH_DOMAINS as DOMAINS } from "./mirrors.js";
import { createResult, safeIsoDate } from "./source-utils.js";

interface BitsearchResponse {
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
 * Pure mapper: turn a Bitsearch api/v1/search payload into search results.
 * Exported for parser tests.
 */
export function mapBitsearchResults(
  payload: BitsearchResponse,
  domain: string,
  limit: number,
): ReturnType<typeof createResult>[] {
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
      trusted: item.verified,
    }),
  );
}

export class BitsearchAdapter implements SourceAdapter {
  readonly id = BITSEARCH_ID;
  readonly name = "Bitsearch";
  readonly reliability = BITSEARCH_RELIABILITY;
  readonly mediaTypes = ["movie", "tv", "anime", "game", "software", "documentary", "other"] as const;
  readonly regions = ["global", "usa", "india", "europe"] as const;

  constructor(private readonly http: HttpClient) {}

  async search(request: SearchRequest) {
    if (request.top) return [];
    let lastError: Error | undefined;

    for (const domain of DOMAINS) {
      try {
        const url = new URL(`https://${domain}/api/v1/search`);
        url.searchParams.set("q", request.intent.query);

        const payload = await this.http.json<BitsearchResponse>(url.toString(), request.signal);
        if (!payload.results?.length) return [];

        return mapBitsearchResults(payload, domain, request.limit);
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw lastError || new Error("All Bitsearch mirrors offline");
  }
}
