import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONF_DIR } from "utils/config/config";
import createLogger from "utils/logger";

const AUTH_FILE = "auth.json";

function authPath() {
  return join(CONF_DIR, AUTH_FILE);
}

export function readTotpState() {
  const path = authPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    createLogger("auth").warn("Could not read %s, treating 2FA as disabled: %s", AUTH_FILE, error.message);
    return {};
  }
}

export function writeTotpState(state) {
  writeFileSync(authPath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearTotpState() {
  writeTotpState({});
}

export function isTotpEnabled() {
  return Boolean(readTotpState().totp?.secret);
}
