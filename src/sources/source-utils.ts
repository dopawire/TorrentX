import type { MediaType, Region, SearchResult, TopPeriod } from "../types/search.js";
import { stableHash } from "../utils/hash.js";
import { detectCodec, detectMediaType, detectQuality } from "../utils/text.js";

/** Length of a top-listing period: "today" = last 24h, "week" = last 7 days. */
export function periodMs(period: TopPeriod): number {
  return period === "today" ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
}

/**
 * Whether an ISO timestamp falls inside the top-listing period. Items with
 * no parseable date are kept (sites without date metadata still contribute
 * their most-seeded entries).
 */
export function withinPeriod(
  iso: string | undefined,
  period: TopPeriod,
  now = Date.now(),
): boolean {
  if (!iso) return true;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return true;
  return now - time <= periodMs(period);
}

/** Keep the most-seeded results inside the period (shared top-listing trim). */
export function topSlice<T extends { seeders: number; uploadedAt?: string }>(
  results: T[],
  top: TopPeriod,
  limit: number,
): T[] {
  return results
    .filter((result) => withinPeriod(result.uploadedAt, top))
    .sort((a, b) => b.seeders - a.seeders)
    .slice(0, limit);
}

export function createResult(input: {
  title: string;
  source: string;
  sourceReliability: number;
  sourceId?: string | undefined;
  detailsUrl?: string | undefined;
  magnetUri?: string | undefined;
  torrentUrl?: string | undefined;
  sizeBytes?: number | undefined;
  seeders?: number | undefined;
  leechers?: number | undefined;
  uploadedAt?: string | undefined;
  quality?: string | undefined;
  codec?: string | undefined;
  language?: string | undefined;
  mediaType?: MediaType | undefined;
  region?: Region | undefined;
  trusted?: boolean | undefined;
}): SearchResult {
  const identity = input.magnetUri ?? input.torrentUrl ?? input.detailsUrl ?? input.title;
  return {
    id: stableHash(`${input.source}:${identity}`),
    title: input.title.trim(),
    source: input.source,
    sourceReliability: input.sourceReliability,
    seeders: input.seeders ?? 0,
    leechers: input.leechers ?? 0,
    trusted: input.trusted ?? true,
    score: 0,
    ...optional("quality", input.quality ?? detectQuality(input.title)),
    ...optional("codec", input.codec ?? detectCodec(input.title)),
    ...optional("mediaType", input.mediaType ?? detectMediaType(input.title)),
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.detailsUrl ? { detailsUrl: input.detailsUrl } : {}),
    ...(input.magnetUri ? { magnetUri: input.magnetUri } : {}),
    ...(input.torrentUrl ? { torrentUrl: input.torrentUrl } : {}),
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.uploadedAt ? { uploadedAt: input.uploadedAt } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.region ? { region: input.region } : {}),
  };
}

/**
 * Parse an arbitrary date string into an ISO timestamp without throwing.
 * Source APIs occasionally emit malformed dates; a single bad record must
 * not kill the entire source run.
 */
export function safeIsoDate(value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export interface MirrorRaceOptions<T = unknown> {
  staggerMs?: number;
  /**
   * Treat a settled result as a mirror failure so the race continues to the
   * next mirror. This prevents a mirror serving a blocked/blank page (which
   * parses to zero rows) from winning the race and hiding healthy mirrors.
   * If every mirror produces an empty result, the first one is returned
   * (empty results are not an error — they mean "no matches").
   */
  isEmpty?: (result: T) => boolean;
}

class EmptyMirrorError<T> extends Error {
  constructor(readonly value: T) {
    super("Mirror returned an empty result");
    this.name = "EmptyMirrorError";
  }
}

/**
 * Start mirror requests a short time apart and use the first completed one.
 * This prevents a single blackholed domain from consuming the full source
 * timeout before the remaining mirrors are ever tried.
 */
export async function raceMirrors<T>(
  domains: readonly string[],
  request: (domain: string, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  options: MirrorRaceOptions<T> = {},
): Promise<T> {
  if (domains.length === 0) {
    throw new Error("At least one source mirror is required");
  }

  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener("abort", relayAbort, { once: true });

  const staggerMs = options.staggerMs ?? 250;
  const isEmpty = options.isEmpty;
  try {
    return await Promise.any(
      domains.map((domain, index) =>
        waitFor(index * staggerMs, controller.signal).then(async () => {
          const result = await request(domain, controller.signal);
          if (isEmpty?.(result)) throw new EmptyMirrorError(result);
          return result;
        }),
      ),
    );
  } catch (error) {
    if (signal?.aborted) throw createAbortError();

    const errors = error instanceof AggregateError ? error.errors : [error];

    // All mirrors either failed or returned empty results: prefer the empty
    // result over an error — "no matches found" is not a source failure.
    const empty = errors.find((candidate) => candidate instanceof EmptyMirrorError);
    if (empty && errors.every((candidate) => isAbortError(candidate) || candidate instanceof EmptyMirrorError)) {
      return (empty as EmptyMirrorError<T>).value;
    }

    throw (
      errors.find(
        (candidate) => !isAbortError(candidate) && !(candidate instanceof EmptyMirrorError),
      ) ??
      errors.at(-1) ??
      new Error("No source mirror responded")
    );
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", relayAbort);
  }
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  if (milliseconds <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}
