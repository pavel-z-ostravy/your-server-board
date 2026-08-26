import { EventEmitter } from "node:events";

import { beforeEach, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, streamConfigBackup, logger } = vi.hoisted(() => ({
  getSmartConfig: vi.fn(),
  streamConfigBackup: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/config/proxmox", () => ({ getSmartConfig }));
vi.mock("utils/ssh/backupClient", () => ({ streamConfigBackup }));
vi.mock("utils/logger", () => ({
  default: () => logger,
}));

import handler from "pages/api/proxmox/backups/config-download";

const sshConfig = { host: "proxmox.local", username: "root", privateKeyPath: "/fake/key" };

function createFakeReq(overrides = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method: "GET", query: {} }, overrides);
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSmartConfig.mockReturnValue(sshConfig);
});

it("returns 405 for non-GET methods", async () => {
  const res = createMockRes();
  await handler({ method: "POST" }, res);
  expect(res.status).toHaveBeenCalledWith(405);
  expect(streamConfigBackup).not.toHaveBeenCalled();
});

it("returns 500 when SMART SSH configuration is missing", async () => {
  getSmartConfig.mockReturnValue(null);
  const res = createMockRes();
  await handler(createFakeReq(), res);
  expect(res.status).toHaveBeenCalledWith(500);
  expect(streamConfigBackup).not.toHaveBeenCalled();
});

it("sets download headers with a timestamped filename and pipes the stream on success", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  fakeStream.stderr = new EventEmitter();
  const fakeConn = { end: vi.fn() };
  streamConfigBackup.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);

  expect(streamConfigBackup).toHaveBeenCalledWith(sshConfig);
  expect(res.setHeader).toHaveBeenCalledWith(
    "Content-Disposition",
    expect.stringMatching(/^attachment; filename="pve-config-backup-.+\.tar\.gz"$/),
  );
  expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/gzip");
  expect(fakeStream.pipe).toHaveBeenCalledWith(res);
});

it("returns 500 when opening the SSH stream fails", async () => {
  streamConfigBackup.mockRejectedValue(new Error("connection refused"));
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
  streamConfigBackup.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

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
  streamConfigBackup.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);
  fakeStream.stderr.emit("data", Buffer.from("refused: command not permitted for this key"));
  fakeStream.emit("close", 1);

  expect(fakeConn.end).toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith(
    "Proxmox config backup command exited with code %d: %s",
    1,
    "refused: command not permitted for this key",
  );
});

it("logs, ends the response, and cleans up the connection on a mid-stream error without touching the status code", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  fakeStream.stderr = new EventEmitter();
  const fakeConn = { end: vi.fn() };
  streamConfigBackup.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);
  res.status.mockClear();
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
  streamConfigBackup.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = createFakeReq();
  const res = createMockRes();

  await handler(req, res);
  req.emit("close");

  expect(fakeConn.end).toHaveBeenCalled();
});
