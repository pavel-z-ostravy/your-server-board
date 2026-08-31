import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock, confDir } = vi.hoisted(() => ({ warnMock: vi.fn(), confDir: { value: "" } }));
vi.mock("utils/logger", () => ({ default: vi.fn(() => ({ warn: warnMock })) }));
vi.mock("utils/config/config", () => ({
  get CONF_DIR() {
    return confDir.value;
  },
}));

import { clearTotpState, isTotpEnabled, readTotpState, writeTotpState } from "utils/auth/totp-store";

describe("utils/auth/totp-store", () => {
  beforeEach(() => {
    warnMock.mockClear();
    confDir.value = mkdtempSync(join(tmpdir(), "ysb-auth-"));
  });

  it("returns {} when the file does not exist, without warning", () => {
    expect(readTotpState()).toEqual({});
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("round-trips a written state", () => {
    writeTotpState({ totp: { secret: "ABC", enabledAt: "2026-08-31T00:00:00.000Z" } });
    expect(readTotpState()).toEqual({ totp: { secret: "ABC", enabledAt: "2026-08-31T00:00:00.000Z" } });
    expect(isTotpEnabled()).toBe(true);
  });

  it("writes the file with 0600 permissions", () => {
    writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
    const mode = statSync(join(confDir.value, "auth.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens permissions on an already-existing file", () => {
    const path = join(confDir.value, "auth.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file as disabled and warns", () => {
    writeFileSync(join(confDir.value, "auth.json"), "not json{");
    expect(readTotpState()).toEqual({});
    expect(isTotpEnabled()).toBe(false);
    expect(warnMock).toHaveBeenCalled();
  });

  it("clearTotpState leaves an empty object", () => {
    writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
    clearTotpState();
    expect(readTotpState()).toEqual({});
    expect(JSON.parse(readFileSync(join(confDir.value, "auth.json"), "utf8"))).toEqual({});
  });
});
