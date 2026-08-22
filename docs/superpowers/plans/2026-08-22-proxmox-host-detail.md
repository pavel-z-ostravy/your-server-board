# Proxmox Host IP + Process Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an IP-address line and a lazy-fetched "Details" process-list toggle to the Proxmox host status header, matching what `VmCard` already has for individual VMs/LXCs.

**Architecture:** `GET /api/proxmox/host` gains an `ipAddress` field (from a new `GET /nodes/{node}/network` call, parsed by a new pure helper). A new `GET /api/proxmox/host-detail` route (mirroring `GET /api/proxmox/vm-detail`'s LXC branch) runs a fixed `ps` command over the existing restricted SSH key via a new `hostClient.js` module. `NodeStatusHeader` gains the IP line and a `VmCard`-style Details toggle consuming the new route. The live Proxmox host's forced-command SSH script needs a matching new allowed command, edited and committed here but **not deployed to the live host without separate, explicit approval** at that point.

**Tech Stack:** Next.js 16 (pages router), `ssh2`, Vitest + Testing Library — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-proxmox-host-detail-design.md`

## Global Constraints

- **No MAC address, no OS-release/last-update line for the host** — explicitly out of scope (see spec's Non-goals). Do not add fields beyond what each task specifies.
- **The `ps` command for the host is fixed and parameter-free** — no vmid, no interpolation of any client/request input anywhere in `hostClient.js` or the SSH allowlist script. There is no injection surface to validate because there is nothing variable in the command.
- **`deploy/proxmox-smart-helper.sh` changes are committed to the repo in this plan, but must NEVER be copied to the live Proxmox host as part of any task in this plan.** That is a separate, explicitly-gated action outside this plan's scope — flag it in your report, do not attempt it, do not SSH into any production host.
- **No server-specific code** — this repo ships publicly; nothing may reference this deployment's real host, IP, or credentials. Every fixture/example value in this plan is invented or genericized from a verified real shape, not copied verbatim from a live host's actual data.
- **pnpm only.**
- **Every new/modified module needs Vitest coverage**, and every task must leave `pnpm test`, `pnpm lint`, `pnpm exec prettier --check "src/**/*.{js,jsx}"`, and `pnpm build` all green. `pnpm build` is a hard requirement on this project — a prior feature shipped a build-breaking client/server bundle leak that `pnpm test`/`pnpm lint`/`pnpm exec prettier` alone didn't catch.

---

### Task 1: `pickPrimaryIpAddress` — pure network-interface parser

**Files:**

- Modify: `src/utils/proxmox/nodeStatus.js`
- Modify: `src/utils/proxmox/nodeStatus.test.js`

**Interfaces:**

- Produces (used by Task 3):

  - `pickPrimaryIpAddress(interfaces: unknown): string | null` — given the array `GET /nodes/{node}/network` returns (verified live shape: each entry may have `families: string[]` and, only on the interface actually carrying the IP — typically a bridge, not the raw physical NIC underneath it — an `address: string`), returns the first entry's `address` where `families` includes `"inet"` and `address` is a non-empty string. Returns `null` if no such entry exists, or `interfaces` isn't an array.

- [ ] **Step 1: Write the failing tests**

Add to the end of `src/utils/proxmox/nodeStatus.test.js` (keep the existing `parsePveVersion` import and add `pickPrimaryIpAddress` to it):

```js
import { describe, expect, it } from "vitest";

import { parsePveVersion, pickPrimaryIpAddress } from "./nodeStatus";

// ... existing parsePveVersion describe block stays unchanged ...

describe("pickPrimaryIpAddress", () => {
  it("picks the first interface with an inet family and a populated address", () => {
    // Shape verified against a live Proxmox 9.2 host's GET /nodes/{node}/network
    // response: physical NICs have no address of their own; the bridge configured
    // on top of them carries the actual IP.
    const interfaces = [
      { iface: "nic0", type: "eth", families: ["inet"] },
      { iface: "vmbr0", type: "bridge", families: ["inet"], address: "10.0.0.9" },
    ];
    expect(pickPrimaryIpAddress(interfaces)).toBe("10.0.0.9");
  });

  it("returns null when no interface has both an inet family and an address", () => {
    const interfaces = [
      { iface: "nic0", families: ["inet"] },
      { iface: "lo", families: ["inet6"] },
    ];
    expect(pickPrimaryIpAddress(interfaces)).toBeNull();
  });

  it("returns null for a non-array input", () => {
    expect(pickPrimaryIpAddress(null)).toBeNull();
    expect(pickPrimaryIpAddress(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/proxmox/nodeStatus.test.js`
Expected: FAIL — `pickPrimaryIpAddress` is not exported yet (existing `parsePveVersion` tests still pass).

- [ ] **Step 3: Write the implementation**

Add to `src/utils/proxmox/nodeStatus.js` (keep the existing `parsePveVersion` export unchanged, add this alongside it):

```js
// Picks the host's primary IPv4 address from GET /nodes/{node}/network's
// interface array (verified against a live Proxmox 9.2 host) - the address
// lives on whichever entry has both an "inet" family and a populated
// address field. That's typically the bridge with the IP configured on it,
// not the raw physical NIC underneath it, which has no address field of its
// own. Returns null if no such entry exists or interfaces isn't an array.
export function pickPrimaryIpAddress(interfaces) {
  if (!Array.isArray(interfaces)) return null;
  const match = interfaces.find(
    (iface) =>
      Array.isArray(iface?.families) &&
      iface.families.includes("inet") &&
      typeof iface?.address === "string" &&
      iface.address.length > 0,
  );
  return match ? match.address : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/proxmox/nodeStatus.test.js`
Expected: PASS, all 7 tests green (4 existing `parsePveVersion` + 3 new `pickPrimaryIpAddress`).

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/utils/proxmox/nodeStatus.js" "src/utils/proxmox/nodeStatus.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/utils/proxmox/nodeStatus.js src/utils/proxmox/nodeStatus.test.js
git commit -m "feat(proxmox): add pure host-network-interface IP picker"
```

---

### Task 2: `hostClient.js` — host process-listing SSH client

**Files:**

- Create: `src/utils/ssh/hostClient.js`
- Create: `src/utils/ssh/hostClient.test.js`

**Interfaces:**

- Produces (used by Task 3):

  - `getHostProcesses(sshConfig: {host, username, privateKeyPath, port?}): Promise<string>` — runs `ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu` directly over SSH (no `pct exec` wrapper — this targets the host itself, not a container) using the same restricted key already used for SMART/`lsblk`/`pct exec`. Resolves with raw stdout on exit code 0; rejects with an `Error` on non-zero exit or a connection/timeout failure. No parameters beyond `sshConfig` — the command is fixed, nothing is interpolated into it.
  - `SSH_COMMAND_TIMEOUT_MS` — exported constant, same value and purpose as the identically-named export in `src/utils/ssh/lxcClient.js`.

- [ ] **Step 1: Write the failing tests**

Create `src/utils/ssh/hostClient.test.js`:

```js
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "fake-private-key"),
}));

const PS_COMMAND = "ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu";

let commandBehavior = "success"; // "success" | "nonzero"

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

class FakeClient extends EventEmitter {
  connect() {
    setImmediate(() => this.emit("ready"));
  }

  exec(command, callback) {
    const stream = new FakeStream();
    setImmediate(() => {
      callback(null, stream);

      if (command === PS_COMMAND) {
        if (commandBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("ps: unexpected error\n"));
          stream.emit("close", 1);
        } else {
          stream.emit("data", Buffer.from("   512  4.2  1.1 pvedaemon\n    980  0.3  0.2 pveproxy\n"));
          stream.emit("close", 0);
        }
        return;
      }

      stream.stderr.emit("data", Buffer.from(`unexpected command: ${command}\n`));
      stream.emit("close", 127);
    });
  }

  end() {}
}

vi.mock("ssh2", () => ({
  Client: FakeClient,
}));

const { getHostProcesses } = await import("./hostClient");

const sshConfig = { host: "10.0.0.9", username: "root", privateKeyPath: "/config/ssh/id_smart" };

afterEach(() => {
  commandBehavior = "success";
});

describe("hostClient", () => {
  it("fetches raw process listing output via the exact ps command", async () => {
    const result = await getHostProcesses(sshConfig);
    expect(result).toBe("   512  4.2  1.1 pvedaemon\n    980  0.3  0.2 pveproxy\n");
  });

  it("rejects getHostProcesses when the command exits non-zero", async () => {
    commandBehavior = "nonzero";
    await expect(getHostProcesses(sshConfig)).rejects.toThrow(/exited with code 1/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/ssh/hostClient.test.js`
Expected: FAIL — `hostClient.js` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/utils/ssh/hostClient.js`:

```js
import { readFileSync } from "node:fs";

import { Client } from "ssh2";

export const SSH_COMMAND_TIMEOUT_MS = 15000;

function execCommand(sshConfig, command, timeoutMs = SSH_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(new Error(`SSH command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            settle(reject, err);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code) => {
              conn.end();
              settle(resolve, { stdout, stderr, code });
            })
            .on("data", (data) => {
              stdout += data.toString();
            });
          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
        });
      })
      .on("error", (err) => {
        conn.end();
        settle(reject, err);
      })
      .connect({
        host: sshConfig.host,
        port: sshConfig.port ?? 22,
        username: sshConfig.username,
        privateKey: readFileSync(sshConfig.privateKeyPath),
      });
  });
}

// No vmid, no interpolation of anything - this command is fixed and targets
// the Proxmox host itself, not a container, so there is nothing to validate.
export async function getHostProcesses(sshConfig) {
  const { stdout, stderr, code } = await execCommand(sshConfig, "ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu");
  if (code !== 0) {
    throw new Error(`Command exited with code ${code}: ${stderr}`);
  }
  return stdout;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/ssh/hostClient.test.js`
Expected: PASS, all 2 tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/utils/ssh/hostClient.js" "src/utils/ssh/hostClient.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/utils/ssh/hostClient.js src/utils/ssh/hostClient.test.js
git commit -m "feat(proxmox): add SSH client for host-level process listing"
```

---

### Task 3: API layer — `ipAddress` on `/api/proxmox/host` + new `/api/proxmox/host-detail`

**Files:**

- Modify: `src/pages/api/proxmox/host/index.js`
- Modify: `src/__tests__/pages/api/proxmox/host/index.test.js`
- Create: `src/pages/api/proxmox/host-detail/index.js`
- Create: `src/__tests__/pages/api/proxmox/host-detail/index.test.js`

**Interfaces:**

- Consumes: `pickPrimaryIpAddress` from `utils/proxmox/nodeStatus` (Task 1); `getHostProcesses` from `utils/ssh/hostClient` (Task 2); `getSmartConfig` from `utils/config/proxmox` (existing); `parseTopProcesses` from `utils/proxmox/processDetail` (existing).
- Produces (used by Task 4):

  - `GET /api/proxmox/host` — same shape as before, plus `ipAddress: string | null`. The offline-degraded body also gains `ipAddress: null`.
  - `GET /api/proxmox/host-detail` → `200 { processes: Array<{pid, cpuPercent, memPercent, command}> }` always (an SSH failure degrades to `{ processes: [] }` with a logged error, never a 500 for a process-listing failure — matches `/api/proxmox/vm-detail`'s existing precedent). `500 { error: "SMART SSH configuration not found" }` when `getSmartConfig()` returns falsy. `405 { error: "Method not allowed" }` for non-GET.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `src/__tests__/pages/api/proxmox/host/index.test.js`:

```js
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
```

Create `src/__tests__/pages/api/proxmox/host-detail/index.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/api/proxmox/host/index.test.js src/__tests__/pages/api/proxmox/host-detail/index.test.js`
Expected: the `host` test file FAILS (new `ipAddress` assertions don't match yet); the `host-detail` test file FAILS (route module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `src/pages/api/proxmox/host/index.js`:

```js
import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { parsePveVersion, pickPrimaryIpAddress } from "utils/proxmox/nodeStatus";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxHostService");

async function pveGet(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "GET", headers });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

// Returned when the node is offline, or GET /nodes returned no entries at
// all (shouldn't happen for a real single-node deployment, but the field
// shape must still be well-formed for the client either way).
function offlineEntry() {
  return {
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
  };
}

export default async function handler(req, res) {
  const pveConfig = getPveConfig();

  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  let nodes;
  try {
    nodes = await pveGet(pveConfig, "nodes");
  } catch (error) {
    logger.error("Failed to fetch Proxmox nodes:", error);
    return res.status(500).json({ error: "Failed to fetch Proxmox node status" });
  }

  const node = nodes?.[0];
  if (!node || node.status !== "online") {
    return res.status(200).json(offlineEntry());
  }

  // GET /nodes already carries this deployment's cpu/mem/disk/uptime numbers
  // for its one node - no need to duplicate them from /nodes/{node}/status's
  // memory/rootfs objects below, which describe the exact same values.
  const base = {
    status: node.status,
    cpuUsedCores: node.cpu * node.maxcpu,
    cpuTotalCores: node.maxcpu,
    memUsedBytes: node.mem,
    memTotalBytes: node.maxmem,
    diskUsedBytes: node.disk,
    diskTotalBytes: node.maxdisk,
    uptimeSeconds: node.uptime,
  };

  // Fetched independently via allSettled - a failure in either call must
  // only degrade its own field(s), never the other's, matching this route's
  // established graceful-degradation contract (and this codebase's existing
  // Promise.allSettled precedent in pages/api/proxmox/vm-detail/index.js).
  const [statusResult, networkResult] = await Promise.allSettled([
    pveGet(pveConfig, `nodes/${node.node}/status`),
    pveGet(pveConfig, `nodes/${node.node}/network`),
  ]);

  let pveVersion = null;
  let loadAvg = null;
  if (statusResult.status === "fulfilled") {
    pveVersion = parsePveVersion(statusResult.value?.pveversion);
    loadAvg = Array.isArray(statusResult.value?.loadavg) ? statusResult.value.loadavg.map(Number) : null;
  } else {
    logger.error("Failed to fetch Proxmox node version/load detail:", statusResult.reason);
  }

  let ipAddress = null;
  if (networkResult.status === "fulfilled") {
    ipAddress = pickPrimaryIpAddress(networkResult.value);
  } else {
    logger.error("Failed to fetch Proxmox node network detail:", networkResult.reason);
  }

  return res.status(200).json({ ...base, pveVersion, loadAvg, ipAddress });
}
```

Create `src/pages/api/proxmox/host-detail/index.js`:

```js
import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { parseTopProcesses } from "utils/proxmox/processDetail";
import { getHostProcesses } from "utils/ssh/hostClient";

const logger = createLogger("proxmoxHostDetailService");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sshConfig = getSmartConfig();
  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let processes = [];
  try {
    const stdout = await getHostProcesses(sshConfig);
    processes = parseTopProcesses(stdout);
  } catch (error) {
    logger.error("Host process listing failed:", error);
  }

  return res.status(200).json({ processes });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/api/proxmox/host/index.test.js src/__tests__/pages/api/proxmox/host-detail/index.test.js`
Expected: PASS — 8 tests in the `host` file, 3 tests in the new `host-detail` file, all green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/api/proxmox/host/index.js" "src/pages/api/proxmox/host-detail/index.js" "src/__tests__/pages/api/proxmox/host/index.test.js" "src/__tests__/pages/api/proxmox/host-detail/index.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/proxmox/host/index.js src/__tests__/pages/api/proxmox/host/index.test.js src/pages/api/proxmox/host-detail/index.js src/__tests__/pages/api/proxmox/host-detail/index.test.js
git commit -m "feat(proxmox): add host ipAddress field and GET /api/proxmox/host-detail"
```

---

### Task 4: Frontend — IP line + Details toggle on `NodeStatusHeader`

**Files:**

- Modify: `src/components/proxmox-vms/group.jsx`
- Modify: `src/components/proxmox-vms/group.test.jsx`

**Interfaces:**

- Consumes: `ipAddress` field and `GET /api/proxmox/host-detail` response shape from Task 3.
- Produces: nothing consumed by later tasks — this is the final application-code task in this plan (Task 5 is a deploy-config-only task).

**Important gotcha this task must handle:** `VmCard` already renders a button with the visible text `"Details"`. Once `NodeStatusHeader` also renders a `"Details"` button, any test using an unscoped `screen.getByText("Details")` will throw ("found multiple elements") whenever both a host header and at least one VM card are rendered in the same test. Three existing tests in `group.test.jsx` do exactly this (search for `screen.getByText("Details").click()`) — Step 1 below fixes all three by scoping the query to the specific VM card via `within(...)`, and Step 1's new host-detail tests avoid the problem entirely by using an empty VM list (no `VmCard` rendered, so `"Details"` is unambiguous there).

**Also note:** `NodeStatusHeader` currently has two early `return` statements (`if (error) ...` / `if (!status) ...`) before any state existed in that function. This task adds `useState` calls for the Details toggle — per React's Rules of Hooks, those `useState` calls must be placed **before** the existing early returns, not after.

Before touching `group.jsx`, confirm the current baseline is green:

Run: `pnpm exec vitest run src/components/proxmox-vms/group.test.jsx`
Expected: PASS (today's regression safety net).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `src/components/proxmox-vms/group.test.jsx`:

```jsx
// src/components/proxmox-vms/group.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import ProxmoxVmsGroup from "./group";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

const onlineHostResponse = {
  ok: true,
  json: () =>
    Promise.resolve({
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
    }),
};

const offlineHostResponse = {
  ok: true,
  json: () =>
    Promise.resolve({
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
    }),
};

const errorHostResponse = { ok: false, json: () => Promise.resolve({ error: "boom" }) };

describe("components/proxmox-vms/group", () => {
  it("renders a heading and a card per VM/LXC with real data", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 100,
            node: "proxmox",
            type: "qemu",
            name: "example-vm",
            status: "running",
            cpuUsedCores: 0.0625912395730508,
            cpuTotalCores: 1,
            memUsedBytes: 3088969728,
            memTotalBytes: 3221225472,
            diskUsedBytes: null,
            diskTotalBytes: 34359738368,
            uptimeSeconds: 92576,
            macAddress: "AA:BB:CC:11:22:33",
            ipAddress: "10.0.0.22",
            osName: "Home Assistant OS 18.2",
          },
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
            status: "stopped",
            cpuUsedCores: 0,
            cpuTotalCores: 4,
            memUsedBytes: 0,
            memTotalBytes: 12582912000,
            diskUsedBytes: 61370929152,
            diskTotalBytes: 84358758400,
            uptimeSeconds: 0,
            macAddress: null,
            ipAddress: null,
            osName: null,
          },
        ]),
    };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(onlineHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    expect(screen.getByText("Proxmox")).toBeInTheDocument();
    expect(screen.getByText("Virtual Machines")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("example-vm")).toBeInTheDocument());

    const vmCard = screen.getByText("example-vm").closest('[data-testid="vm-card"]');
    expect(vmCard).toHaveAttribute("data-status", "running");
    expect(vmCard).toHaveTextContent("Home Assistant OS 18.2");
    expect(vmCard).toHaveTextContent("10.0.0.22");
    expect(vmCard).toHaveTextContent("1d 1h"); // formatUptime(92576)
    expect(vmCard).toHaveTextContent("3.09 GB / 3.22 GB"); // pretty-bytes on mem
    expect(vmCard).toHaveTextContent("34.4 GB (allocated)"); // pretty-bytes on maxdisk (34359738368)

    const lxcCard = screen.getByText("example-lxc").closest('[data-testid="vm-card"]');
    expect(lxcCard).toHaveAttribute("data-status", "stopped");
    expect(lxcCard).toHaveTextContent("-");
  });

  it("renders the Proxmox host status header above the VM grid, including its IP address", async () => {
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(onlineHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    const header = await screen.findByTestId("node-status-header");
    expect(header).toHaveAttribute("data-status", "online");
    expect(header).toHaveTextContent("3.20 / 8"); // CPU
    expect(header).toHaveTextContent("4.21 GB / 8.59 GB"); // RAM
    expect(header).toHaveTextContent("21.3 GB / 64.7 GB"); // Disk
    expect(header).toHaveTextContent("PVE 9.1.1");
    expect(header).toHaveTextContent("load 0.55 / 0.61 / 0.58");
    expect(header).toHaveTextContent("10.0.0.9");
  });

  it("gracefully handles loadAvg with null values (NaN round-trip from JSON) without crashing", async () => {
    const hostResponseWithNullLoadAvg = {
      ok: true,
      json: () =>
        Promise.resolve({
          status: "online",
          cpuUsedCores: 3.2,
          cpuTotalCores: 8,
          memUsedBytes: 4210000000,
          memTotalBytes: 8590000000,
          diskUsedBytes: 21300000000,
          diskTotalBytes: 64700000000,
          uptimeSeconds: 93784,
          pveVersion: "9.1.1",
          loadAvg: [1.06, null, 0.83],
          ipAddress: "10.0.0.9",
        }),
    };
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(hostResponseWithNullLoadAvg) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    const header = await screen.findByTestId("node-status-header");
    expect(header).toHaveAttribute("data-status", "online");
    expect(header).toHaveTextContent("load 1.06 / - / 0.83");
  });

  it("shows a degraded offline state for the host status header without hiding the VM grid", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(offlineHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    const header = await screen.findByTestId("node-status-header");
    expect(header).toHaveAttribute("data-status", "offline");
    // Host is offline, but the VM grid below it still renders normally.
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());
  });

  it("shows a failure message for the host status header when its fetch fails, without affecting the VM grid", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(errorHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    await waitFor(() => expect(screen.getByText("Failed to load Proxmox host status.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());
  });

  it("shows a failure message when the VM list API responds with an error status, independent of host status", async () => {
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host")
        ? Promise.resolve(onlineHostResponse)
        : Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "boom" }) }),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    await waitFor(() => expect(screen.getByText("Failed to load VM/LXC data.")).toBeInTheDocument());
    // VM list failed, but the host status header still renders successfully.
    const header = await screen.findByTestId("node-status-header");
    expect(header).toHaveAttribute("data-status", "online");
  });

  it("clicking Refresh re-fetches both the VM list and the host status", async () => {
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(onlineHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);
    await screen.findByTestId("node-status-header");

    const callsBeforeRefresh = global.fetch.mock.calls.length;
    screen.getByText("Refresh").click();

    await waitFor(() => expect(global.fetch.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
    const urlsAfterRefresh = global.fetch.mock.calls.slice(callsBeforeRefresh).map((call) => call[0]);
    expect(urlsAfterRefresh.some((url) => url.includes("/api/proxmox/vms"))).toBe(true);
    expect(urlsAfterRefresh.some((url) => url.includes("/api/proxmox/host"))).toBe(true);
  });

  it("lazily fetches and shows the host's process detail only after the Details toggle is clicked", async () => {
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    const hostDetailResponse = {
      ok: true,
      json: () =>
        Promise.resolve({ processes: [{ pid: 512, cpuPercent: 4.2, memPercent: 1.1, command: "pvedaemon" }] }),
    };
    global.fetch = vi.fn((url) => {
      // "host-detail" must be checked before the plain "host" check below,
      // since "/api/proxmox/host-detail" also contains "/api/proxmox/host".
      if (url.includes("/api/proxmox/host-detail")) return Promise.resolve(hostDetailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await screen.findByTestId("node-status-header");

    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("host-detail"));
    expect(screen.queryByText("pvedaemon")).not.toBeInTheDocument();

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("pvedaemon")).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/proxmox/host-detail"));
  });

  it("shows an explicit empty-state message when the host detail fetch succeeds with zero processes", async () => {
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    const emptyHostDetailResponse = { ok: true, json: () => Promise.resolve({ processes: [] }) };
    global.fetch = vi.fn((url) => {
      if (url.includes("/api/proxmox/host-detail")) return Promise.resolve(emptyHostDetailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await screen.findByTestId("node-status-header");

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("No process data available.")).toBeInTheDocument());
    expect(screen.queryByText("Failed to load details.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("shows a failure message when the host detail fetch responds with a non-ok status", async () => {
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    const errorHostDetailResponse = { ok: false, json: () => Promise.resolve({ error: "boom" }) };
    global.fetch = vi.fn((url) => {
      if (url.includes("/api/proxmox/host-detail")) return Promise.resolve(errorHostDetailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await screen.findByTestId("node-status-header");

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("Failed to load details.")).toBeInTheDocument());
  });

  it("lazily fetches and shows process/update detail only after the Details toggle is clicked", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    const detailResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          processes: [{ pid: 3368, cpuPercent: 0.8, memPercent: 18.4, command: "redis-server" }],
          osReleaseName: "Debian GNU/Linux 12 (bookworm)",
          lastUpdate: null,
        }),
    };
    global.fetch = vi.fn((url) => {
      if (url.includes("vm-detail")) return Promise.resolve(detailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());

    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("vm-detail"));
    expect(screen.queryByText("redis-server")).not.toBeInTheDocument();

    const vmCard = screen.getByText("example-lxc").closest('[data-testid="vm-card"]');
    within(vmCard).getByText("Details").click();

    await waitFor(() => expect(screen.getByText("redis-server")).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/proxmox/vm-detail?type=lxc&node=proxmox&vmid=200"),
    );
    expect(screen.getByText(/Last update: N\/A/)).toBeInTheDocument();
  });

  it("shows an explicit empty-state message when the VM detail fetch succeeds with zero processes", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
            status: "stopped",
            cpuUsedCores: 0,
            cpuTotalCores: 4,
            memUsedBytes: 0,
            memTotalBytes: 2,
            diskUsedBytes: 0,
            diskTotalBytes: 2,
            uptimeSeconds: 0,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    const detailResponse = {
      ok: true,
      json: () => Promise.resolve({ processes: [], osReleaseName: null, lastUpdate: null }),
    };
    global.fetch = vi.fn((url) => {
      if (url.includes("vm-detail")) return Promise.resolve(detailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());

    const vmCard = screen.getByText("example-lxc").closest('[data-testid="vm-card"]');
    within(vmCard).getByText("Details").click();

    await waitFor(() => expect(screen.getByText("No process data available.")).toBeInTheDocument());
    expect(screen.queryByText(/redis-server/)).not.toBeInTheDocument();
    expect(screen.queryByText("Failed to load details.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("shows a failure message when the VM detail fetch responds with a non-ok status", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    const detailResponse = { ok: false, json: () => Promise.resolve({ error: "boom" }) };
    global.fetch = vi.fn((url) => {
      if (url.includes("vm-detail")) return Promise.resolve(detailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());

    const vmCard = screen.getByText("example-lxc").closest('[data-testid="vm-card"]');
    within(vmCard).getByText("Details").click();

    await waitFor(() => expect(screen.getByText("Failed to load details.")).toBeInTheDocument());
    expect(screen.queryByText("redis-server")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/components/proxmox-vms/group.test.jsx`
Expected: FAIL — the three new host-Details tests fail (no `ipAddress` text, no second "Details" button, `NodeStatusHeader` doesn't yet fetch `/api/proxmox/host-detail`); the three renamed VM-detail tests (now scoped with `within(vmCard)`) still pass against the _old_ component since there's still only one "Details" button today — they'll only start exercising the new scoping once Task 4's component change adds the second button.

- [ ] **Step 3: Write the implementation**

Replace the full contents of `src/components/proxmox-vms/group.jsx`:

```jsx
import classNames from "classnames";
import prettyBytes from "pretty-bytes";
import { useContext, useState } from "react";
import useSWR from "swr";

import { SettingsContext } from "utils/contexts/settings";
import { formatUptime } from "utils/proxmox/uptime";

const STATUS_DOT_CLASS = {
  running: "bg-emerald-500",
  paused: "bg-orange-400",
  stopped: "bg-theme-400",
};

// Same stat-pill classes src/components/services/widget/block.jsx uses, so
// VM/LXC cards read as native Homepage UI. Includes block.jsx's trailing
// "service-block" hook class so custom user CSS targeting it also applies here.
const STAT_CLASS =
  "bg-theme-200/50 dark:bg-theme-900/20 rounded-sm m-1 flex-1 flex flex-col items-center justify-center text-center p-1 service-block";

// Same card wrapper classes src/components/services/item.jsx uses, including its
// trailing "service-card" hook class (custom user CSS / cardBlur target it).
const CARD_CLASS =
  "transition-all mb-2 p-3 rounded-md font-medium text-theme-700 dark:text-theme-200 shadow-md shadow-theme-900/10 dark:shadow-theme-900/20 bg-theme-100/20 dark:bg-white/5 relative overflow-clip service-card";

// Throw on non-ok responses so SWR's `error` populates correctly instead of
// resolving "successfully" with an API error body (e.g. { error: "..." } from a
// 500), which would otherwise make `vms` a non-array and crash render.
const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function formatCapacity(usedBytes, totalBytes) {
  if (usedBytes == null) {
    // QEMU VMs don't have real per-guest disk usage available (out of scope
    // for this feature), but the route still returns the allocated size
    // (maxdisk) for every VM. Show that instead of discarding it as "-".
    return totalBytes == null ? null : `${prettyBytes(totalBytes)} (allocated)`;
  }
  if (totalBytes == null) return null;
  return `${prettyBytes(usedBytes)} / ${prettyBytes(totalBytes)}`;
}

function Stat({ value, label }) {
  return (
    <div className={STAT_CLASS}>
      <div className="font-thin text-sm">{value === null || value === undefined ? "-" : value}</div>
      <div className="font-bold text-xs uppercase">{label}</div>
    </div>
  );
}

// Header block above the VM/LXC card grid, showing the Proxmox host's own
// status - the "parent" row for the "children" grid below it. `status` and
// `error` come from an independent SWR call in ProxmoxVmsGroup, so a
// host-status failure never blocks the VM grid from rendering.
function NodeStatusHeader({ status, error }) {
  // Hooks must run unconditionally on every render (Rules of Hooks), so
  // these are declared before the error/loading early returns below, even
  // though those returns mean this state is sometimes irrelevant.
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);

  // Fetch-on-first-expand, mirroring VmCard's toggleDetail below.
  const toggleDetail = async () => {
    if (detailOpen) {
      setDetailOpen(false);
      return;
    }
    setDetailOpen(true);
    if (detail || detailLoading) return;
    setDetailLoading(true);
    setDetailError(false);
    try {
      const res = await fetch("/api/proxmox/host-detail");
      if (res.ok) {
        setDetail(await res.json());
      } else {
        setDetailError(true);
      }
    } catch {
      setDetailError(true);
    } finally {
      setDetailLoading(false);
    }
  };

  if (error) {
    return <p className="text-rose-500/80 text-sm mb-2">Failed to load Proxmox host status.</p>;
  }
  if (!status) {
    return <p className="text-theme-500 dark:text-theme-300 text-sm mb-2">Loading host status...</p>;
  }

  const cpuValue = status.cpuUsedCores == null ? null : `${status.cpuUsedCores.toFixed(2)} / ${status.cpuTotalCores}`;
  const memValue = formatCapacity(status.memUsedBytes, status.memTotalBytes);
  const diskValue = formatCapacity(status.diskUsedBytes, status.diskTotalBytes);
  const loadAvgText = Array.isArray(status.loadAvg)
    ? status.loadAvg.map((n) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "-")).join(" / ")
    : "-";

  return (
    <div
      className="mb-2 pb-2 border-b border-theme-300/30 dark:border-theme-500/10"
      data-testid="node-status-header"
      data-status={status.status}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium">Host</span>
        <div className="flex items-center gap-2">
          {status.status === "online" && status.uptimeSeconds != null && (
            <span className="text-theme-500 dark:text-theme-300 text-xs font-light">
              {formatUptime(status.uptimeSeconds)}
            </span>
          )}
          <span
            className={classNames(
              "w-2.5 h-2.5 rounded-full",
              STATUS_DOT_CLASS[status.status === "online" ? "running" : "stopped"],
            )}
          />
        </div>
      </div>
      <div className="flex flex-row">
        <Stat value={cpuValue} label="CPU" />
        <Stat value={memValue} label="RAM" />
        <Stat value={diskValue} label="Disk" />
      </div>
      <p className="text-theme-500 dark:text-theme-300 text-xs font-light mt-2">
        {status.pveVersion ? `PVE ${status.pveVersion}` : "-"} &middot; load {loadAvgText}
      </p>
      <p className="text-theme-500 dark:text-theme-300 text-xs font-light mt-1">{status.ipAddress ?? "-"}</p>
      <button type="button" onClick={toggleDetail} className="text-xs text-theme-500 dark:text-theme-300 mt-2">
        Details
      </button>
      {detailOpen && (
        <div className="mt-2 text-xs">
          {detailLoading && <p className="text-theme-500 dark:text-theme-300">Loading...</p>}
          {detailError && <p className="text-rose-500/80">Failed to load details.</p>}
          {detail &&
            (detail.processes.length > 0 ? (
              <ul>
                {detail.processes.map((p) => (
                  <li key={p.pid}>
                    <span>{p.command}</span> — {p.cpuPercent}% CPU
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-theme-500 dark:text-theme-300">No process data available.</p>
            ))}
        </div>
      )}
    </div>
  );
}

function VmCard({ vm, cardClassName }) {
  const cpuValue = `${vm.cpuUsedCores.toFixed(2)} / ${vm.cpuTotalCores}`;
  const memValue = formatCapacity(vm.memUsedBytes, vm.memTotalBytes);
  const diskValue = formatCapacity(vm.diskUsedBytes, vm.diskTotalBytes);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);

  // Fetch-on-first-expand: the detail request only fires the first time the
  // card is opened. Subsequent toggles (close/reopen) reuse the cached
  // `detail` state rather than re-hitting the API. A failed fetch (non-ok
  // response or a rejected promise, e.g. network failure) leaves `detail`
  // null and sets `detailError` instead — the guard above then allows a
  // retry on the next close/reopen, since only a *successful* fetch should
  // ever be permanently cached.
  const toggleDetail = async () => {
    if (detailOpen) {
      setDetailOpen(false);
      return;
    }
    setDetailOpen(true);
    if (detail || detailLoading) return;
    setDetailLoading(true);
    setDetailError(false);
    try {
      const res = await fetch(`/api/proxmox/vm-detail?type=${vm.type}&node=${vm.node}&vmid=${vm.vmid}`);
      if (res.ok) {
        setDetail(await res.json());
      } else {
        setDetailError(true);
      }
    } catch {
      setDetailError(true);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className={cardClassName} data-testid="vm-card" data-status={vm.status}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-sm">{vm.name}</span>
          <p className="text-theme-500 dark:text-theme-300 text-xs font-light">
            {vm.type.toUpperCase()} &middot; {formatUptime(vm.uptimeSeconds)}
          </p>
        </div>
        <span
          className={classNames("w-2.5 h-2.5 rounded-full", STATUS_DOT_CLASS[vm.status] ?? STATUS_DOT_CLASS.stopped)}
        />
      </div>
      <div className="flex flex-row">
        <Stat value={cpuValue} label="CPU" />
        <Stat value={memValue} label="RAM" />
        <Stat value={diskValue} label="Disk" />
      </div>
      <p className="text-theme-500 dark:text-theme-300 text-xs font-light mt-2">
        {vm.ipAddress ?? "-"} &middot; {vm.macAddress ?? "-"} &middot; {vm.osName ?? "-"}
      </p>
      <button type="button" onClick={toggleDetail} className="text-xs text-theme-500 dark:text-theme-300 mt-2">
        Details
      </button>
      {detailOpen && (
        <div className="mt-2 text-xs">
          {detailLoading && <p className="text-theme-500 dark:text-theme-300">Loading...</p>}
          {detailError && <p className="text-rose-500/80">Failed to load details.</p>}
          {detail && (
            <>
              {detail.processes.length > 0 ? (
                <ul>
                  {detail.processes.map((p) => (
                    <li key={p.pid}>
                      <span>{p.command}</span> — {p.cpuPercent}% CPU
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-theme-500 dark:text-theme-300">No process data available.</p>
              )}
              <p className="text-theme-500 dark:text-theme-300 mt-1">
                Last update: {detail.lastUpdate ? new Date(detail.lastUpdate).toLocaleDateString() : "N/A"}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProxmoxVmsGroup() {
  // SettingsContext has no default value, so useContext returns undefined when
  // this renders outside _app.jsx's SettingsProvider (e.g. isolated unit
  // tests) — guard rather than destructure directly off the context result.
  const settingsContext = useContext(SettingsContext);
  const settings = settingsContext?.settings ?? {};

  // Same cardBlur handling src/components/services/item.jsx applies to its card
  // wrapper, so these cards respect the user's cardBlur setting too.
  const cardClassName = classNames(
    settings.cardBlur !== undefined && `backdrop-blur${settings.cardBlur.length ? "-" : ""}${settings.cardBlur}`,
    CARD_CLASS,
  );

  // Explicit fetcher (matches the global default in src/pages/_app.jsx) rather than
  // relying solely on the ancestor SWRConfig: the ancestor config only reaches this
  // hook when this component is actually rendered inside _app.jsx's SWRConfig
  // provider, which isolated unit tests do not render. Behavior is identical in
  // the running app either way.
  const {
    data: vms,
    error,
    mutate,
    isValidating,
  } = useSWR("/api/proxmox/vms", fetcher, {
    refreshInterval: 60000,
  });

  // Independent SWR call from the VM list above - a host-status failure must
  // never blank out the VM grid, and vice versa (see NodeStatusHeader).
  const {
    data: hostStatus,
    error: hostError,
    mutate: mutateHost,
    isValidating: hostValidating,
  } = useSWR("/api/proxmox/host", fetcher, {
    refreshInterval: 60000,
  });

  return (
    <div id="proxmox-vms-group" className="flex flex-col m-4 sm:m-8 sm:mt-4 mb-2">
      <div className="flex items-center justify-between">
        <h2 className="flex text-theme-800 dark:text-theme-300 text-xl font-medium service-group-name">Proxmox</h2>
        <button
          type="button"
          onClick={() => {
            mutate();
            mutateHost();
          }}
          disabled={isValidating || hostValidating}
          className="text-sm text-theme-500 dark:text-theme-300 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      <NodeStatusHeader status={hostStatus} error={hostError} />

      <span className="text-sm font-medium">Virtual Machines</span>

      {error && <p className="text-rose-500/80">Failed to load VM/LXC data.</p>}
      {!vms && !error && <p className="text-theme-500 dark:text-theme-300 text-sm">Loading...</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-1">
        {Array.isArray(vms) && vms.map((vm) => <VmCard key={vm.vmid} vm={vm} cardClassName={cardClassName} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/components/proxmox-vms/group.test.jsx`
Expected: PASS, all 12 tests green.

- [ ] **Step 5: Run the full suite, lint, format, and build**

Run: `pnpm test && pnpm lint && pnpm exec prettier --check "src/**/*.{js,jsx}" && pnpm build`
Expected: all green. This is the project-wide regression gate — `pnpm build` specifically must succeed.

- [ ] **Step 6: Commit**

```bash
git add src/components/proxmox-vms/group.jsx src/components/proxmox-vms/group.test.jsx
git commit -m "feat(proxmox): show host IP address and process-detail toggle"
```

---

### Task 5: Restricted SSH allowlist — add the host `ps` command (repo-only, no live deployment)

**Files:**

- Modify: `deploy/proxmox-smart-helper.sh`
- Modify: `deploy/SSH_SETUP.md`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks (final task in this plan). The command this task allowlists (`ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu`) must match Task 2's `getHostProcesses` exactly, character for character — it already does, since Task 2 already used this literal string.

**This task edits files in the repository only. Do not SSH into `lxc200` or any Proxmox host, and do not copy the modified script anywhere. That is a separate, explicitly-gated deployment step outside this plan — end your report by flagging that the live host still needs this file re-copied before `/api/proxmox/host-detail` will work end-to-end in production, and stop there.**

- [ ] **Step 1: Add the new case arm**

In `deploy/proxmox-smart-helper.sh`, insert this new `case` arm immediately after the existing `"pvs --noheadings -o pv_name,vg_name")` arm and before the existing `"pct exec "[0-9]*" -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu")` arm:

```sh
  "ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu")
    exec ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu
    ;;
```

This is an exact, parameter-free string match — no vmid, no wildcard, nothing derived from `$SSH_ORIGINAL_COMMAND` beyond the equality check itself. Every other existing `case` arm in this file is untouched.

- [ ] **Step 2: Verify the script's syntax and static analysis**

Run: `sh -n deploy/proxmox-smart-helper.sh`
Expected: no output (syntax OK).

Run: `shellcheck deploy/proxmox-smart-helper.sh`
Expected: no new warnings introduced by this change. (If `shellcheck` isn't installed, note that in your report rather than skipping verification silently — `brew install shellcheck` on macOS.)

- [ ] **Step 3: Update the documentation**

In `deploy/SSH_SETUP.md`, change the top description paragraph from:

```markdown
This key can only run `lsblk`, `smartctl -j -a <device>`, `df`, `lvs`,
`pvs`, or `pct exec <vmid> -- ...` (process listing and OS-release probe)
(each a single fixed, read-only, parameterless, path-validated, or
vmid-validated command) — nothing else — enforced server-side by a forced
command, not just by client-side discipline.
```

to:

```markdown
This key can only run `lsblk`, `smartctl -j -a <device>`, `df`, `lvs`,
`pvs`, a fixed host-level `ps` (process listing for the Proxmox host
itself), or `pct exec <vmid> -- ...` (process listing and OS-release probe
for a specific container) (each a single fixed, read-only, parameterless,
path-validated, or vmid-validated command) — nothing else — enforced
server-side by a forced command, not just by client-side discipline.
```

The existing "Upgrading from an earlier version" section already instructs re-copying `deploy/proxmox-smart-helper.sh` to the Proxmox host whenever this file changes — no change needed there, it already covers this update.

- [ ] **Step 4: Commit**

```bash
git add deploy/proxmox-smart-helper.sh deploy/SSH_SETUP.md
git commit -m "feat(deploy): allowlist host-level ps for the restricted SSH key"
```

---

## Self-Review Notes

- **Spec coverage:** IP address on the host header (Tasks 1, 3, 4), Details toggle with process list (Tasks 2, 3, 4), MAC address explicitly skipped (no task adds it), no OS-release/last-update line for the host (Task 3's `host-detail` route returns `{processes}` only, no `osReleaseName`/`lastUpdate`), VM/LXC detail flow untouched (Tasks 1-4 never modify `agentExec.js`, existing `vm-detail`, or `VmCard`'s own detail logic beyond the `within()` query-scoping needed for the new ambiguous-"Details"-text situation), restricted-SSH-script change committed but explicitly not deployed (Task 5) — all covered.
- **Type/interface consistency check:** `pickPrimaryIpAddress(interfaces)` (Task 1) is called in Task 3's route exactly as `pickPrimaryIpAddress(networkResult.value)`, matching its `interfaces: unknown` signature. `getHostProcesses(sshConfig)` (Task 2) is called in Task 3's `host-detail` route exactly as `getHostProcesses(sshConfig)`. Task 3's `GET /api/proxmox/host` response (`ipAddress` field) and `GET /api/proxmox/host-detail` response (`{processes}`) match exactly what Task 4's `NodeStatusHeader` reads (`status.ipAddress`, `detail.processes`). The `ps` command string is byte-identical between Task 2's `hostClient.js`, Task 2's test fixture, and Task 5's allowlist arm.
- **No placeholders:** every step above contains complete, runnable code — no "add appropriate tests", no "similar to Task N" elisions. The full `group.jsx`/`group.test.jsx` contents are given verbatim in Task 4 (not a diff) since the changes touch multiple non-contiguous parts of both files, including a hooks-ordering change and query-scoping fixes to three pre-existing tests.
