import { beforeEach, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, pollBackupTask } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  pollBackupTask: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ pollBackupTask }));

import handler from "pages/api/proxmox/backups/status";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 400 for an invalid upid", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: { node: "proxmox", upid: "not-a-upid" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
});

it("returns the task status on success", async () => {
  pollBackupTask.mockResolvedValue({ status: "stopped", exitstatus: "OK" });
  const res = createMockRes();

  await handler(
    { method: "GET", query: { node: "proxmox", upid: "UPID:proxmox:00001234:00005678:6501234A:vzdump:100::" } },
    res,
  );

  expect(pollBackupTask).toHaveBeenCalledWith(
    pveConfig,
    "proxmox",
    "UPID:proxmox:00001234:00005678:6501234A:vzdump:100::",
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ status: "stopped", exitstatus: "OK" });
});

it("returns the task status for a realistic UPID with an auth-id segment", async () => {
  pollBackupTask.mockResolvedValue({ status: "stopped", exitstatus: "OK" });
  const res = createMockRes();
  const upid = "UPID:proxmox:00001234:00005678:6501234A:vzdump:100:root@pam!ysb:";

  await handler({ method: "GET", query: { node: "proxmox", upid } }, res);

  expect(pollBackupTask).toHaveBeenCalledWith(pveConfig, "proxmox", upid);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ status: "stopped", exitstatus: "OK" });
});
