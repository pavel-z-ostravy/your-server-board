import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, getPveConfig, getLxcProcesses, getLxcOsProbe, getQemuProcesses, getQemuOsProbe, logger } =
  vi.hoisted(() => ({
    getSmartConfig: vi.fn(),
    getPveConfig: vi.fn(),
    getLxcProcesses: vi.fn(),
    getLxcOsProbe: vi.fn(),
    getQemuProcesses: vi.fn(),
    getQemuOsProbe: vi.fn(),
    logger: { error: vi.fn() },
  }));

vi.mock("utils/config/proxmox", () => ({ getSmartConfig, getPveConfig }));
vi.mock("utils/ssh/lxcClient", () => ({ getLxcProcesses, getLxcOsProbe }));
vi.mock("utils/proxmox/agentExec", () => ({ getQemuProcesses, getQemuOsProbe }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/proxmox/vm-detail/index";

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "./config/ssh/id_smart" };
const pveConfig = { url: "https://10.0.1.9:8006", token: "root@pam!ysb", secret: "s3cr3t" };

const REAL_PS_OUTPUT = "   3368  0.8 18.4 redis-server\n    174  0.0  1.3 dockerd\n";
const REAL_OS_PROBE_OUTPUT = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n---\nnone\n';

describe("pages/api/proxmox/vm-detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 405 for a non-GET request without calling any client function", async () => {
    const req = { method: "POST", query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "Method not allowed" });
    expect(getSmartConfig).not.toHaveBeenCalled();
    expect(getPveConfig).not.toHaveBeenCalled();
    expect(getLxcProcesses).not.toHaveBeenCalled();
    expect(getQemuProcesses).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "qemu", node: "proxmox" }, "vmid"],
    [{ type: "qemu", vmid: "100" }, "node"],
    [{ node: "proxmox", vmid: "100" }, "type"],
    [{ type: "container", node: "proxmox", vmid: "100" }, "type"],
    [{ type: "qemu", node: "../etc", vmid: "100" }, "node"],
    [{ type: "qemu", node: "proxmox", vmid: "100; rm -rf /" }, "vmid"],
  ])("returns 400 for invalid query %o (bad %s)", async (query) => {
    const req = { method: "GET", query };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(getLxcProcesses).not.toHaveBeenCalled();
    expect(getQemuProcesses).not.toHaveBeenCalled();
  });

  it("returns 500 when the LXC SSH config is missing for a type=lxc request", async () => {
    getSmartConfig.mockReturnValue(null);

    const req = { method: "GET", query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
  });

  it("returns 500 when the Proxmox API config is missing for a type=qemu request", async () => {
    getPveConfig.mockReturnValue(null);

    const req = { method: "GET", query: { type: "qemu", node: "proxmox", vmid: "100" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
  });

  it("returns parsed process list and OS info for a successful lxc request", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    getLxcProcesses.mockResolvedValue(REAL_PS_OUTPUT);
    getLxcOsProbe.mockResolvedValue(REAL_OS_PROBE_OUTPUT);

    const req = { method: "GET", query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(getLxcProcesses).toHaveBeenCalledWith(sshConfig, "200");
    expect(res.statusCode).toBe(200);
    expect(res.body.processes[0]).toEqual({ pid: 3368, cpuPercent: 0.8, memPercent: 18.4, command: "redis-server" });
    expect(res.body.osReleaseName).toBe("Debian GNU/Linux 12 (bookworm)");
    expect(res.body.lastUpdate).toBeNull();
  });

  it("returns parsed process list and OS info for a successful qemu request", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    getQemuProcesses.mockResolvedValue(REAL_PS_OUTPUT);
    getQemuOsProbe.mockResolvedValue(REAL_OS_PROBE_OUTPUT);

    const req = { method: "GET", query: { type: "qemu", node: "proxmox", vmid: "100" } };
    const res = createMockRes();

    await handler(req, res);

    expect(getQemuProcesses).toHaveBeenCalledWith(pveConfig, "proxmox", "100");
    expect(res.statusCode).toBe(200);
    expect(res.body.processes).toHaveLength(2);
  });

  it("degrades to empty processes and null OS info, without failing the request, when both live calls fail", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    getLxcProcesses.mockRejectedValue(new Error("SSH command timed out after 15000ms"));
    getLxcOsProbe.mockRejectedValue(new Error("SSH command timed out after 15000ms"));

    const req = { method: "GET", query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ processes: [], osReleaseName: null, lastUpdate: null });
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("timed out");
  });

  it("degrades only the failing half when process listing succeeds but the OS probe fails", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    getLxcProcesses.mockResolvedValue(REAL_PS_OUTPUT);
    getLxcOsProbe.mockRejectedValue(new Error("boom"));

    const req = { method: "GET", query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.processes).toHaveLength(2);
    expect(res.body.osReleaseName).toBeNull();
    expect(res.body.lastUpdate).toBeNull();
  });
});
