import { beforeEach, describe, expect, it, vi } from "vitest";
import createMockRes from "test-utils/create-mock-res";

const { getServerSession, verifyToken, isTotpEnabled, clearTotpState } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  verifyToken: vi.fn(),
  isTotpEnabled: vi.fn(),
  clearTotpState: vi.fn(),
}));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/totp", () => ({ verifyToken, generateEnrollment: vi.fn(), qrDataUrl: vi.fn() }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled, clearTotpState, writeTotpState: vi.fn() }));

import handler from "pages/api/security/totp/disable";

describe("pages/api/security/totp/disable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { name: "admin" } });
    isTotpEnabled.mockReturnValue(true);
  });

  it("400s when 2FA is not enabled", async () => {
    isTotpEnabled.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { token: "123456" } }, res);
    expect(res.statusCode).toBe(400);
  });

  it("400s on a wrong code", async () => {
    verifyToken.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { token: "000000" } }, res);
    expect(res.statusCode).toBe(400);
    expect(clearTotpState).not.toHaveBeenCalled();
  });

  it("clears state on a correct code", async () => {
    verifyToken.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { token: "123456" } }, res);
    expect(clearTotpState).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });
});
