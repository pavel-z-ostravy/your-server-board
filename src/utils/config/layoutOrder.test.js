import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("utils/config/config", () => ({ CONF_DIR: "/config" }));

import {
  KNOWN_SECTION_IDS,
  getLayoutOrder,
  isValidSectionOrder,
  mergeLayoutOrder,
  reorderSectionIds,
  writeLayoutOrder,
} from "./layoutOrder";

describe("mergeLayoutOrder", () => {
  it("returns the default order unchanged when nothing is saved", () => {
    expect(mergeLayoutOrder([])).toEqual(KNOWN_SECTION_IDS);
    expect(mergeLayoutOrder(undefined)).toEqual(KNOWN_SECTION_IDS);
  });

  it("preserves a saved order of known ids", () => {
    const saved = ["disks", "layout-groups", "services", "bookmarks", "proxmox-vms"];
    expect(mergeLayoutOrder(saved)).toEqual(saved);
  });

  it("drops stale ids no longer known", () => {
    const saved = ["disks", "old-widget", "services"];
    expect(mergeLayoutOrder(saved, ["disks", "services", "bookmarks"])).toEqual(["disks", "services", "bookmarks"]);
  });

  it("appends newly-known ids not mentioned in the saved order, at the end", () => {
    const saved = ["disks", "services"];
    expect(mergeLayoutOrder(saved, ["disks", "services", "bookmarks", "new-widget"])).toEqual([
      "disks",
      "services",
      "bookmarks",
      "new-widget",
    ]);
  });

  it("dedupes a saved order containing a repeated id", () => {
    const saved = ["disks", "disks", "services"];
    expect(mergeLayoutOrder(saved, ["disks", "services", "bookmarks"])).toEqual(["disks", "services", "bookmarks"]);
  });
});

describe("isValidSectionOrder", () => {
  it("accepts a full permutation of known ids", () => {
    expect(isValidSectionOrder([...KNOWN_SECTION_IDS].reverse())).toBe(true);
  });

  it("accepts a partial subset of known ids (server merges the rest)", () => {
    expect(isValidSectionOrder(["disks", "services"])).toBe(true);
  });

  it("rejects an unknown id", () => {
    expect(isValidSectionOrder(["disks", "not-a-real-section"])).toBe(false);
  });

  it("rejects duplicates", () => {
    expect(isValidSectionOrder(["disks", "disks"])).toBe(false);
  });

  it("rejects non-arrays and empty arrays", () => {
    expect(isValidSectionOrder(null)).toBe(false);
    expect(isValidSectionOrder("disks")).toBe(false);
    expect(isValidSectionOrder([])).toBe(false);
  });
});

describe("reorderSectionIds", () => {
  it("moves the active id to sit where the over id is", () => {
    expect(reorderSectionIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderSectionIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns the same array reference, unchanged, for an unknown id", () => {
    const order = ["a", "b", "c"];
    expect(reorderSectionIds(order, "a", "missing")).toBe(order);
    expect(reorderSectionIds(order, "missing", "a")).toBe(order);
  });

  it("returns the same array reference, unchanged, when active and over are equal", () => {
    const order = ["a", "b", "c"];
    expect(reorderSectionIds(order, "b", "b")).toBe(order);
  });
});

describe("getLayoutOrder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the default order when the file doesn't exist", () => {
    existsSync.mockReturnValue(false);
    expect(getLayoutOrder()).toEqual(KNOWN_SECTION_IDS);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("returns a merged order from a valid saved file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("order:\n  - disks\n  - services\n");
    expect(getLayoutOrder()).toEqual(mergeLayoutOrder(["disks", "services"]));
  });

  it("falls back to the default order on malformed YAML", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("order:\n\t- disks\n"); // tab indentation is invalid YAML
    expect(getLayoutOrder()).toEqual(KNOWN_SECTION_IDS);
  });
});

describe("writeLayoutOrder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges and writes the order as YAML, returning the merged order", () => {
    const result = writeLayoutOrder(["disks", "services"]);

    expect(result).toEqual(mergeLayoutOrder(["disks", "services"]));
    expect(mkdirSync).toHaveBeenCalledWith("/config", { recursive: true });
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [path, contents] = writeFileSync.mock.calls[0];
    expect(path).toBe("/config/layout-order.yaml");
    expect(contents).toContain("disks");
  });
});
