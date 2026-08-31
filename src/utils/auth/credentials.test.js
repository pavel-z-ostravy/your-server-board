import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("utils/logger", () => ({ default: vi.fn(() => ({ warn: warnMock })) }));

import { logFailedPasswordSignIn, verifyPassword } from "utils/auth/credentials";

describe("utils/auth/credentials", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    warnMock.mockClear();
    process.env = { ...originalEnv };
    process.env.HOMEPAGE_AUTH_USERNAME = "admin";
    process.env.HOMEPAGE_AUTH_PASSWORD = "s3cret";
  });

  it("accepts the correct username and password", () => {
    expect(verifyPassword("admin", "s3cret")).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword("admin", "nope")).toBe(false);
  });

  it("rejects a wrong username", () => {
    expect(verifyPassword("root", "s3cret")).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(verifyPassword(123, "s3cret")).toBe(false);
    expect(verifyPassword("admin", { toString: () => "s3cret" })).toBe(false);
  });

  it("rejects everything when env vars are missing", () => {
    delete process.env.HOMEPAGE_AUTH_PASSWORD;
    expect(verifyPassword("admin", "s3cret")).toBe(false);
  });

  it("compares multibyte values without throwing on unequal byte length", () => {
    process.env.HOMEPAGE_AUTH_PASSWORD = "é";
    expect(verifyPassword("admin", "a")).toBe(false);
    expect(verifyPassword("admin", "é")).toBe(true);
  });

  it("logs a sanitized warning on a failed attempt", () => {
    logFailedPasswordSignIn();
    expect(warnMock).toHaveBeenCalledWith("Failed password sign-in attempt");
  });
});
