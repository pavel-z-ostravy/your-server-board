import { describe, expect, it } from "vitest";

import { computeDiskCapacity } from "./capacity";

describe("computeDiskCapacity", () => {
  it("aggregates a simple disk with one directly-mounted filesystem and no LVM", () => {
    const disk = {
      name: "sdc",
      type: "disk",
      mountpoint: null,
      children: [{ name: "sdc_crypt", type: "crypt", mountpoint: "/mnt/storage" }],
    };
    const dfRows = [
      { source: "/dev/mapper/sdc_crypt", target: "/mnt/storage", fstype: "ext4", usedBytes: 400000000000, sizeBytes: 2000000000000 },
      // Unrelated mountpoint on a different disk — must be ignored.
      { source: "/dev/sda2", target: "/boot/efi", fstype: "vfat", usedBytes: 10000000, sizeBytes: 1000000000 },
    ];

    const result = computeDiskCapacity(disk, { dfRows, lvsRows: [], pvsRows: [] });

    expect(result).toEqual({ usedBytes: 400000000000, totalBytes: 2000000000000 });
  });

  it("aggregates an LVM disk by combining df on its direct mounts with its thin pool's data_percent", () => {
    const disk = {
      name: "sda",
      type: "disk",
      mountpoint: null,
      children: [
        { name: "sda1", type: "part", mountpoint: null },
        { name: "sda2", type: "part", mountpoint: "/boot/efi" },
        {
          name: "sda3",
          type: "part",
          mountpoint: null,
          children: [
            { name: "pve-root", type: "lvm", mountpoint: "/" },
            { name: "pve-swap", type: "lvm", mountpoint: "[SWAP]" },
          ],
        },
      ],
    };
    const dfRows = [
      { source: "/dev/sda2", target: "/boot/efi", fstype: "vfat", usedBytes: 10000000, sizeBytes: 1000000000 },
      { source: "/dev/mapper/pve-root", target: "/", fstype: "ext4", usedBytes: 25000000000, sizeBytes: 90000000000 },
      // Unrelated mountpoint on a different disk — must be ignored.
      { source: "/dev/mapper/sdc_crypt", target: "/mnt/storage", fstype: "ext4", usedBytes: 1, sizeBytes: 2 },
    ];
    const pvsRows = [{ pvName: "/dev/sda3", vgName: "pve" }];
    const lvsRows = [
      { lvName: "data", vgName: "pve", lvAttr: "twi-aotz--", dataPercent: 50, lvSizeBytes: 100000000000 },
      // Non-pool LVs in the same VG must NOT be added on top of the pool figure.
      { lvName: "root", vgName: "pve", lvAttr: "-wi-ao----", dataPercent: null, lvSizeBytes: 90000000000 },
      { lvName: "swap", vgName: "pve", lvAttr: "-wi-ao----", dataPercent: null, lvSizeBytes: 8000000000 },
      // A thin pool in an unrelated VG must be ignored.
      { lvName: "otherdata", vgName: "othervg", lvAttr: "twi-aotz--", dataPercent: 90, lvSizeBytes: 500000000000 },
    ];

    const result = computeDiskCapacity(disk, { dfRows, lvsRows, pvsRows });

    // dfUsed = 10_000_000 + 25_000_000_000 = 25_010_000_000
    // dfSize = 1_000_000_000 + 90_000_000_000 = 91_000_000_000
    // thinUsed = 50% of 100_000_000_000 = 50_000_000_000
    // thinSize = 100_000_000_000
    expect(result).toEqual({ usedBytes: 75010000000, totalBytes: 191000000000 });
  });

  it("excludes [SWAP] mountpoints from the aggregation even if df somehow reported one", () => {
    const disk = {
      name: "sda",
      type: "disk",
      mountpoint: null,
      children: [{ name: "sda1", type: "lvm", mountpoint: "[SWAP]" }],
    };
    const dfRows = [{ source: "/dev/mapper/pve-swap", target: "[SWAP]", fstype: "swap", usedBytes: 999, sizeBytes: 999 }];

    const result = computeDiskCapacity(disk, { dfRows, lvsRows: [], pvsRows: [] });

    expect(result).toBeNull();
  });

  it("returns null when the disk has no mounted filesystem and no LVM", () => {
    const disk = { name: "sdz", type: "disk", mountpoint: null, children: [] };

    const result = computeDiskCapacity(disk, { dfRows: [], lvsRows: [], pvsRows: [] });

    expect(result).toBeNull();
  });

  it("returns null when the disk has children but none of them are mounted or LVM PVs", () => {
    const disk = {
      name: "sdz",
      type: "disk",
      mountpoint: null,
      children: [{ name: "sdz1", type: "part", mountpoint: null }],
    };

    const result = computeDiskCapacity(disk, { dfRows: [], lvsRows: [], pvsRows: [] });

    expect(result).toBeNull();
  });
});
