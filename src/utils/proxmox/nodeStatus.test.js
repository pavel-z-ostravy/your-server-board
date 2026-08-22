import { describe, expect, it } from "vitest";

import { parsePveVersion, pickPrimaryIpAddress } from "./nodeStatus";

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

describe("pickPrimaryIpAddress", () => {
  it("picks the first interface with an inet family and a populated address", () => {
    // Shape verified against a live Proxmox 9.2 host's GET /nodes/{node}/network
    // response: physical NICs have no address of their own; the bridge configured
    // on top of them carries the actual IP.
    const interfaces = [
      { iface: "nic0", type: "eth", families: ["inet"] },
      { iface: "vmbr0", type: "bridge", families: ["inet"], address: "10.0.0.9" },
    ];
    expect(pickPrimaryIpAddress(interfaces)).toBe("10.0.0.9");
  });

  it("returns null when no interface has both an inet family and an address", () => {
    const interfaces = [
      { iface: "nic0", families: ["inet"] },
      { iface: "lo", families: ["inet6"] },
    ];
    expect(pickPrimaryIpAddress(interfaces)).toBeNull();
  });

  it("returns null for a non-array input", () => {
    expect(pickPrimaryIpAddress(null)).toBeNull();
    expect(pickPrimaryIpAddress(undefined)).toBeNull();
  });
});
