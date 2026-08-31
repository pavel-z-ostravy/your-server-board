import { authenticator } from "otplib";
import QRCode from "qrcode";

import { getSettings } from "utils/config/config";
import { readTotpState } from "utils/auth/totp-store";

function issuer() {
  return getSettings().title || "Homepage";
}

export function generateEnrollment(username) {
  const secret = authenticator.generateSecret();
  const issuerName = issuer();
  // otplib's keyuri() does not URL-encode the issuer or account label, so build
  // the otpauth:// URI explicitly with every component properly encoded.
  const label = `${encodeURIComponent(issuerName)}:${encodeURIComponent(username)}`;
  const params = [
    `secret=${secret}`,
    `issuer=${encodeURIComponent(issuerName)}`,
    "algorithm=SHA1",
    "digits=6",
    "period=30",
  ].join("&");
  const otpauthUrl = `otpauth://totp/${label}?${params}`;
  return { secret, otpauthUrl };
}

export function qrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}

export function verifyToken(token, secret) {
  const resolvedSecret = secret ?? readTotpState().totp?.secret;
  if (!resolvedSecret) return false;
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    return authenticator.check(trimmed, resolvedSecret);
  } catch {
    return false;
  }
}
