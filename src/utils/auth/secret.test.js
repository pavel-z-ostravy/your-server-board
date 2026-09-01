import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "ysb-secret-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.HOMEPAGE_AUTH_SECRET;
});
afterEach(() => {
  delete process.env.HOMEPAGE_CONFIG_DIR;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.HOMEPAGE_AUTH_SECRET;
});

describe("utils/auth/secret", () => {
  it("prefers NEXTAUTH_SECRET, then HOMEPAGE_AUTH_SECRET", async () => {
    process.env.HOMEPAGE_AUTH_SECRET = "H".repeat(40);
    let { ensureAuthSecret } = await import("utils/auth/secret");
    expect(ensureAuthSecret()).toBe("H".repeat(40));
    vi.resetModules();
    process.env.NEXTAUTH_SECRET = "N".repeat(40);
    ({ ensureAuthSecret } = await import("utils/auth/secret"));
    expect(ensureAuthSecret()).toBe("N".repeat(40));
  });

  it("generates, persists (base64url >=32 chars), and is idempotent", async () => {
    const { ensureAuthSecret } = await import("utils/auth/secret");
    const s = ensureAuthSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).secret).toBe(s);
    expect(ensureAuthSecret()).toBe(s);
  });

  it("reads an existing file secret", async () => {
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ secret: "fromfile-".padEnd(40, "x") });
    const { ensureAuthSecret } = await import("utils/auth/secret");
    expect(ensureAuthSecret()).toBe("fromfile-".padEnd(40, "x"));
  });

  it("does not throw when the dir is unwritable", async () => {
    process.env.HOMEPAGE_CONFIG_DIR = "/proc/nonexistent-ysb";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ensureAuthSecret } = await import("utils/auth/secret");
    expect(ensureAuthSecret()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(warn).toHaveBeenCalled();
  });
});
