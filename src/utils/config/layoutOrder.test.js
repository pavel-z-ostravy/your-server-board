import { describe, expect, it } from "vitest";

import { KNOWN_SECTION_IDS, isValidSectionOrder, mergeLayoutOrder, reorderSectionIds } from "./layoutOrder";

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
