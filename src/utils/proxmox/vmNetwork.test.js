import { describe, expect, it } from "vitest";

import { extractMacFromLxcNet0, extractMacFromQemuNet0, findIPv4ByMac } from "./vmNetwork";

describe("extractMacFromQemuNet0", () => {
  it("extracts the MAC from a real QEMU net0 string (virtio model)", () => {
    expect(extractMacFromQemuNet0("virtio=BC:24:11:85:3A:8F,bridge=vmbr0")).toBe("BC:24:11:85:3A:8F");
  });

  it("extracts the MAC regardless of NIC model key name", () => {
    expect(extractMacFromQemuNet0("e1000=AA:BB:CC:DD:EE:FF,bridge=vmbr1,firewall=1")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("returns null for a falsy net0", () => {
    expect(extractMacFromQemuNet0(undefined)).toBeNull();
    expect(extractMacFromQemuNet0(null)).toBeNull();
    expect(extractMacFromQemuNet0("")).toBeNull();
  });

  it("returns null when no MAC-shaped value is present", () => {
    expect(extractMacFromQemuNet0("bridge=vmbr0,firewall=1")).toBeNull();
  });
});

describe("extractMacFromLxcNet0", () => {
  it("extracts the MAC from a real LXC net0 string (hwaddr not first)", () => {
    expect(
      extractMacFromLxcNet0("name=eth0,bridge=vmbr0,firewall=1,hwaddr=BC:24:11:AE:7C:89,ip=dhcp,type=veth"),
    ).toBe("BC:24:11:AE:7C:89");
  });

  it("returns null for a falsy net0", () => {
    expect(extractMacFromLxcNet0(undefined)).toBeNull();
  });

  it("returns null when no hwaddr key is present", () => {
    expect(extractMacFromLxcNet0("name=eth0,bridge=vmbr0,ip=dhcp,type=veth")).toBeNull();
  });
});

describe("findIPv4ByMac", () => {
  // Trimmed real shape from GET /nodes/proxmox/lxc/200/interfaces — a
  // container running Docker has many veth/br-* interfaces; only the one
  // matching net0's hwaddr is the container's actual LAN address.
  const lxcInterfaces = [
    {
      name: "lo",
      hwaddr: "00:00:00:00:00:00",
      "hardware-address": "00:00:00:00:00:00",
      inet: "127.0.0.1/8",
      "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "inet", prefix: "8" }],
    },
    {
      name: "eth0",
      hwaddr: "bc:24:11:ae:7c:89",
      "hardware-address": "bc:24:11:ae:7c:89",
      inet: "10.0.1.104/24",
      "ip-addresses": [
        { "ip-address": "10.0.1.104", "ip-address-type": "inet", prefix: "24" },
        { "ip-address": "fe80::be24:11ff:feae:7c89", "ip-address-type": "inet6", prefix: "64" },
      ],
    },
    {
      name: "docker0",
      hwaddr: "9e:1e:12:99:72:43",
      "hardware-address": "9e:1e:12:99:72:43",
      "ip-addresses": [{ "ip-address": "172.17.0.1", "ip-address-type": "inet", prefix: "16" }],
    },
  ];

  it("finds the LXC IPv4 by case-insensitive MAC match against the config's uppercase hwaddr", () => {
    expect(findIPv4ByMac(lxcInterfaces, "BC:24:11:AE:7C:89", "inet")).toBe("10.0.1.104");
  });

  it("returns null when no interface matches the MAC", () => {
    expect(findIPv4ByMac(lxcInterfaces, "00:00:00:00:00:99", "inet")).toBeNull();
  });

  it("returns null when mac is null", () => {
    expect(findIPv4ByMac(lxcInterfaces, null, "inet")).toBeNull();
  });

  // Trimmed real shape from GET /nodes/proxmox/qemu/100/agent/network-get-interfaces
  // — verified different from the LXC shape: no "hwaddr" alias, and
  // "ip-address-type" uses "ipv4"/"ipv6", not "inet"/"inet6".
  const qemuAgentInterfaces = [
    {
      name: "lo",
      "hardware-address": "00:00:00:00:00:00",
      "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4", prefix: 8 }],
    },
    {
      name: "enp0s18",
      "hardware-address": "bc:24:11:85:3a:8f",
      "ip-addresses": [
        { "ip-address": "10.0.1.22", "ip-address-type": "ipv4", prefix: 24 },
        { "ip-address": "fe80::b8e5:9835:5708:de6a", "ip-address-type": "ipv6", prefix: 64 },
      ],
    },
  ];

  it("finds the QEMU IPv4 via the agent's different type-string ('ipv4', not 'inet')", () => {
    expect(findIPv4ByMac(qemuAgentInterfaces, "BC:24:11:85:3A:8F", "ipv4")).toBe("10.0.1.22");
  });

  it("returns null when interfaces is empty or undefined", () => {
    expect(findIPv4ByMac([], "BC:24:11:85:3A:8F", "ipv4")).toBeNull();
    expect(findIPv4ByMac(undefined, "BC:24:11:85:3A:8F", "ipv4")).toBeNull();
  });
});
