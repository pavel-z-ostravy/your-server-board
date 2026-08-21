import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import yaml from "js-yaml";

import { CONF_DIR } from "utils/config/config";
import { KNOWN_SECTION_IDS, mergeLayoutOrder } from "utils/config/layoutOrder";

const LAYOUT_ORDER_FILE = "layout-order.yaml";

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
  const merged = mergeLayoutOrder(order, KNOWN_SECTION_IDS);
  mkdirSync(CONF_DIR, { recursive: true });
  writeFileSync(layoutOrderPath(), yaml.dump({ order: merged }, { lineWidth: -1, noRefs: true }), "utf8");
  return merged;
}
