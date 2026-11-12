import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), `torrentx-test-results-${Date.now()}`);
process.env.TORRENTX_STATE_DIR = TEST_DIR;

const { ResultStore } = await import("../src/services/result-store.js");

function result(title: string): import("../src/types/search.js").SearchResult {
  return {
    id: title,
    title,
    source: "yts",
    seeders: 1,
    leechers: 0,
    trusted: true,
    sourceReliability: 0.9,
    score: 0,
  };
}

describe("ResultStore", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("writes valid JSON under concurrent saves", async () => {
    const store = new ResultStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.save([result(`r${index}`)])),
    );

    const parsed = JSON.parse(
      await readFile(path.join(TEST_DIR, "last-results.json"), "utf8"),
    ) as Array<{ title: string }>;
    expect(parsed).toHaveLength(1);
    expect(await store.get(1)).toBeDefined();
  });

  it("stores results in the shared state directory by default", async () => {
    await new ResultStore().save([result("shared")]);
    const parsed = JSON.parse(
      await readFile(path.join(TEST_DIR, "last-results.json"), "utf8"),
    ) as Array<{ title: string }>;
    expect(parsed[0]?.title).toBe("shared");
  });

  it("caps saved results at 100", async () => {
    const store = new ResultStore();
    await store.save(Array.from({ length: 150 }, (_, index) => result(`r${index}`)));
    const parsed = JSON.parse(
      await readFile(path.join(TEST_DIR, "last-results.json"), "utf8"),
    ) as unknown[];
    expect(parsed).toHaveLength(100);
  });

  it("misses cleanly when nothing was saved", async () => {
    const store = new ResultStore(path.join(await mkdtemp(path.join(os.tmpdir(), "torrentx-empty-")), "none.json"));
    expect(await store.get(1)).toBeUndefined();
  });
});
