import { beforeEach, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, deleteBackup } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  deleteBackup: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ deleteBackup }));

import handler from "pages/api/proxmox/backups/delete";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };
const VALID_VOLID = "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst";

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 405 for non-DELETE methods", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for a volid that doesn't match the expected shape", async () => {
  const res = createMockRes();
  await handler({ method: "DELETE", query: { node: "proxmox", volid: "not-a-volid" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(deleteBackup).not.toHaveBeenCalled();
});

it("deletes the backup and returns success", async () => {
  deleteBackup.mockResolvedValue(undefined);
  const res = createMockRes();

  await handler({ method: "DELETE", query: { node: "proxmox", volid: VALID_VOLID } }, res);

  expect(deleteBackup).toHaveBeenCalledWith(pveConfig, "proxmox", VALID_VOLID);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ success: true });
});

it("returns 500 when deleteBackup throws", async () => {
  deleteBackup.mockRejectedValue(new Error("boom"));
  const res = createMockRes();
  await handler({ method: "DELETE", query: { node: "proxmox", volid: VALID_VOLID } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});
