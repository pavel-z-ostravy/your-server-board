import { describe, expect, it } from "vitest";

import { parsePveVersion } from "./nodeStatus";

describe("parsePveVersion", () => {
  it("extracts the version segment from a real pve-manager string", () => {
    expect(parsePveVersion("pve-manager/9.2.9/aa93fdab516e230b")).toBe("9.2.9");
  });

  it("extracts the version segment from an older-format string", () => {
    expect(parsePveVersion("pve-manager/8.2.4/somehash")).toBe("8.2.4");
  });

  it("returns the raw string unchanged when it doesn't match the expected shape", () => {
    expect(parsePveVersion("not-a-pve-version-string")).toBe("not-a-pve-version-string");
  });

  it("returns null for non-string input", () => {
    expect(parsePveVersion(null)).toBeNull();
    expect(parsePveVersion(undefined)).toBeNull();
  });
});
