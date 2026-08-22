import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, httpProxy, logger } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  httpProxy: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxy/http", () => ({ httpProxy }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/proxmox/host/index";

const pveConfig = { url: "https://10.0.0.9:8006", token: "root@pam!ysb", secret: "s3cr3t" };

// httpProxy returns [status, headers, data] — data is a Buffer-able body.
function jsonResponse(status, body) {
  return [status, {}, Buffer.from(JSON.stringify(body))];
}

// httpProxy never rejects — on a network-level failure it resolves with this
// shape instead. See src/utils/proxy/http.js's httpProxy catch branch.
function networkFailure(message) {
  return [500, "application/json", { error: { message, url: "https://10.0.0.9:8006/...", rawError: {} } }, null];
}

// Shape verified against a live Proxmox 9.2 host's GET /nodes response
// (values below are invented examples, not the real host's numbers).
const onlineNodesBody = {
  data: [
    {
      node: "proxmox",
      status: "online",
      cpu: 0.4,
      maxcpu: 8,
      mem: 4210000000,
      maxmem: 8590000000,
      disk: 21300000000,
      maxdisk: 64700000000,
      uptime: 93784,
    },
  ],
};

const offlineNodesBody = {
  data: [
    {
      node: "proxmox",
      status: "offline",
      cpu: 0,
      maxcpu: 8,
      mem: 0,
      maxmem: 8590000000,
      disk: 0,
      maxdisk: 64700000000,
      uptime: 0,
    },
  ],
};

// Shape verified against a live Proxmox 9.2 host's GET /nodes/{node}/status
// response (values below are invented examples).
const nodeStatusBody = {
  data: {
    pveversion: "pve-manager/9.1.1/somehash1234",
    loadavg: ["0.55", "0.61", "0.58"],
    uptime: 93784,
    memory: { total: 8590000000, used: 4210000000, free: 1500000000, available: 3200000000 },
    rootfs: { total: 64700000000, used: 21300000000, free: 40000000000, avail: 38000000000 },
    cpu: 0,
  },
};

// Shape verified against a live Proxmox 9.2 host's GET /nodes/{node}/network
// response: the physical NIC has no address of its own; the bridge
// configured on top of it carries the actual IP (values below are invented).
const networkBody = {
  data: [
    { iface: "nic0", type: "eth", families: ["inet"] },
    { iface: "vmbr0", type: "bridge", families: ["inet"], address: "10.0.0.9" },
  ],
};

const networkBodyNoMatch = {
  data: [{ iface: "nic0", type: "eth", families: ["inet"] }],
};

describe("pages/api/proxmox/host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 500 when pve config is missing", async () => {
    getPveConfig.mockReturnValue(null);

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Proxmox server configuration not found" });
    expect(httpProxy).not.toHaveBeenCalled();
  });

  it("returns 500 when the nodes list call itself fails", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch Proxmox node status" });
  });

  it("returns a full status object, including ipAddress, for an online node", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/nodes/proxmox/status")) return jsonResponse(200, nodeStatusBody);
      if (url.includes("/nodes/proxmox/network")) return jsonResponse(200, networkBody);
      if (url.includes("/nodes")) return jsonResponse(200, onlineNodesBody);
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "online",
      cpuUsedCores: 3.2,
      cpuTotalCores: 8,
      memUsedBytes: 4210000000,
      memTotalBytes: 8590000000,
      diskUsedBytes: 21300000000,
      diskTotalBytes: 64700000000,
      uptimeSeconds: 93784,
      pveVersion: "9.1.1",
      loadAvg: [0.55, 0.61, 0.58],
      ipAddress: "10.0.0.9",
    });
  });

  it("returns ipAddress: null when the network call succeeds but no interface matches", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/nodes/proxmox/status")) return jsonResponse(200, nodeStatusBody);
      if (url.includes("/nodes/proxmox/network")) return jsonResponse(200, networkBodyNoMatch);
      if (url.includes("/nodes")) return jsonResponse(200, onlineNodesBody);
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ipAddress).toBeNull();
    expect(res.body.pveVersion).toBe("9.1.1"); // unaffected by the network call's outcome
  });

  it("returns a degraded offline entry (including ipAddress: null) without attempting the status/network calls, for an offline node", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockResolvedValueOnce(jsonResponse(200, offlineNodesBody));

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "offline",
      cpuUsedCores: null,
      cpuTotalCores: null,
      memUsedBytes: null,
      memTotalBytes: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
      uptimeSeconds: null,
      pveVersion: null,
      loadAvg: null,
      ipAddress: null,
    });
    expect(httpProxy).toHaveBeenCalledTimes(1);
  });

  it("returns a degraded offline entry when the nodes list is empty", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("offline");
    expect(res.body.ipAddress).toBeNull();
    expect(httpProxy).toHaveBeenCalledTimes(1);
  });

  it("degrades only pveVersion/loadAvg to null when the status call fails but the network call succeeds", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/nodes/proxmox/status")) return networkFailure("connect ECONNREFUSED 10.0.0.9:8006");
      if (url.includes("/nodes/proxmox/network")) return jsonResponse(200, networkBody);
      if (url.includes("/nodes")) return jsonResponse(200, onlineNodesBody);
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: "online",
      cpuUsedCores: 3.2,
      memUsedBytes: 4210000000,
      pveVersion: null,
      loadAvg: null,
      ipAddress: "10.0.0.9", // unaffected by the status call's failure
    });
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
  });

  it("degrades only ipAddress to null when the network call fails but the status call succeeds", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/nodes/proxmox/status")) return jsonResponse(200, nodeStatusBody);
      if (url.includes("/nodes/proxmox/network")) return networkFailure("connect ECONNREFUSED 10.0.0.9:8006");
      if (url.includes("/nodes")) return jsonResponse(200, onlineNodesBody);
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: "online",
      pveVersion: "9.1.1", // unaffected by the network call's failure
      loadAvg: [0.55, 0.61, 0.58],
      ipAddress: null,
    });
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
  });
});
