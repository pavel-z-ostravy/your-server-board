import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, getHostProcesses, logger } = vi.hoisted(() => ({
  getSmartConfig: vi.fn(),
  getHostProcesses: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/config/proxmox", () => ({ getSmartConfig }));
vi.mock("utils/ssh/hostClient", () => ({ getHostProcesses }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/proxmox/host-detail/index";

const sshConfig = { host: "10.0.0.9", username: "root", privateKeyPath: "./config/ssh/id_smart" };
const REAL_PS_OUTPUT = "   512  4.2  1.1 pvedaemon\n    980  0.3  0.2 pveproxy\n";

describe("pages/api/proxmox/host-detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 405 for a non-GET request without calling getHostProcesses", async () => {
    const req = { method: "POST" };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "Method not allowed" });
    expect(getHostProcesses).not.toHaveBeenCalled();
  });

  it("returns 500 when the SMART SSH config is missing", async () => {
    getSmartConfig.mockReturnValue(null);

    const req = { method: "GET" };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "SMART SSH configuration not found" });
  });

  it("returns parsed process list for a successful request", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    getHostProcesses.mockResolvedValue(REAL_PS_OUTPUT);

    const req = { method: "GET" };
    const res = createMockRes();

    await handler(req, res);

    expect(getHostProcesses).toHaveBeenCalledWith(sshConfig);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      processes: [
        { pid: 512, cpuPercent: 4.2, memPercent: 1.1, command: "pvedaemon" },
        { pid: 980, cpuPercent: 0.3, memPercent: 0.2, command: "pveproxy" },
      ],
    });
  });

  it("degrades to an empty process list (never a 500) when the SSH call fails", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    getHostProcesses.mockRejectedValue(new Error("Command exited with code 1: ps: unexpected error"));

    const req = { method: "GET" };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ processes: [] });
    expect(logger.error).toHaveBeenCalled();
  });
});
