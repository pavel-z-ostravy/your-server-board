import { beforeEach, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, listBackupStorages } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  listBackupStorages: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ listBackupStorages }));

import handler from "pages/api/proxmox/backups/storages";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 405 for non-GET methods", async () => {
  const req = { method: "POST", query: {} };
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for a missing node parameter", async () => {
  const req = { method: "GET", query: {} };
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(400);
});

it("returns 500 when Proxmox config is missing", async () => {
  getPveConfig.mockReturnValue(null);
  const req = { method: "GET", query: { node: "proxmox" } };
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
});

it("returns the storage list on success", async () => {
  listBackupStorages.mockResolvedValue([{ storage: "local", prunePolicy: "keep-last=3" }]);
  const req = { method: "GET", query: { node: "proxmox" } };
  const res = createMockRes();

  await handler(req, res);

  expect(listBackupStorages).toHaveBeenCalledWith(pveConfig, "proxmox");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ storages: [{ storage: "local", prunePolicy: "keep-last=3" }] });
});

it("returns 500 when listBackupStorages throws", async () => {
  listBackupStorages.mockRejectedValue(new Error("boom"));
  const req = { method: "GET", query: { node: "proxmox" } };
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
});
