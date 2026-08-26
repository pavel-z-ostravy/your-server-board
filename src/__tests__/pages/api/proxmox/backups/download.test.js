import { EventEmitter } from "node:events";

import { beforeEach, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, streamBackupFile, logger } = vi.hoisted(() => ({
  getSmartConfig: vi.fn(),
  streamBackupFile: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/config/proxmox", () => ({ getSmartConfig }));
vi.mock("utils/ssh/backupClient", () => ({ streamBackupFile }));
vi.mock("utils/logger", () => ({
  default: () => logger,
}));

import handler from "pages/api/proxmox/backups/download";

const sshConfig = { host: "proxmox.local", username: "root", privateKeyPath: "/fake/key" };
const VALID_VOLID = "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst";

function createFakeReq(overrides = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method: "GET", query: { volid: VALID_VOLID } }, overrides);
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSmartConfig.mockReturnValue(sshConfig);
});

it("returns 405 for non-GET methods", async () => {
  const res = createMockRes();
  await handler({ method: "POST", query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for a volid that doesn't match the expected shape", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: { volid: "not-a-volid" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(streamBackupFile).not.toHaveBeenCalled();
});

it("returns 500 when SMART SSH configuration is missing", async () => {
  getSmartConfig.mockReturnValue(null);
  const res = createMockRes();
  await handler({ method: "GET", query: { volid: VALID_VOLID } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});

it("sets download headers and pipes the stream on success", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  fakeStream.stderr = new EventEmitter();
  const fakeConn = { end: vi.fn() };
  streamBackupFile.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

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
  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
  expect(logger.error).toHaveBeenCalled();
});

it("cleans up the SSH connection when the stream closes", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  fakeStream.stderr = new EventEmitter();
  const fakeConn = { end: vi.fn() };
  streamBackupFile.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);
  fakeStream.emit("close", 0);

  expect(fakeConn.end).toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});

it("logs an error when the remote command exits non-zero, with stderr for context", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  fakeStream.stderr = new EventEmitter();
  const fakeConn = { end: vi.fn() };
  streamBackupFile.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);
  fakeStream.stderr.emit("data", Buffer.from("refused: command not permitted for this key"));
  fakeStream.emit("close", 1);

  expect(fakeConn.end).toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith(
    "Backup download command exited with code %d for %s: %s",
    1,
    VALID_VOLID,
    "refused: command not permitted for this key",
  );
});

it("logs, ends the response, and cleans up the connection on a mid-stream error without touching the status code", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  fakeStream.stderr = new EventEmitter();
  const fakeConn = { end: vi.fn() };
  streamBackupFile.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);
  res.status.mockClear(); // headers/pipe setup is done; only care about post-error behavior
  fakeStream.emit("error", new Error("boom"));

  expect(logger.error).toHaveBeenCalled();
  expect(fakeConn.end).toHaveBeenCalled();
  expect(res.end).toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});

it("cleans up the SSH connection when the client aborts the request", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  fakeStream.stderr = new EventEmitter();
  const fakeConn = { end: vi.fn() };
  streamBackupFile.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);
  req.emit("close");

  expect(fakeConn.end).toHaveBeenCalled();
});
