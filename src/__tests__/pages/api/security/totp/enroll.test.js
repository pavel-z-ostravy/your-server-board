import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getServerSession, isTotpEnabled, generateEnrollment, qrDataUrl } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  isTotpEnabled: vi.fn(),
  generateEnrollment: vi.fn(),
  qrDataUrl: vi.fn(),
}));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled, writeTotpState: vi.fn(), clearTotpState: vi.fn() }));
vi.mock("utils/auth/totp", () => ({ generateEnrollment, qrDataUrl, verifyToken: vi.fn() }));

import handler from "pages/api/security/totp/enroll";

describe("pages/api/security/totp/enroll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { name: "admin" } });
  });

  it("405s non-POST", async () => {
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("401s without a session", async () => {
    getServerSession.mockResolvedValue(null);
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(res.statusCode).toBe(401);
  });

  it("409s when 2FA is already enabled", async () => {
    isTotpEnabled.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(res.statusCode).toBe(409);
  });

  it("returns a fresh secret + QR without persisting", async () => {
    isTotpEnabled.mockReturnValue(false);
    generateEnrollment.mockReturnValue({ secret: "S", otpauthUrl: "otpauth://x" });
    qrDataUrl.mockResolvedValue("data:image/png;base64,AAA");
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(generateEnrollment).toHaveBeenCalledWith("admin");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ secret: "S", otpauthUrl: "otpauth://x", qrDataUrl: "data:image/png;base64,AAA" });
  });
});
