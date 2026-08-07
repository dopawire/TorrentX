import { describe, expect, it } from "vitest";
import { detectCodec, detectMediaType, detectQuality, normalizeTitle } from "../src/utils/text.js";

describe("detectQuality", () => {
  it("does not treat HDR as a resolution", () => {
    expect(detectQuality("Movie Name 4K HDR")).toBe("2160p");
    expect(detectQuality("Movie Name 1080p HDR")).toBe("1080p");
    expect(detectQuality("Movie Name HDR")).toBeUndefined();
  });

  it("normalizes common resolutions", () => {
    expect(detectQuality("Movie 4k")).toBe("2160p");
    expect(detectQuality("Movie UHD")).toBe("2160p");
    expect(detectQuality("Movie 1080p")).toBe("1080p");
    expect(detectQuality("Movie 1080i")).toBe("1080i");
    expect(detectQuality("Movie 720p")).toBe("720p");
    expect(detectQuality("Movie 480p")).toBe("480p");
  });

  it("returns undefined when no resolution is present", () => {
    expect(detectQuality("Movie Name")).toBeUndefined();
  });
});

describe("detectCodec", () => {
  it("detects common codecs case-insensitively", () => {
    expect(detectCodec("Movie x265")).toBe("X265");
    expect(detectCodec("Movie HEVC")).toBe("HEVC");
    expect(detectCodec("Movie AVC")).toBeUndefined();
  });
});

describe("detectMediaType", () => {
  it("detects anime from release-group naming", () => {
    expect(detectMediaType("[SubsPlease] Anime Episode 01")).toBe("anime");
  });
});

describe("normalizeTitle", () => {
  it("strips release noise for better deduplication", () => {
    expect(normalizeTitle("Movie.Name.2024.1080p.BluRay.x264-YTS")).toBe("movie name 2024");
  });
});
