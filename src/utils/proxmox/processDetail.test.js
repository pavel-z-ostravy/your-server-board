import { describe, expect, it } from "vitest";

import { parseOsProbe, parseTopProcesses } from "./processDetail";

describe("parseTopProcesses", () => {
  it("parses real ps -eo pid=,pcpu=,pmem=,comm= output into structured entries", () => {
    const stdout =
      "   3368  0.8 18.4 python3\n" +
      "   5200  0.4  2.5 plugin_start_li\n" +
      "    395  0.3  0.1 bluetoothd\n" +
      "   5162  0.2  4.7 grafana\n" +
      "  71220  0.2  7.4 MainThread\n" +
      "    497  0.1  2.0 dockerd\n";

    const result = parseTopProcesses(stdout);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ pid: 3368, cpuPercent: 0.8, memPercent: 18.4, command: "python3" });
    expect(result[4]).toEqual({ pid: 71220, cpuPercent: 0.2, memPercent: 7.4, command: "MainThread" });
  });

  it("respects a custom limit", () => {
    const stdout = "1 0.5 0.1 a\n2 0.4 0.1 b\n3 0.3 0.1 c\n";
    expect(parseTopProcesses(stdout, 2)).toHaveLength(2);
  });

  it("returns an empty array for empty or whitespace-only output", () => {
    expect(parseTopProcesses("")).toEqual([]);
    expect(parseTopProcesses("   \n  \n")).toEqual([]);
  });

  it("skips a malformed line rather than throwing", () => {
    const stdout = "1 0.5 0.1 real-process\nnot-a-valid-line\n2 0.3 0.1 also-real\n";
    const result = parseTopProcesses(stdout);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.command)).toEqual(["real-process", "also-real"]);
  });
});

describe("parseOsProbe", () => {
  it("parses a real Debian os-release block with no update timestamp (none)", () => {
    const stdout =
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n' +
      'NAME="Debian GNU/Linux"\n' +
      'VERSION_ID="12"\n' +
      "---\n" +
      "none\n";

    const result = parseOsProbe(stdout);

    expect(result).toEqual({ prettyName: "Debian GNU/Linux 12 (bookworm)", lastUpdate: null });
  });

  it("parses a real Home Assistant OS os-release block with no update timestamp", () => {
    const stdout =
      'NAME="Home Assistant OS"\n' +
      'PRETTY_NAME="Home Assistant OS 18.2"\n' +
      "VERSION_ID=18.2\n" +
      "---\n" +
      "none\n";

    const result = parseOsProbe(stdout);

    expect(result).toEqual({ prettyName: "Home Assistant OS 18.2", lastUpdate: null });
  });

  it("parses a real Unix timestamp into an ISO date string", () => {
    const stdout = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\n---\n1734000000\n';

    const result = parseOsProbe(stdout);

    expect(result.prettyName).toBe("Ubuntu 24.04.1 LTS");
    expect(result.lastUpdate).toBe(new Date(1734000000 * 1000).toISOString());
  });

  it("returns null prettyName when PRETTY_NAME is absent", () => {
    const stdout = "NAME=Alpine\n---\nnone\n";
    expect(parseOsProbe(stdout).prettyName).toBeNull();
  });

  it("returns null lastUpdate for an unparseable timestamp line", () => {
    const stdout = "PRETTY_NAME=X\n---\nnot-a-number\n";
    expect(parseOsProbe(stdout).lastUpdate).toBeNull();
  });
});
