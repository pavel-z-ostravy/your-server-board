import { beforeEach, describe, expect, it, vi } from "vitest";
import createMockRes from "test-utils/create-mock-res";

const { getServerSession, verifyToken, writeTotpState, isTotpEnabled } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  verifyToken: vi.fn(),
  writeTotpState: vi.fn(),
  isTotpEnabled: vi.fn(),
}));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/totp", () => ({ verifyToken, generateEnrollment: vi.fn(), qrDataUrl: vi.fn() }));
vi.mock("utils/auth/totp-store", () => ({ writeTotpState, isTotpEnabled, clearTotpState: vi.fn() }));

import handler from "pages/api/security/totp/confirm";

describe("pages/api/security/totp/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { name: "admin" } });
    isTotpEnabled.mockReturnValue(false);
  });

  it("409s and does not persist when 2FA is already enabled", async () => {
    isTotpEnabled.mockReturnValue(true);
    verifyToken.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { secret: "S", token: "123456" } }, res);
    expect(res.statusCode).toBe(409);
    expect(writeTotpState).not.toHaveBeenCalled();
  });

  it("rejects a wrong code and does not persist", async () => {
    verifyToken.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { secret: "S", token: "000000" } }, res);
    expect(res.statusCode).toBe(400);
    expect(writeTotpState).not.toHaveBeenCalled();
  });

  it("persists on a correct code", async () => {
    verifyToken.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { secret: "S", token: "123456" } }, res);
    expect(verifyToken).toHaveBeenCalledWith("123456", "S");
    expect(writeTotpState).toHaveBeenCalledWith({ totp: { secret: "S", enabledAt: expect.any(String) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it("500s when the write fails", async () => {
    verifyToken.mockReturnValue(true);
    writeTotpState.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const res = createMockRes();
    await handler({ method: "POST", body: { secret: "S", token: "123456" } }, res);
    expect(res.statusCode).toBe(500);
  });
});
