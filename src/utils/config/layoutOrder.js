import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import yaml from "js-yaml";

import { CONF_DIR } from "utils/config/config";

// The five draggable dashboard sections, in their current hardcoded render
// order (src/pages/index.jsx before this feature). This doubles as the
// default order the first time anyone drags anything, and the order
// restored for any known id a saved file doesn't mention (mergeLayoutOrder).
export const KNOWN_SECTION_IDS = ["layout-groups", "services", "bookmarks", "proxmox-vms", "disks"];

const LAYOUT_ORDER_FILE = "layout-order.yaml";

// Pure merge: keep ids from savedOrder that are still known, in their saved
// relative order, deduped; append any known id savedOrder didn't mention (a
// newly-added section type) at the end, in knownIds' own relative order.
// Always returns every id in knownIds exactly once.
export function mergeLayoutOrder(savedOrder, knownIds = KNOWN_SECTION_IDS) {
  const known = new Set(knownIds);
  const seen = new Set();
  const kept = (Array.isArray(savedOrder) ? savedOrder : []).filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const missing = knownIds.filter((id) => !seen.has(id));
  return [...kept, ...missing];
}

// True when value is a non-empty array of strings, each a known section id,
// with no duplicates. Doesn't require every known id to be present - a
// stale/partial client-sent set is still valid; the server merges the rest.
export function isValidSectionOrder(value, knownIds = KNOWN_SECTION_IDS) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const known = new Set(knownIds);
  const seen = new Set();
  return value.every((id) => {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Pure reorder: move the section with id activeId to sit where overId
// currently is. Returns `order` unchanged (same reference) if either id
// isn't present or they're equal - callers get a safe no-op instead of a
// thrown error for a stale/no-op drag event.
export function reorderSectionIds(order, activeId, overId) {
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return order;

  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function layoutOrderPath() {
  return join(CONF_DIR, LAYOUT_ORDER_FILE);
}

// Reads config/layout-order.yaml and returns a fully-merged order (every
// known id present exactly once). Missing file, empty file, or malformed
// YAML all fall back to the default order - unlike settings.yaml this file
// is optional, so there's no skeleton-copy step and no fatal path.
export function getLayoutOrder() {
  const path = layoutOrderPath();
  if (!existsSync(path)) return mergeLayoutOrder([]);

  try {
    const parsed = yaml.load(readFileSync(path, "utf8"));
    return mergeLayoutOrder(parsed?.order);
  } catch {
    return mergeLayoutOrder([]);
  }
}

// Merges `order` against known ids and persists the result. Returns the
// merged order that was written.
export function writeLayoutOrder(order) {
  const merged = mergeLayoutOrder(order);
  mkdirSync(CONF_DIR, { recursive: true });
  writeFileSync(layoutOrderPath(), yaml.dump({ order: merged }, { lineWidth: -1, noRefs: true }), "utf8");
  return merged;
}
