import { describe, expect, it } from "vitest";

import { formatUptime } from "./uptime";

describe("formatUptime", () => {
  it("formats seconds under a minute", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats zero as 0m", () => {
    expect(formatUptime(0)).toBe("0m");
  });

  it("formats minutes", () => {
    expect(formatUptime(125)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(3661)).toBe("1h 1m");
  });

  it("formats days and hours — real VM 100 uptime", () => {
    // 92576s = 1 day (86400s) + 6176s remainder = 1h 42m 56s
    expect(formatUptime(92576)).toBe("1d 1h");
  });

  it("formats days and hours — real LXC 200 uptime", () => {
    // 135548s = 1 day (86400s) + 49148s remainder = 13h 39m 8s
    expect(formatUptime(135548)).toBe("1d 13h");
  });

  it("formats days and hours — real LXC 202 uptime (9+ days)", () => {
    // 862972s = 9 days (777600s) + 85372s remainder = 23h 42m 52s
    expect(formatUptime(862972)).toBe("9d 23h");
  });
});
