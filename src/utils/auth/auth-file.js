import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
let lastReadCorrupt = false;

function readFresh() {
  const path = authFilePath();
  if (!existsSync(path)) {
    lastReadCorrupt = false;
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8") || "{}");
    if (parsed && typeof parsed === "object") {
      lastReadCorrupt = false;
      return parsed;
    }
    // Valid JSON but not an object (a scalar like `"5"` or `null`) — the file is
    // there but unusable. Treat it as corrupt, not as an empty first run.
    if (!warned) {
      warned = true;
      console.warn(`Could not read ${path}, treating auth state as empty: not a JSON object`);
    }
    lastReadCorrupt = true;
    return {};
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(`Could not read ${path}, treating auth state as empty: ${error.message}`);
    }
    lastReadCorrupt = true;
    return {};
  }
}

// Whether the most recent *fresh* read hit a present-but-unparseable file.
// Reflects `readFresh`, not the 5s `readAuthFile` cache — the startup path reads
// fresh once before consulting this.
export function authFileCorrupt() {
  return lastReadCorrupt;
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
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup — nothing more we can do
    }
    throw error;
  }
  cache = { value: next, at: Date.now() };
}
