import { randomBytes } from "node:crypto";

import { readAuthFile, writeAuthFile } from "utils/auth/auth-file";

export function ensureAuthSecret() {
  const fromEnv = process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET;
  if (fromEnv) return fromEnv;

  const fromFile = readAuthFile().secret;
  if (fromFile) return fromFile;

  const secret = randomBytes(32).toString("base64url");
  try {
    writeAuthFile({ secret });
  } catch (error) {
    console.warn(
      `Could not persist the auth signing secret to config/auth.json (${error.message}). ` +
        `Set HOMEPAGE_AUTH_SECRET, or make config/ writable — otherwise the middleware and the ` +
        `auth route generate different secrets and every sign-in fails.`,
    );
  }
  return secret;
}
