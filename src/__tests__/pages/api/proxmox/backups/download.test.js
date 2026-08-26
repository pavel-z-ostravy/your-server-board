import { EventEmitter } from "node:events";

import { beforeEach, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, streamBackupFile } = vi.hoisted(() => ({
  getSmartConfig: vi.fn(),
  streamBackupFile: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getSmartConfig }));
vi.mock("utils/ssh/backupClient", () => ({ streamBackupFile }));

import handler from "pages/api/proxmox/backups/download";

const sshConfig = { host: "proxmox.local", username: "root", privateKeyPath: "/fake/key" };
const VALID_VOLID = "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst";

function createMockStreamingRes() {
  const res = createMockRes();
  res.pipe = vi.fn();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSmartConfig.mockReturnValue(sshConfig);
});

it("returns 405 for non-GET methods", async () => {
  const res = createMockStreamingRes();
  await handler({ method: "POST", query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for a volid that doesn't match the expected shape", async () => {
  const res = createMockStreamingRes();
  await handler({ method: "GET", query: { volid: "not-a-volid" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(streamBackupFile).not.toHaveBeenCalled();
});

it("returns 500 when SMART SSH configuration is missing", async () => {
  getSmartConfig.mockReturnValue(null);
  const res = createMockStreamingRes();
  await handler({ method: "GET", query: { volid: VALID_VOLID } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});

it("sets download headers and pipes the stream on success", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  const fakeConn = { end: vi.fn() };
  streamBackupFile.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = { method: "GET", query: { volid: VALID_VOLID }, on: vi.fn() };
  const res = createMockStreamingRes();

  await handler(req, res);

  expect(streamBackupFile).toHaveBeenCalledWith(sshConfig, VALID_VOLID);
  expect(res.setHeader).toHaveBeenCalledWith(
    "Content-Disposition",
    'attachment; filename="vzdump-qemu-100-2026_08_24-10_00_00.vma.zst"',
  );
  expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/octet-stream");
  expect(fakeStream.pipe).toHaveBeenCalledWith(res);
});

it("returns 500 when opening the SSH stream fails", async () => {
  streamBackupFile.mockRejectedValue(new Error("connection refused"));
  const req = { method: "GET", query: { volid: VALID_VOLID }, on: vi.fn() };
  const res = createMockStreamingRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
});
