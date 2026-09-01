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
    // eslint-disable-next-line no-console
    console.warn(
      `Could not persist the auth signing secret (${error.message}). ` +
        `Set HOMEPAGE_AUTH_SECRET or make config/ writable — sessions will not survive a restart.`,
    );
  }
  return secret;
}
