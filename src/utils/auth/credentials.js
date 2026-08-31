import { createHash, timingSafeEqual } from "node:crypto";

import createLogger from "utils/logger";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeEquals(a, b) {
  // Both digests are 32 bytes, so timingSafeEqual never throws here; the
  // hash step is what lets us compare arbitrary-length inputs safely.
  return timingSafeEqual(sha256(a), sha256(b));
}

export function verifyPassword(username, password) {
  const expectedUsername = process.env.HOMEPAGE_AUTH_USERNAME;
  const expectedPassword = process.env.HOMEPAGE_AUTH_PASSWORD;

  if (!expectedUsername || !expectedPassword) return false;
  if (typeof username !== "string" || typeof password !== "string") return false;

  const usernameMatch = constantTimeEquals(username, expectedUsername);
  const passwordMatch = constantTimeEquals(password, expectedPassword);
  return usernameMatch && passwordMatch;
}

export function logFailedPasswordSignIn() {
  createLogger("nextauth").warn("Failed password sign-in attempt");
}
