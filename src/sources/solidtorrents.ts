import type { SearchRequest, SourceAdapter } from "../types/search.js";
import type { HttpClient } from "../services/http-client.js";
import { buildMagnet } from "../utils/magnet.js";
import { SOLIDTORRENTS_DOMAINS as DOMAINS } from "./mirrors.js";
import { createResult, raceMirrors, safeIsoDate } from "./source-utils.js";

interface SolidTorrentsResponse {
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

const SOLIDTORRENTS_ID = "solidtorrents";
const SOLIDTORRENTS_RELIABILITY = 0.85;

/**
 * Pure mapper: turn a SolidTorrents api/v1/search payload into search results.
 * Exported for parser tests.
 */
export function mapSolidTorrentsResults(
  payload: SolidTorrentsResponse,
  domain: string,
  limit: number,
): ReturnType<typeof createResult>[] {
  return (payload.results ?? []).slice(0, limit * 2).map((item) =>
    createResult({
      title: item.title,
      source: SOLIDTORRENTS_ID,
      sourceReliability: SOLIDTORRENTS_RELIABILITY,
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

export class SolidTorrentsAdapter implements SourceAdapter {
  readonly id = SOLIDTORRENTS_ID;
  readonly name = "SolidTorrents";
  readonly reliability = SOLIDTORRENTS_RELIABILITY;
  readonly mediaTypes = ["movie", "tv", "anime", "game", "software", "documentary", "other"] as const;
  readonly regions = ["global", "usa", "india", "europe"] as const;

  constructor(private readonly http: HttpClient) {}

  async search(request: SearchRequest) {
    if (request.top) return [];
    return raceMirrors(
      DOMAINS,
      async (domain, signal) => {
        const url = new URL(`https://${domain}/api/v1/search`);
        url.searchParams.set("q", request.intent.query);

        const payload = await this.http.json<SolidTorrentsResponse>(url.toString(), signal);
        if (!payload.results?.length) return [];

        return mapSolidTorrentsResults(payload, domain, request.limit);
      },
      request.signal,
      { isEmpty: (results) => results.length === 0 },
    );
  }
}
