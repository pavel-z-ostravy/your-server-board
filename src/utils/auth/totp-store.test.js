import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir;

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "ysb-auth-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.HOMEPAGE_CONFIG_DIR;
  vi.restoreAllMocks();
});

async function loadStore() {
  return import("utils/auth/totp-store");
}

describe("utils/auth/totp-store", () => {
  it("returns {} when the file does not exist, without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readTotpState } = await loadStore();
    expect(readTotpState()).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("round-trips a written state", async () => {
    const { readTotpState, writeTotpState, isTotpEnabled } = await loadStore();
    writeTotpState({ totp: { secret: "ABC", enabledAt: "2026-08-31T00:00:00.000Z" } });
    expect(readTotpState()).toEqual({ totp: { secret: "ABC", enabledAt: "2026-08-31T00:00:00.000Z" } });
    expect(isTotpEnabled()).toBe(true);
  });

  it("writes the file with 0600 permissions", async () => {
    const { writeTotpState } = await loadStore();
    writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
    expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("tightens permissions on an already-existing file", async () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const { writeTotpState } = await loadStore();
    writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file as disabled and warns", async () => {
    writeFileSync(join(dir, "auth.json"), "not json{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readTotpState, isTotpEnabled } = await loadStore();
    expect(readTotpState()).toEqual({});
    expect(isTotpEnabled()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("clearTotpState drops only totp and keeps secret/user", async () => {
    const { writeTotpState, clearTotpState } = await loadStore();
    const { writeAuthFile, readAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ secret: "s1", user: { username: "admin" } });
    writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
    clearTotpState();
    expect(readAuthFile()).toEqual({ secret: "s1", user: { username: "admin" } });
  });
});
