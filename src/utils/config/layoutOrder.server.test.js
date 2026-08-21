import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("utils/config/config", () => ({ CONF_DIR: "/config" }));

import { KNOWN_SECTION_IDS, mergeLayoutOrder } from "./layoutOrder";
import { getLayoutOrder, writeLayoutOrder } from "./layoutOrder.server";

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
