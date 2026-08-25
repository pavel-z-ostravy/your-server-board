import { beforeEach, describe, expect, it, vi } from "vitest";

const { httpProxy, logger } = vi.hoisted(() => ({
  httpProxy: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/proxy/http", () => ({ httpProxy }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import { deleteBackup, listBackupsForVm, listBackupStorages, pollBackupTask, startBackup } from "./backups";

const pveConfig = { url: "https://10.0.0.9:8006", token: "root@pam!ysb", secret: "s3cr3t" };

function jsonResponse(status, body) {
  return [status, {}, Buffer.from(JSON.stringify(body))];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listBackupStorages", () => {
  it("returns only storages with backup content, tagged with their prune policy", async () => {
    httpProxy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { storage: "local", content: "iso,vztmpl,backup", "prune-backups": "keep-last=3" },
          { storage: "images-only", content: "images" },
          { storage: "nas-backup", content: "backup" },
        ],
      }),
    );

    const result = await listBackupStorages(pveConfig, "proxmox");

    expect(result).toEqual([
      { storage: "local", prunePolicy: "keep-last=3" },
      { storage: "nas-backup", prunePolicy: null },
    ]);
    expect(httpProxy).toHaveBeenCalledWith(
      "https://10.0.0.9:8006/api2/json/nodes/proxmox/storage",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws when the Proxmox API returns a non-200 status", async () => {
    httpProxy.mockResolvedValueOnce([500, {}, Buffer.from("")]);

    await expect(listBackupStorages(pveConfig, "proxmox")).rejects.toThrow("Proxmox API returned 500");
  });
});

describe("listBackupsForVm", () => {
  it("filters backups to the given vmid across every backup-enabled storage", async () => {
    httpProxy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            { storage: "local", content: "backup", "prune-backups": "keep-last=3" },
            { storage: "nas", content: "backup" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
              size: 123,
              ctime: 1,
              notes: null,
              vmid: 100,
            },
            {
              volid: "local:backup/vzdump-qemu-200-2026_08_24-10_00_00.vma.zst",
              size: 456,
              ctime: 2,
              notes: null,
              vmid: 200,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              volid: "nas:backup/vzdump-qemu-100-2026_08_23-10_00_00.vma.zst",
              size: 789,
              ctime: 3,
              notes: "manual",
              vmid: 100,
            },
          ],
        }),
      );

    const result = await listBackupsForVm(pveConfig, "proxmox", "100");

    expect(result).toEqual([
      {
        volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
        size: 123,
        ctime: 1,
        notes: null,
        storage: "local",
        prunePolicy: "keep-last=3",
      },
      {
        volid: "nas:backup/vzdump-qemu-100-2026_08_23-10_00_00.vma.zst",
        size: 789,
        ctime: 3,
        notes: "manual",
        storage: "nas",
        prunePolicy: null,
      },
    ]);
  });

  it("skips a storage whose content listing fails without failing the whole call", async () => {
    httpProxy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            { storage: "local", content: "backup" },
            { storage: "broken", content: "backup" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
              size: 1,
              ctime: 1,
              notes: null,
              vmid: 100,
            },
          ],
        }),
      )
      .mockResolvedValueOnce([500, {}, Buffer.from("")]);

    const result = await listBackupsForVm(pveConfig, "proxmox", "100");

    expect(result).toEqual([
      {
        volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
        size: 1,
        ctime: 1,
        notes: null,
        storage: "local",
        prunePolicy: null,
      },
    ]);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("startBackup", () => {
  it("POSTs vzdump params and returns the UPID", async () => {
    httpProxy.mockResolvedValueOnce(
      jsonResponse(200, { data: "UPID:proxmox:00001234:00005678:6501234A:vzdump:100:root@pam!ysb:" }),
    );

    const result = await startBackup(pveConfig, "proxmox", "100", "local");

    expect(result).toEqual({ upid: "UPID:proxmox:00001234:00005678:6501234A:vzdump:100:root@pam!ysb:" });
    expect(httpProxy).toHaveBeenCalledWith(
      "https://10.0.0.9:8006/api2/json/nodes/proxmox/vzdump",
      expect.objectContaining({
        method: "POST",
        body: "vmid=100&storage=local&mode=snapshot&compress=zstd",
      }),
    );
  });

  it("throws when the Proxmox API returns a non-200 status", async () => {
    httpProxy.mockResolvedValueOnce([500, {}, Buffer.from("")]);

    await expect(startBackup(pveConfig, "proxmox", "100", "local")).rejects.toThrow("Proxmox API returned 500");
  });
});

describe("pollBackupTask", () => {
  it("returns status and exitstatus", async () => {
    httpProxy.mockResolvedValueOnce(jsonResponse(200, { data: { status: "stopped", exitstatus: "OK" } }));

    const result = await pollBackupTask(pveConfig, "proxmox", "UPID:proxmox:00001234:00005678:6501234A:vzdump:100::");

    expect(result).toEqual({ status: "stopped", exitstatus: "OK" });
  });

  it("defaults exitstatus to null while a task is still running", async () => {
    httpProxy.mockResolvedValueOnce(jsonResponse(200, { data: { status: "running" } }));

    const result = await pollBackupTask(pveConfig, "proxmox", "UPID:proxmox:00001234:00005678:6501234A:vzdump:100::");

    expect(result).toEqual({ status: "running", exitstatus: null });
  });
});

describe("deleteBackup", () => {
  it("DELETEs the content path, deriving storage from the volid's prefix", async () => {
    httpProxy.mockResolvedValueOnce(jsonResponse(200, { data: null }));

    await deleteBackup(pveConfig, "proxmox", "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst");

    expect(httpProxy).toHaveBeenCalledWith(
      "https://10.0.0.9:8006/api2/json/nodes/proxmox/storage/local/content/local%3Abackup%2Fvzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("throws when the Proxmox API returns a non-200 status", async () => {
    httpProxy.mockResolvedValueOnce([500, {}, Buffer.from("")]);

    await expect(
      deleteBackup(pveConfig, "proxmox", "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst"),
    ).rejects.toThrow("Proxmox API returned 500");
  });
});
