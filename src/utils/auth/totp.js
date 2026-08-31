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
  // keyuri doesn't URL-encode parameters, so we need to encode them ourselves
  const encodedIssuer = encodeURIComponent(issuerName);
  const encodedUsername = encodeURIComponent(username);
  const baseUri = authenticator.keyuri(username, issuerName, secret);
  // Replace the unencoded issuer in the query string with the encoded version
  const otpauthUrl = baseUri.replace(`issuer=${issuerName}`, `issuer=${encodedIssuer}`);
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
