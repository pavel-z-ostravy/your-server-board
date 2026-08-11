import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, listBlockDevices, getSmartData, logger } = vi.hoisted(() => ({
  getSmartConfig: vi.fn(),
  listBlockDevices: vi.fn(),
  getSmartData: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/config/proxmox", () => ({
  getSmartConfig,
}));

vi.mock("utils/ssh/smartClient", () => ({
  listBlockDevices,
  getSmartData,
}));

vi.mock("utils/logger", () => ({
  default: () => logger,
}));

import handler from "pages/api/disks/index";

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "./config/ssh/id_smart" };

const ataSmart = {
  device: { protocol: "ATA" },
  smart_status: { passed: true },
  temperature: { current: 40 },
  ata_smart_attributes: { table: [{ id: 5, raw: { value: 0 } }] },
};

describe("pages/api/disks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 500 when smart config is missing", async () => {
    getSmartConfig.mockReturnValue(null);

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "SMART SSH configuration not found" });
    expect(listBlockDevices).not.toHaveBeenCalled();
  });

  it("filters lsblk output to physical disks only and returns composed health data", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    listBlockDevices.mockResolvedValue({
      blockdevices: [
        { name: "loop0", size: "20G", type: "loop", model: null },
        // type === "disk" but not a name the SMART client can query (a ZFS zvol,
        // common on Proxmox) — must be silently excluded, not queried or errored.
        { name: "zd0", size: "8G", type: "disk", model: null },
        {
          name: "sda",
          size: "238.5G",
          type: "disk",
          model: "MTFDDAK256TBN-1AR1ZABHA",
          children: [{ name: "sda1", size: "1G", type: "part" }],
        },
      ],
    });
    getSmartData.mockResolvedValue(ataSmart);

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(getSmartData).toHaveBeenCalledTimes(1);
    expect(getSmartData).toHaveBeenCalledWith(sshConfig, "/dev/sda");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      {
        name: "sda",
        device: "/dev/sda",
        model: "MTFDDAK256TBN-1AR1ZABHA",
        size: "238.5G",
        protocol: "ATA",
        temperature: 40,
        smartPassed: true,
        reallocatedSectors: 0,
        wearPercentage: null,
        mediaErrors: null,
        status: "ok",
        error: null,
      },
    ]);
  });

  it("returns a per-disk error without failing the whole response when one disk's SMART query fails", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    listBlockDevices.mockResolvedValue({
      blockdevices: [
        { name: "sda", size: "238.5G", type: "disk", model: "A" },
        { name: "sdb", size: "1T", type: "disk", model: "B" },
      ],
    });
    getSmartData.mockImplementation(async (_config, device) => {
      if (device === "/dev/sdb") throw new Error("boom");
      return ataSmart;
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ name: "sda", status: "ok", error: null });
    expect(res.body[1]).toMatchObject({
      name: "sdb",
      device: "/dev/sdb",
      size: "1T",
      status: null,
      error: "SMART query failed",
    });
    // The raw rejection reason must never reach the (potentially unauthenticated) HTTP response.
    expect(JSON.stringify(res.body)).not.toContain("boom");
    expect(logger.error).toHaveBeenCalledWith("SMART query failed for %s:", "/dev/sdb", expect.any(Error));
  });

  it("returns 500 when listBlockDevices itself fails", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    listBlockDevices.mockRejectedValue(new Error("ssh unreachable"));

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(logger.error).toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to enumerate block devices" });
  });
});
