import { createHash, timingSafeEqual } from "node:crypto";

import { readUser, managedByEnv } from "utils/auth/credentials-store";
import { verifyHash } from "utils/auth/password-hash";
import createLogger from "utils/logger";

function sha256(v) {
  return createHash("sha256").update(String(v), "utf8").digest();
}

function constantTimeEquals(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

export async function verifyPassword(username, password) {
  if (typeof username !== "string" || typeof password !== "string") return false;

  if (managedByEnv()) {
    const u = constantTimeEquals(username, process.env.HOMEPAGE_AUTH_USERNAME);
    const p = constantTimeEquals(password, process.env.HOMEPAGE_AUTH_PASSWORD);
    return u && p;
  }

  const user = readUser();
  if (!user) return false;
  if (typeof user.username !== "string" || user.username.length === 0) return false;

  if (typeof user.passwordHash === "string" && user.passwordHash.length > 0) {
    const usernameOk = constantTimeEquals(username, user.username);
    const passwordOk = await verifyHash(password, user.passwordHash);
    return usernameOk && passwordOk;
  }
  // A present-but-unusable passwordHash (empty string, null, wrong type) is a
  // broken record, not a bootstrap invitation — reject rather than fall through
  // to the literal admin/admin branch.
  if (user.passwordHash !== undefined) return false;

  const usernameOk = constantTimeEquals(username, user.username);
  const passwordOk = constantTimeEquals(password, "admin");
  return usernameOk && passwordOk;
}

export function logFailedPasswordSignIn() {
  createLogger("nextauth").warn("Failed password sign-in attempt");
}
