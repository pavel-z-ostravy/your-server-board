import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mirror of CONF_DIR in utils/config/config.js — kept in sync deliberately so
// this module has zero src/ imports and stays cheap to pull into the middleware
// bundle.
function configDir() {
  return process.env.HOMEPAGE_CONFIG_DIR || join(process.cwd(), "config");
}

export function authFilePath() {
  return join(configDir(), "auth.json");
}

let cache = null; // { value, at }
let warned = false;

function readFresh() {
  const path = authFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(`Could not read ${path}, treating auth state as empty: ${error.message}`);
    }
    return {};
  }
}

export function readAuthFile() {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const value = readFresh();
  cache = { value, at: Date.now() };
  return value;
}

export function writeAuthFile(patch) {
  const current = readFresh();
  const next = { ...current, ...patch };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete next[key];
  }
  const path = authFilePath();
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  cache = { value: next, at: Date.now() };
}
