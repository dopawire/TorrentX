import { describe, expect, it } from "vitest";
import { raceMirrors, safeIsoDate } from "../src/sources/source-utils.js";

describe("raceMirrors", () => {
  it("starts a fallback before a stalled primary request can exhaust the source timeout", async () => {
    const attempts: string[] = [];
    const result = await raceMirrors(
      ["stalled", "healthy"],
      async (domain, signal) => {
        attempts.push(domain);
        if (domain === "stalled") return waitUntilAborted(signal);
        return "healthy result";
      },
      undefined,
      { staggerMs: 1 },
    );

    expect(result).toBe("healthy result");
    expect(attempts).toEqual(["stalled", "healthy"]);
  });

  it("honors cancellation from the parent source request", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      raceMirrors(["one"], async () => "unreachable", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

function waitUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted", "AbortError")),
      { once: true },
    );
  });
}

describe("safeIsoDate", () => {
  it("parses valid timestamps into ISO format", () => {
    expect(safeIsoDate("2024-01-15T10:30:00Z")).toBe("2024-01-15T10:30:00.000Z");
    expect(safeIsoDate(1705300200000)).toBe(new Date(1705300200000).toISOString());
  });

  it("returns undefined for malformed dates instead of throwing", () => {
    expect(safeIsoDate("not-a-date")).toBeUndefined();
    expect(safeIsoDate("")).toBeUndefined();
    expect(safeIsoDate(undefined)).toBeUndefined();
    expect(safeIsoDate("0000-00-00")).toBeUndefined();
  });
});
