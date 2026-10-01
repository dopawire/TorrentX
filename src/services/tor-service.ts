import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import envPaths from "env-paths";

/**
 * Built-in Tor support, modelled on Brave's "Private Window with Tor":
 * TorrentX finds a Tor client on the machine (PATH, Tor Browser installs, or
 * TORRENTX_TOR_BINARY), launches it as a managed daemon with its own SOCKS
 * port, waits for the bootstrap, and routes source traffic through it.
 *
 * Nothing is bundled or downloaded at runtime — Tor is a mature, audited
 * codebase and shipping platform binaries inside an npm package would be a
 * supply-chain liability. Every platform that can run TorrentX can install
 * Tor (or already has it via Tor Browser).
 */

const BOOTSTRAP_TIMEOUT_MS = 120_000;

export interface TorHandle {
  socksPort: number;
  /** socks5h:// URL — DNS is resolved by Tor, never by the local resolver. */
  socksUrl: string;
  stop(): Promise<void>;
}

export interface StartTorOptions {
  /** Tor executable; defaults to findTorBinary(). */
  binary?: string;
  /** Replace the daemon arguments entirely (used by tests). */
  args?: string[];
  dataDirectory?: string;
  bootstrapTimeoutMs?: number;
  onProgress?: (percent: number) => void;
}

function torDataRoot(): string {
  return join(envPaths("torrentx", { suffix: "" }).data, "tor-data");
}

/** Candidate locations of a usable Tor client, most specific first. */
export function torBinaryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const override = env["TORRENTX_TOR_BINARY"];
  if (override) candidates.push(override);

  const exeName = process.platform === "win32" ? "tor.exe" : "tor";
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  for (const dir of (env["PATH"] ?? "").split(pathSeparator)) {
    if (dir.trim()) candidates.push(join(dir.trim(), exeName));
  }

  const home = os.homedir();
  if (process.platform === "win32") {
    for (const base of [
      env["ProgramFiles"] ?? "C:\\Program Files",
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"),
    ]) {
      candidates.push(join(base, "Tor Browser", "Browser", "TorBrowser", "Tor", exeName));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Tor Browser.app/Contents/MacOS/Tor/tor");
    candidates.push(join(home, "Applications", "Tor Browser.app/Contents/MacOS/Tor/tor"));
    candidates.push("/opt/homebrew/bin/tor", "/usr/local/bin/tor", "/opt/local/bin/tor");
  } else {
    candidates.push(
      "/usr/bin/tor",
      "/usr/local/bin/tor",
      join(home, "tor-browser_en-US", "Browser", "TorBrowser", "Tor", "tor"),
      join(home, ".local", "bin", "tor"),
    );
  }
  return candidates;
}

export function findTorBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return torBinaryCandidates(env).find((candidate) => existsSync(candidate));
}

export function torInstallHint(): string {
  if (process.platform === "win32") {
    return "Install Tor Browser (https://www.torproject.org/download/) or set TORRENTX_TOR_BINARY to tor.exe.";
  }
  if (process.platform === "darwin") {
    return "Install Tor Browser (https://www.torproject.org/download/) or `brew install tor`, or set TORRENTX_TOR_BINARY.";
  }
  return "Install Tor (`sudo apt install tor` / `sudo dnf install tor` / `pkg install tor` on Termux) or set TORRENTX_TOR_BINARY.";
}

export async function startTor(options: StartTorOptions = {}): Promise<TorHandle> {
  const binary = options.binary ?? findTorBinary();
  if (!binary) {
    throw new Error(`No Tor client found. ${torInstallHint()}`);
  }

  const baseDir = options.dataDirectory ?? torDataRoot();
  const args = options.args ?? torArgs(baseDir);

  pruneStaleTorData(baseDir);

  let handle: LaunchHandle;
  try {
    handle = await launch(binary, args, options);
  } catch (error) {
    // Another TorrentX instance may hold the shared data-dir lock.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("locked")) {
      const fallback = join(baseDir, `run-${process.pid}-${Date.now()}`);
      handle = await launch(
        binary,
        options.args ?? torArgs(fallback),
        options,
      );
      handle.cleanupDirs.push(fallback);
    } else {
      throw error;
    }
  }

  return handle;
}

function torArgs(dataDirectory: string): string[] {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  return [
    "--SocksPort",
    "auto",
    "--DataDirectory",
    dataDirectory,
    "--AvoidDiskWrites",
    "1",
    "--Log",
    "notice stdout",
    "--CookieAuthentication",
    "0",
  ];
}

interface LaunchHandle extends TorHandle {
  cleanupDirs: string[];
}

function launch(
  binary: string,
  args: string[],
  options: StartTorOptions,
): Promise<LaunchHandle> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const cleanupDirs: string[] = [];
    let socksPort: number | undefined;
    let bootstrapped = false;
    let stderrTail = "";
    let settled = false;

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Tor bootstrap timed out after ${options.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS}ms. ` +
            "The network may be blocking Tor — see the README for bridge options.",
        ),
      );
    }, options.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS);
    timeout.unref?.();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
        for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
        reject(error);
        return;
      }
      resolve({
        socksPort: socksPort!,
        socksUrl: `socks5h://127.0.0.1:${socksPort}`,
        cleanupDirs,
        async stop() {
          await stopProcess(child);
          for (const dir of cleanupDirs) {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      });
    };

    const considerReady = () => {
      if (socksPort !== undefined && bootstrapped) finish();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const portMatch = line.match(/Opened Socks listener connection \(ready\) on .+:(\d+)/);
        if (portMatch) {
          socksPort = Number(portMatch[1]);
        }
        const bootstrapMatch = line.match(/Bootstrapped (\d+)%/);
        if (bootstrapMatch) {
          options.onProgress?.(Number(bootstrapMatch[1]));
          if (Number(bootstrapMatch[1]) >= 100) bootstrapped = true;
        }
        considerReady();
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-800);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ENOENT"
          ? new Error(`Tor binary not executable: ${binary}. ${torInstallHint()}`)
          : error,
      );
    });

    child.on("exit", (code) => {
      if (settled) return;
      finish(
        new Error(
          `Tor exited with code ${code} before bootstrap.${stderrTail ? ` ${stderrTail.trim()}` : ""}`,
        ),
      );
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 5_000);
    killTimer.unref?.();
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
}

/**
 * Remove per-run data directories left behind by crashed runs (older than a
 * day — anything younger may belong to a concurrent TorrentX instance).
 */
export function pruneStaleTorData(root = torDataRoot()): void {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("run-")) continue;
      const path = join(root, entry);
      try {
        if (statSync(path).mtimeMs < dayAgo) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}
