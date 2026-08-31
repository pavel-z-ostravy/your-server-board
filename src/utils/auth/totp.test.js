import { authenticator } from "otplib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readTotpState, getSettings } = vi.hoisted(() => ({
  readTotpState: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock("utils/auth/totp-store", () => ({ readTotpState }));
vi.mock("utils/config/config", () => ({ getSettings }));

import { generateEnrollment, qrDataUrl, verifyToken } from "utils/auth/totp";

const SECRET = authenticator.generateSecret();

describe("utils/auth/totp", () => {
  beforeEach(() => {
    readTotpState.mockReset();
    getSettings.mockReset();
    getSettings.mockReturnValue({ title: "My Board" });
  });

  it("verifies a current token against an explicit secret", () => {
    expect(verifyToken(authenticator.generate(SECRET), SECRET)).toBe(true);
  });

  it("verifies a current token against the stored secret", () => {
    readTotpState.mockReturnValue({ totp: { secret: SECRET } });
    expect(verifyToken(authenticator.generate(SECRET))).toBe(true);
  });

  it("accepts codes one step either side of now and rejects codes two steps away", () => {
    // Center of a 30s step so ±30s stays within the same neighbouring step.
    const base = 1_700_000_025_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base - 30_000);
      const prevStepCode = authenticator.generate(SECRET);
      vi.setSystemTime(base + 30_000);
      const nextStepCode = authenticator.generate(SECRET);
      vi.setSystemTime(base - 60_000);
      const twoStepsAgoCode = authenticator.generate(SECRET);

      vi.setSystemTime(base);
      expect(verifyToken(prevStepCode, SECRET)).toBe(true);
      expect(verifyToken(nextStepCode, SECRET)).toBe(true);
      expect(verifyToken(twoStepsAgoCode, SECRET)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a wrong / malformed / missing token", () => {
    readTotpState.mockReturnValue({ totp: { secret: SECRET } });
    expect(verifyToken("000000")).toBe(false);
    expect(verifyToken("abc")).toBe(false);
    expect(verifyToken(undefined)).toBe(false);
    expect(verifyToken(123456)).toBe(false);
  });

  it("returns false when no secret is available", () => {
    readTotpState.mockReturnValue({});
    expect(verifyToken("123456")).toBe(false);
  });

  it("builds an otpauth URL with the settings title as issuer", () => {
    const { secret, otpauthUrl } = generateEnrollment("admin");
    expect(secret).toEqual(expect.any(String));
    expect(otpauthUrl).toContain("otpauth://totp/");
    expect(otpauthUrl).toContain("issuer=My%20Board");
    expect(otpauthUrl).toContain("admin");
  });

  it("falls back to Homepage as issuer", () => {
    getSettings.mockReturnValue({});
    expect(generateEnrollment("admin").otpauthUrl).toContain("issuer=Homepage");
  });

  it("produces a PNG data URL for a QR", async () => {
    const url = await qrDataUrl("otpauth://totp/x");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });
});
