import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfig } from "../src/core/config.js";
import { SearchEngine } from "../src/core/search-engine.js";
import { CacheService } from "../src/services/cache-service.js";
import { dedupeResults } from "../src/services/dedupe-service.js";
import type { HttpClient } from "../src/services/http-client.js";
import { BitsearchAdapter, mapBitsearchResults } from "../src/sources/bitsearch.js";
import { FmhyAdapter } from "../src/sources/fmhy.js";
import { LimeTorrentsAdapter } from "../src/sources/limetorrents.js";
import { NyaaAdapter } from "../src/sources/nyaa.js";
import { PirateBayAdapter, pirateBayMediaType } from "../src/sources/piratebay.js";
import { createResult } from "../src/sources/source-utils.js";
import { parseTgxListing, TorrentGalaxyAdapter, tgxMediaType } from "../src/sources/torrentgalaxy.js";
import type { MediaType, SearchRequest, SourceAdapter } from "../src/types/search.js";
import { detectMediaType } from "../src/utils/text.js";

function request(mediaType?: MediaType, query = "japanese"): SearchRequest {
  return {
    query,
    intent: { query, preferredSources: [], terms: [query], ...(mediaType ? { mediaType } : {}) },
    filters: {},
    limit: 10,
  };
}

function recordingHttp(response: { json?: unknown; text?: string }): {
  http: HttpClient;
  urls: string[];
} {
  const urls: string[] = [];
  const http = {
    json: async (url: string) => {
      urls.push(url);
      return response.json ?? {};
    },
    text: async (url: string) => {
      urls.push(url);
      return response.text ?? "<html></html>";
    },
  } as unknown as HttpClient;
  return { http, urls };
}

describe("The Pirate Bay categories", () => {
  it("maps apibay category codes to media types", () => {
    expect(pirateBayMediaType("104")).toBe("music");
    expect(pirateBayMediaType("102")).toBe("book");
    expect(pirateBayMediaType("207")).toBe("movie");
    expect(pirateBayMediaType("208")).toBe("tv");
    expect(pirateBayMediaType("301")).toBe("software");
    expect(pirateBayMediaType("401")).toBe("game");
    expect(pirateBayMediaType("505")).toBe("adult");
    expect(pirateBayMediaType("601")).toBe("book");
    expect(pirateBayMediaType("699")).toBeUndefined();
    expect(pirateBayMediaType(undefined)).toBeUndefined();
  });

  it("filters server-side by category and tags each result", async () => {
    const { http, urls } = recordingHttp({
      json: [
        {
          id: "1", name: "Some Clip", info_hash: "a".repeat(40), leechers: "1", seeders: "9",
          num_files: "1", size: "100", username: "u", added: "0", status: "member", category: "505",
        },
      ],
    });
    const found = await new PirateBayAdapter(http).search(request("adult"));
    expect(urls[0]).toContain("&cat=500");
    expect(found[0]?.mediaType).toBe("adult");

    await new PirateBayAdapter(http).search(request());
    expect(urls[1]).not.toContain("cat=");
  });
});

describe("Bitsearch categories", () => {
  const item = {
    id: "x", infohash: "b".repeat(40), title: "Album", size: 1, category: 7,
    seeders: 1, leechers: 0, downloads: 0, verified: false, updatedAt: "",
  };

  it("maps category ids to media types", () => {
    const [music, adult, book, other] = mapBitsearchResults(
      {
        results: [
          item,
          { ...item, id: "a", category: 10 },
          { ...item, id: "b", category: 8, title: "Plain Title" },
          { ...item, id: "c", category: 1, title: "Plain Title Two" },
        ],
      },
      "bitsearch.eu",
      10,
    );
    expect(music?.mediaType).toBe("music");
    expect(adult?.mediaType).toBe("adult");
    expect(book?.mediaType).toBe("book");
    expect(other?.mediaType).toBeUndefined();
  });

  it("passes the category filter to the API", async () => {
    const { http, urls } = recordingHttp({ json: { results: [item] } });
    await new BitsearchAdapter(http).search(request("music"));
    expect(urls[0]).toContain("category=7");
  });
});

describe("TorrentGalaxy categories", () => {
  const LISTING = `
    <div class="tgxtablerow txlight">
      <div class="tgxtablecell"><a href="/get-posts/category:XXX:time:10D"><small>XXX</small></a></div>
      <a class="txlight" title="Some Adult Title" href="/post-detail/1/some/">x</a>
      [<font color="green"><b>12</b></font>/<font color="#ff0000"><b>3</b></font> ]
      <a href="magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc">m</a>
    </div>`;

  it("reads each row's category and maps it", () => {
    const [row] = parseTgxListing(LISTING);
    expect(row?.category).toBe("XXX");
    expect(tgxMediaType(row?.category)).toBe("adult");
    expect(tgxMediaType("Apps")).toBe("software");
    expect(tgxMediaType("Docus")).toBe("documentary");
  });

  it("scopes keyword searches to the category", async () => {
    const { http, urls } = recordingHttp({
      text: `${LISTING}<a href="magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc">m</a>`,
    });
    const found = await new TorrentGalaxyAdapter(http).search(request("adult"));
    expect(urls[0]).toContain("/get-posts/keywords:japanese:category:XXX");
    expect(found[0]?.mediaType).toBe("adult");
  });
});

describe("LimeTorrents categories", () => {
  it("tags rows from the 'in <category>' date cell", async () => {
    const html = `<table><tr bgcolor="#EAEAEA">
      <td><div class="tt-name"><a href="https://itorrents.net/torrent/${"D".repeat(40)}.torrent">dl</a> <a href="/some-album-torrent.html">Some Album</a></div></td>
      <td class="tdnormal">2 days ago - in <a href="/browse-torrents/Music/">Music</a></td>
      <td class="tdnormal">90 MB</td><td class="tdseed">5</td><td class="tdleech">1</td>
    </tr></table>`;
    const { http } = recordingHttp({ text: html });
    const [found] = await new LimeTorrentsAdapter(http).search(request());
    expect(found?.mediaType).toBe("music");
  });
});

describe("Nyaa categories", () => {
  it("scopes music and book searches but leaves anime searches open", async () => {
    const { http, urls } = recordingHttp({ text: "<rss><channel></channel></rss>" });
    const nyaa = new NyaaAdapter(http);
    await nyaa.search(request("music"));
    await nyaa.search(request("anime"));
    expect(urls[0]).toContain("c=2_0");
    expect(urls[1]).not.toContain("c=");
  });
});

describe("FMHY duplicates", () => {
  it("keeps one entry per link even when the wiki lists it under several headings", async () => {
    const markdown = [
      "## Streaming",
      "* [Same Site](https://same.example/) - Japanese archive",
      "## Cartoon Streaming",
      "* [Same Site](https://same.example/) - Japanese cartoons, see [Discord](https://discord.example)",
    ].join("\n");
    const { http } = recordingHttp({ text: markdown });
    const cache = new CacheService(60_000, await mkdtemp(path.join(os.tmpdir(), "fmhy-dupes-")));
    const found = await new FmhyAdapter(http, cache).search(request(undefined, "same"));
    expect(found).toHaveLength(1);
    expect(new Set(found.map((result) => result.id)).size).toBe(found.length);
  });
});

describe("dedupeResults", () => {
  it("never returns two results with the same id", () => {
    const a = createResult({ title: "Page A", source: "fmhy", sourceReliability: 1, detailsUrl: "https://x.example" });
    const b = { ...a, title: "Page A (other heading)" };
    expect(dedupeResults([a, b])).toHaveLength(1);
  });
});

describe("detectMediaType new categories", () => {
  it("recognizes adult, music and book titles", () => {
    expect(detectMediaType("OnlyFans - Someone - Clip")).toBe("adult");
    expect(detectMediaType("Some.Show.S01E02.XXX.1080p")).toBe("adult");
    expect(detectMediaType("Queen - Discography [FLAC]")).toBe("music");
    expect(detectMediaType("Dune by Frank Herbert EPUB")).toBe("book");
    expect(detectMediaType("Plain Movie 2024 1080p")).toBeUndefined();
  });
});

describe("category routing in the engine", () => {
  it("only queries sources that carry the requested category", async () => {
    const queried: string[] = [];
    const source = (id: string, mediaTypes: MediaType[]): SourceAdapter => ({
      id,
      name: id,
      reliability: 0.9,
      mediaTypes,
      regions: ["global"],
      async search() {
        queried.push(id);
        return [];
      },
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "torrentx-cat-"));
    const config = createConfig();
    const engine = new SearchEngine(
      [source("general", ["movie", "adult", "other"]), source("anime-only", ["anime"])],
      config,
      new CacheService(config.cacheTtlMs, directory),
    );

    await engine.search("clip", { mediaType: "adult", cache: false, enrich: false, expandQuery: false });
    expect(queried).toEqual(["general"]);

    queried.length = 0;
    await engine.search("clip", { cache: false, enrich: false, expandQuery: false });
    expect(queried.sort()).toEqual(["anime-only", "general"]);
  });
});
