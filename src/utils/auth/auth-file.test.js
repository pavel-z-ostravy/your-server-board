import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir;

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "ysb-authfile-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.HOMEPAGE_CONFIG_DIR;
  vi.restoreAllMocks();
});

async function load() {
  return import("utils/auth/auth-file");
}

describe("utils/auth/auth-file", () => {
  it("returns {} when the file is absent", async () => {
    const { readAuthFile } = await load();
    expect(readAuthFile()).toEqual({});
  });

  it("round-trips a write and merges without clobbering", async () => {
    const { readAuthFile, writeAuthFile } = await load();
    writeAuthFile({ secret: "s1" });
    writeAuthFile({ user: { username: "admin" } });
    expect(readAuthFile()).toEqual({ secret: "s1", user: { username: "admin" } });
  });

  it("deletes a key whose patch value is undefined", async () => {
    const { readAuthFile, writeAuthFile } = await load();
    writeAuthFile({ secret: "s1", totp: { secret: "abc" } });
    writeAuthFile({ totp: undefined });
    expect(readAuthFile()).toEqual({ secret: "s1" });
  });

  it("writes mode 0600", async () => {
    const { writeAuthFile, authFilePath } = await load();
    writeAuthFile({ secret: "s1" });
    expect(statSync(authFilePath()).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing looser file", async () => {
    writeFileSync(join(dir, "auth.json"), "{}");
    chmodSync(join(dir, "auth.json"), 0o644);
    const { writeAuthFile, authFilePath } = await load();
    writeAuthFile({ secret: "s1" });
    expect(statSync(authFilePath()).mode & 0o777).toBe(0o600);
  });

  it("caches reads for 5s and re-reads after", async () => {
    const { readAuthFile, writeAuthFile, authFilePath } = await load();
    writeAuthFile({ secret: "s1" });
    // out-of-band edit
    writeFileSync(authFilePath(), JSON.stringify({ secret: "s2" }));
    expect(readAuthFile().secret).toBe("s1"); // still cached
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    expect(readAuthFile().secret).toBe("s2"); // cache expired
  });

  it("treats a corrupt file as {} and warns once", async () => {
    writeFileSync(join(dir, "auth.json"), "not json {");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readAuthFile } = await load();
    expect(readAuthFile()).toEqual({});
    readAuthFile();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
