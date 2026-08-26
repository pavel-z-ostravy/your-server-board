import { beforeEach, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, startBackup } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  startBackup: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ startBackup }));

import handler from "pages/api/proxmox/backups/run";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 405 for non-POST methods", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: {}, body: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for an invalid storage parameter", async () => {
  const res = createMockRes();
  await handler({ method: "POST", body: { node: "proxmox", vmid: "100", storage: "bad storage!" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
});

it("starts a backup and returns the upid", async () => {
  startBackup.mockResolvedValue({ upid: "UPID:proxmox:...:" });
  const res = createMockRes();

  await handler({ method: "POST", body: { node: "proxmox", vmid: "100", storage: "local" } }, res);

  expect(startBackup).toHaveBeenCalledWith(pveConfig, "proxmox", "100", "local");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ upid: "UPID:proxmox:...:" });
});

it("returns 500 when startBackup throws", async () => {
  startBackup.mockRejectedValue(new Error("boom"));
  const res = createMockRes();
  await handler({ method: "POST", body: { node: "proxmox", vmid: "100", storage: "local" } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});
