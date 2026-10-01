import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { startTor, findTorBinary, torBinaryCandidates } = await import(
  "../src/services/tor-service.js"
);

let workDir: string;
let fakeTor: string;
let exitingTor: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "torrentx-tor-test-"));

  // A stand-in Tor daemon: prints the real log lines, then idles until killed.
  fakeTor = join(workDir, "fake-tor.mjs");
  await writeFile(
    fakeTor,
    `
    setTimeout(() => {
      console.log("Sep 30 12:00:00.000 [notice] Opened Socks listener connection (ready) on 127.0.0.1:39001");
      console.log("Sep 30 12:00:01.000 [notice] Bootstrapped 50% (loading_descriptors): Loading relay descriptors");
      console.log("Sep 30 12:00:02.000 [notice] Bootstrapped 100% (done): Done");
    }, 20);
    setInterval(() => {}, 1000);
    process.on("SIGTERM", () => process.exit(0));
    `,
    "utf8",
  );

  // A daemon that dies immediately, like a broken torrc or locked data dir.
  exitingTor = join(workDir, "exiting-tor.mjs");
  await writeFile(
    exitingTor,
    `console.error("Sep 30 12:00:00.000 [err] tor is already running (data dir locked)"); process.exit(1);`,
    "utf8",
  );
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("startTor", () => {
  it("bootstraps a daemon and reports the SOCKS port", async () => {
    const progress: number[] = [];
    const handle = await startTor({
      binary: process.execPath,
      args: [fakeTor],
      dataDirectory: join(workDir, "data-a"),
      bootstrapTimeoutMs: 10_000,
      onProgress: (percent) => progress.push(percent),
    });

    try {
      expect(handle.socksPort).toBe(39001);
      expect(handle.socksUrl).toBe("socks5h://127.0.0.1:39001");
      expect(progress).toContain(50);
      expect(progress).toContain(100);
    } finally {
      await handle.stop();
    }
  });

  it("surfaces daemon startup errors with the stderr tail", async () => {
    await expect(
      startTor({
        binary: process.execPath,
        args: [exitingTor],
        dataDirectory: join(workDir, "data-b"),
        bootstrapTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/already running/);
  });

  it("times out when bootstrap never completes", async () => {
    const silent = join(workDir, "silent-tor.mjs");
    await writeFile(silent, `setInterval(() => {}, 1000);`, "utf8");

    await expect(
      startTor({
        binary: process.execPath,
        args: [silent],
        dataDirectory: join(workDir, "data-c"),
        bootstrapTimeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("explains how to install Tor when no client exists", async () => {
    await expect(
      startTor({
        binary: join(workDir, "does-not-exist"),
        args: [fakeTor],
      }),
    ).rejects.toThrow(/not executable|No Tor client found/);
  });
});

describe("findTorBinary", () => {
  it("prefers TORRENTX_TOR_BINARY", async () => {
    const custom = join(workDir, "my-tor");
    await writeFile(custom, "", "utf8");

    const found = findTorBinary({ TORRENTX_TOR_BINARY: custom, PATH: "/nonexistent" });
    expect(found).toBe(custom);
  });

  it("searches PATH for a tor executable", async () => {
    const pathDir = join(workDir, "path-with-tor");
    await mkdir(pathDir, { recursive: true });
    const torFile = join(pathDir, process.platform === "win32" ? "tor.exe" : "tor");
    await writeFile(torFile, "", "utf8");

    expect(findTorBinary({ PATH: pathDir })).toBe(torFile);
    expect(torBinaryCandidates({ PATH: pathDir })).toContain(torFile);
  });
});
