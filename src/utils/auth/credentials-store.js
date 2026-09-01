import { readAuthFile, writeAuthFile } from "utils/auth/auth-file";
import { hashPassword } from "utils/auth/password-hash";
import { hasOidcConfig } from "utils/auth/mode";
import { isAuthEnabled } from "utils/env";

export function managedByEnv() {
  return Boolean(process.env.HOMEPAGE_AUTH_USERNAME && process.env.HOMEPAGE_AUTH_PASSWORD);
}

export function readUser() {
  return readAuthFile().user ?? null;
}

export function usingDefaultCredentials() {
  const user = readUser();
  return !managedByEnv() && !!user && !user.passwordHash;
}

export function currentUsername() {
  if (managedByEnv()) return process.env.HOMEPAGE_AUTH_USERNAME;
  return readUser()?.username ?? "admin";
}

export async function writeUser({ username, password }) {
  const passwordHash = await hashPassword(password);
  writeAuthFile({ user: { username, passwordHash, updatedAt: new Date().toISOString() } });
}

export async function ensureInitialUser() {
  if (process.env.HOMEPAGE_AUTH_ENABLED === "false") return { created: false, reason: "disabled" };
  if (managedByEnv()) return { created: false, reason: "env" };
  if (hasOidcConfig()) return { created: false, reason: "oidc" };
  if (readAuthFile().user) return { created: false, reason: "exists" };
  try {
    writeAuthFile({ user: { username: "admin" } });
  } catch {
    return { created: false, reason: "readonly" };
  }
  return { created: true };
}
