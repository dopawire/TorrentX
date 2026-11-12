import { describe, expect, it, vi } from "vitest";
import { createConfig } from "../src/core/config.js";
import { executeDoctor } from "../src/commands/doctor.js";

describe("executeDoctor", () => {
  it("reports the machine's readiness and network mode", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const config = createConfig({
        tor: true,
        proxyFallback: false,
        dnsResolver: "doh",
      });
      executeDoctor(config);

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("node version");
      expect(output).toContain("webtorrent patches");
      expect(output).toContain("download dir");
      expect(output).toContain("state dir");
      expect(output).toContain("tor client");
      expect(output).toContain("tor(strict)");
      expect(output).toContain("dns=doh(");
    } finally {
      log.mockRestore();
      process.exitCode = 0;
    }
  });

  it("redacts proxy passwords in the network line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const config = createConfig({
        socks5Proxy: "socks5h://user:supersecret@127.0.0.1:9050",
      });
      executeDoctor(config);

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("socks5=socks5h://user:***@127.0.0.1:9050");
      expect(output).not.toContain("supersecret");
    } finally {
      log.mockRestore();
      process.exitCode = 0;
    }
  });

  it("marks missing tor as a failure", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const config = createConfig({ torBinary: "/definitely/not/here" });
      executeDoctor(config);

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("FAIL  tor client");
      expect(process.exitCode).toBe(1);
    } finally {
      log.mockRestore();
      process.exitCode = 0;
    }
  });
});
