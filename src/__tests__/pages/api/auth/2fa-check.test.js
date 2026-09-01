import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { verifyPassword, isTotpEnabled, logFailedPasswordSignIn, passwordAuthActive } = vi.hoisted(() => ({
  verifyPassword: vi.fn(),
  isTotpEnabled: vi.fn(),
  logFailedPasswordSignIn: vi.fn(),
  passwordAuthActive: vi.fn(),
}));
vi.mock("utils/auth/credentials", () => ({ verifyPassword, logFailedPasswordSignIn }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled }));
vi.mock("utils/auth/mode", () => ({ passwordAuthActive }));

import handler from "pages/api/auth/2fa-check";

describe("pages/api/auth/2fa-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    passwordAuthActive.mockReturnValue(true);
  });

  it("405s non-POST methods", async () => {
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("404s when password auth is not the active mode (auth disabled or OIDC)", async () => {
    passwordAuthActive.mockReturnValue(false);
    verifyPassword.mockResolvedValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { username: "admin", password: "ok" } }, res);
    expect(res.statusCode).toBe(404);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("400s a missing body", async () => {
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(res.statusCode).toBe(400);
  });

  it("401s and logs when credentials are wrong, without disclosing 2FA state", async () => {
    verifyPassword.mockResolvedValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { username: "admin", password: "x" } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
    expect(res.body).not.toHaveProperty("twoFactorEnabled");
    expect(logFailedPasswordSignIn).toHaveBeenCalledTimes(1);
  });

  it("200s with twoFactorEnabled:false when 2FA is off", async () => {
    verifyPassword.mockResolvedValue(true);
    isTotpEnabled.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { username: "admin", password: "ok" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ twoFactorEnabled: false });
  });

  it("200s with twoFactorEnabled:true when 2FA is on", async () => {
    verifyPassword.mockResolvedValue(true);
    isTotpEnabled.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { username: "admin", password: "ok" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ twoFactorEnabled: true });
  });
});
