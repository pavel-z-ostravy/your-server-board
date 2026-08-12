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

import handler from "pages/api/proxmox/vms/index";

const pveConfig = { url: "https://10.0.1.9:8006", token: "root@pam!ysb", secret: "s3cr3t" };

// httpProxy returns [status, headers, data] — data is a Buffer-able body.
function jsonResponse(status, body) {
  return [status, {}, Buffer.from(JSON.stringify(body))];
}

// httpProxy never rejects — on a network-level failure (connection refused,
// DNS failure, etc.) it catches the error internally and resolves with this
// shape instead: status 500, and a plain JS object (not a Buffer) as the
// third element. See src/utils/proxy/http.js's httpProxy catch branch.
function networkFailure(message) {
  return [500, "application/json", { error: { message, url: "https://10.0.1.9:8006/...", rawError: {} } }, null];
}

const clusterResourcesBody = {
  data: [
    {
      id: "qemu/100",
      vmid: 100,
      node: "proxmox",
      type: "qemu",
      name: "homeassistant",
      status: "running",
      template: 0,
      cpu: 0.0625912395730508,
      maxcpu: 1,
      mem: 3088969728,
      maxmem: 3221225472,
      disk: 0,
      maxdisk: 34359738368,
      uptime: 92576,
    },
    {
      id: "lxc/200",
      vmid: 200,
      node: "proxmox",
      type: "lxc",
      name: "lxc-homelab",
      status: "running",
      template: 0,
      cpu: 0.256998899633673,
      maxcpu: 4,
      mem: 4531613696,
      maxmem: 12582912000,
      disk: 61370929152,
      maxdisk: 84358758400,
      uptime: 135548,
    },
    // A template must be excluded entirely — never queried further, never returned.
    {
      id: "qemu/9000",
      vmid: 9000,
      node: "proxmox",
      type: "qemu",
      name: "ubuntu-template",
      status: "stopped",
      template: 1,
      cpu: 0,
      maxcpu: 2,
      mem: 0,
      maxmem: 2147483648,
      disk: 0,
      maxdisk: 21474836480,
      uptime: 0,
    },
  ],
};

const qemuConfigBody = { data: { net0: "virtio=BC:24:11:85:3A:8F,bridge=vmbr0", agent: "1" } };
const lxcConfigBody = {
  data: { net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AE:7C:89,ip=dhcp,type=veth", ostype: "debian" },
};
const lxcInterfacesBody = {
  data: [
    {
      name: "eth0",
      "hardware-address": "bc:24:11:ae:7c:89",
      "ip-addresses": [{ "ip-address": "10.0.1.104", "ip-address-type": "inet" }],
    },
  ],
};
const qemuAgentInterfacesBody = {
  data: {
    result: [
      {
        name: "enp0s18",
        "hardware-address": "bc:24:11:85:3a:8f",
        "ip-addresses": [{ "ip-address": "10.0.1.22", "ip-address-type": "ipv4" }],
      },
    ],
  },
};
const qemuAgentOsinfoBody = { data: { result: { "pretty-name": "Home Assistant OS 18.2" } } };

describe("pages/api/proxmox/vms", () => {
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

  it("returns 500 when cluster/resources itself fails", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch Proxmox cluster resources" });
  });

  it("excludes templates and composes full detail for real VMs/LXCs", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("cluster/resources")) return jsonResponse(200, clusterResourcesBody);
      if (url.includes("/qemu/100/config")) return jsonResponse(200, qemuConfigBody);
      if (url.includes("/qemu/100/agent/network-get-interfaces")) return jsonResponse(200, qemuAgentInterfacesBody);
      if (url.includes("/qemu/100/agent/get-osinfo")) return jsonResponse(200, qemuAgentOsinfoBody);
      if (url.includes("/lxc/200/config")) return jsonResponse(200, lxcConfigBody);
      if (url.includes("/lxc/200/interfaces")) return jsonResponse(200, lxcInterfacesBody);
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual({
      vmid: 100,
      node: "proxmox",
      type: "qemu",
      name: "homeassistant",
      status: "running",
      cpuUsedCores: 0.0625912395730508,
      cpuTotalCores: 1,
      memUsedBytes: 3088969728,
      memTotalBytes: 3221225472,
      diskUsedBytes: null,
      diskTotalBytes: 34359738368,
      uptimeSeconds: 92576,
      macAddress: "BC:24:11:85:3A:8F",
      ipAddress: "10.0.1.22",
      osName: "Home Assistant OS 18.2",
    });
    expect(res.body[1]).toEqual({
      vmid: 200,
      node: "proxmox",
      type: "lxc",
      name: "lxc-homelab",
      status: "running",
      cpuUsedCores: 0.256998899633673 * 4,
      cpuTotalCores: 4,
      memUsedBytes: 4531613696,
      memTotalBytes: 12582912000,
      diskUsedBytes: 61370929152,
      diskTotalBytes: 84358758400,
      uptimeSeconds: 135548,
      macAddress: "BC:24:11:AE:7C:89",
      ipAddress: "10.0.1.104",
      osName: "debian",
    });
  });

  it("degrades a single VM's enrichment to nulls without failing the whole route when its config call fails", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("cluster/resources")) return jsonResponse(200, clusterResourcesBody);
      if (url.includes("/qemu/100/config")) return networkFailure("connect ECONNREFUSED 10.0.1.9:8006");
      if (url.includes("/lxc/200/config")) return jsonResponse(200, lxcConfigBody);
      if (url.includes("/lxc/200/interfaces")) return jsonResponse(200, lxcInterfacesBody);
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body[0]).toMatchObject({ vmid: 100, macAddress: null, ipAddress: null, osName: null });
    // Base stats from cluster/resources must still be present even though enrichment failed.
    expect(res.body[0]).toMatchObject({ memUsedBytes: 3088969728, status: "running" });
    // lxc-homelab's enrichment succeeded independently — one VM's failure doesn't affect another's.
    expect(res.body[1]).toMatchObject({ macAddress: "BC:24:11:AE:7C:89", ipAddress: "10.0.1.104" });
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
  });

  it("degrades a QEMU VM without a running guest agent to null IP/OS but keeps its MAC from config", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("cluster/resources")) return jsonResponse(200, { data: [clusterResourcesBody.data[0]] });
      if (url.includes("/qemu/100/config")) return jsonResponse(200, qemuConfigBody);
      if (url.includes("/qemu/100/agent/")) return jsonResponse(500, { error: "QEMU guest agent is not running" });
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body[0]).toMatchObject({ macAddress: "BC:24:11:85:3A:8F", ipAddress: null, osName: null });
  });
});
