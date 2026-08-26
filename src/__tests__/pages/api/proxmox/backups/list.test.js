import { beforeEach, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, listBackupsForVm } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  listBackupsForVm: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ listBackupsForVm }));

import handler from "pages/api/proxmox/backups/list";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 405 for non-GET methods", async () => {
  const res = createMockRes();
  await handler({ method: "DELETE", query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for an invalid vmid", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: { node: "proxmox", vmid: "abc" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
});

it("returns the backup list on success", async () => {
  listBackupsForVm.mockResolvedValue([
    { volid: "local:backup/x", size: 1, ctime: 1, notes: null, storage: "local", prunePolicy: null },
  ]);
  const res = createMockRes();

  await handler({ method: "GET", query: { node: "proxmox", vmid: "100" } }, res);

  expect(listBackupsForVm).toHaveBeenCalledWith(pveConfig, "proxmox", "100");
  expect(res.status).toHaveBeenCalledWith(200);
});

it("returns 500 when listBackupsForVm throws", async () => {
  listBackupsForVm.mockRejectedValue(new Error("boom"));
  const res = createMockRes();
  await handler({ method: "GET", query: { node: "proxmox", vmid: "100" } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});
