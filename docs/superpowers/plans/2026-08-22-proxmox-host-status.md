# Proxmox Host Status Above VMs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the Proxmox host's own live status (CPU/RAM/disk, uptime, PVE version, load average) as a header block above the existing VM/LXC card grid, inside the "Virtual Machines" section.

**Architecture:** A new pure helper (`src/utils/proxmox/nodeStatus.js`) parses the Proxmox `pve-manager` version string. A new API route (`GET /api/proxmox/host`) calls `GET /nodes` (discovers the single node's name/online-offline status and its own cpu/mem/disk/uptime numbers) then, if online, `GET /nodes/{node}/status` (adds `pveversion`/`loadavg` only — the rest of that endpoint's fields duplicate what `/nodes` already gave). A new `NodeStatusHeader` function, added to the existing `src/components/proxmox-vms/group.jsx` (not a new file — it's a header for that group, reusing its existing `Stat`/`formatCapacity`/`STATUS_DOT_CLASS` helpers), renders the result via its own independent `useSWR` call above the VM card grid.

**Tech Stack:** Next.js 16 (pages router) + React 19, SWR, Vitest + Testing Library — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-proxmox-host-status-design.md`

## Global Constraints

- **Single Proxmox node** — this deployment is a single-host homelab, not a cluster. Take the first (only) entry from `GET /nodes`; no per-node list/selector.
- **No new draggable section.** The host status is part of the existing `proxmox-vms` section's rendering, not a new entry in `KNOWN_SECTION_IDS` — no changes to `src/pages/index.jsx` or the drag-and-drop layout system.
- **Reuse the existing visual language** — the `Stat`/`STAT_CLASS`/`STATUS_DOT_CLASS`/`formatCapacity` helpers already defined in `src/components/proxmox-vms/group.jsx` for `VmCard`. No new card style.
- **Independent degradation.** The host-status fetch and the VM-list fetch are separate `useSWR` calls — a failure in one must never blank out or block the other.
- **No server-specific code** — this repo ships publicly (see `README.md`); nothing may reference this deployment's real host, IP, or credentials. Every fixture/example value in this plan is invented, not copied from a live host.
- **pnpm only** — every command uses `pnpm`, matching `package.json`'s `preinstall` guard.
- **Every new/modified module needs Vitest coverage**, and every task must leave `pnpm test`, `pnpm lint`, `pnpm exec prettier --check "src/**/*.{js,jsx}"`, **and `pnpm build`** all green. `pnpm build` is a hard requirement on this project after a prior feature shipped a build-breaking client/server bundle leak that `pnpm test`/`pnpm lint`/`pnpm exec prettier` alone didn't catch — never skip it.

---

### Task 1: `parsePveVersion` — pure version-string parser

**Files:**

- Create: `src/utils/proxmox/nodeStatus.js`
- Test: `src/utils/proxmox/nodeStatus.test.js`

**Interfaces:**

- Produces (used by Task 2):

  - `parsePveVersion(raw: unknown): string | null` — given the raw `pveversion` string Proxmox's `GET /nodes/{node}/status` returns (verified live shape: `"pve-manager/9.2.9/aa93fdab516e230b"`), extracts and returns just the middle version segment (`"9.2.9"`). Returns the input unchanged if it's a string that doesn't match that exact three-segment shape (still more useful shown as-is than hidden). Returns `null` for non-string input.

- [ ] **Step 1: Write the failing tests**

Create `src/utils/proxmox/nodeStatus.test.js`:

```js
import { describe, expect, it } from "vitest";

import { parsePveVersion } from "./nodeStatus";

describe("parsePveVersion", () => {
  it("extracts the version segment from a real pve-manager string", () => {
    expect(parsePveVersion("pve-manager/9.2.9/aa93fdab516e230b")).toBe("9.2.9");
  });

  it("extracts the version segment from an older-format string", () => {
    expect(parsePveVersion("pve-manager/8.2.4/somehash")).toBe("8.2.4");
  });

  it("returns the raw string unchanged when it doesn't match the expected shape", () => {
    expect(parsePveVersion("not-a-pve-version-string")).toBe("not-a-pve-version-string");
  });

  it("returns null for non-string input", () => {
    expect(parsePveVersion(null)).toBeNull();
    expect(parsePveVersion(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/proxmox/nodeStatus.test.js`
Expected: FAIL — `nodeStatus.js` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `src/utils/proxmox/nodeStatus.js`:

```js
// pve-manager's raw version string looks like "pve-manager/9.2.9/aa93fdab516e230b"
// (verified against a live Proxmox 9.2 host's GET /nodes/{node}/status response).
// Extract just the middle "9.2.9" segment for a readable display string, falling
// back to the raw string unchanged if it doesn't match that shape - an unexpected
// but still-present version string is more useful shown as-is than hidden.
export function parsePveVersion(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.match(/^pve-manager\/([^/]+)\//);
  return match ? match[1] : raw;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/proxmox/nodeStatus.test.js`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Lint and format**

Run: `pnpm lint && pnpm exec prettier --check "src/utils/proxmox/nodeStatus.js" "src/utils/proxmox/nodeStatus.test.js"`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/utils/proxmox/nodeStatus.js src/utils/proxmox/nodeStatus.test.js
git commit -m "feat(proxmox): add pure pve-manager version-string parser"
```

---

### Task 2: `GET /api/proxmox/host` route

**Files:**

- Create: `src/pages/api/proxmox/host/index.js`
- Test: `src/__tests__/pages/api/proxmox/host/index.test.js`

**Interfaces:**

- Consumes: `parsePveVersion` from `utils/proxmox/nodeStatus` (Task 1); `getPveConfig` from `utils/config/proxmox` (existing); `httpProxy` from `utils/proxy/http` (existing).
- Produces (used by Task 3):

  - `GET /api/proxmox/host` → `200` with:
    ```json
    {
      "status": "online",
      "cpuUsedCores": 3.2,
      "cpuTotalCores": 8,
      "memUsedBytes": 4210000000,
      "memTotalBytes": 8590000000,
      "diskUsedBytes": 21300000000,
      "diskTotalBytes": 64700000000,
      "uptimeSeconds": 93784,
      "pveVersion": "9.1.1",
      "loadAvg": [0.55, 0.61, 0.58]
    }
    ```
    or, when the node is offline (or `GET /nodes` returns no entries):
    ```json
    {
      "status": "offline",
      "cpuUsedCores": null,
      "cpuTotalCores": null,
      "memUsedBytes": null,
      "memTotalBytes": null,
      "diskUsedBytes": null,
      "diskTotalBytes": null,
      "uptimeSeconds": null,
      "pveVersion": null,
      "loadAvg": null
    }
    ```
    or, when the node is online but the second (`/nodes/{node}/status`) call fails: the same shape as the online case above, with `pveVersion: null, loadAvg: null` only (every other field still populated from the first call).
  - `500 { error: "Proxmox server configuration not found" }` when `getPveConfig()` returns falsy.
  - `500 { error: "Failed to fetch Proxmox node status" }` only when the `GET /nodes` call itself throws (bad token, network error).

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/pages/api/proxmox/host/index.test.js`:

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

  it("returns a full status object for an online node", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/nodes/proxmox/status")) return jsonResponse(200, nodeStatusBody);
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
    });
  });

  it("returns a degraded offline entry without attempting the node-status call, for an offline node", async () => {
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
    expect(httpProxy).toHaveBeenCalledTimes(1);
  });

  it("returns base stats with null version/load when the node-status call fails but the node is online", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/nodes/proxmox/status")) return networkFailure("connect ECONNREFUSED 10.0.0.9:8006");
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
    });
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/api/proxmox/host/index.test.js`
Expected: FAIL — the route module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/pages/api/proxmox/host/index.js`:

```js
import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { parsePveVersion } from "utils/proxmox/nodeStatus";
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

  try {
    const nodeStatus = await pveGet(pveConfig, `nodes/${node.node}/status`);
    return res.status(200).json({
      ...base,
      pveVersion: parsePveVersion(nodeStatus?.pveversion),
      loadAvg: Array.isArray(nodeStatus?.loadavg) ? nodeStatus.loadavg.map(Number) : null,
    });
  } catch (error) {
    logger.error("Failed to fetch Proxmox node version/load detail:", error);
    return res.status(200).json({ ...base, pveVersion: null, loadAvg: null });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/api/proxmox/host/index.test.js`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Lint and format**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/api/proxmox/host/index.js" "src/__tests__/pages/api/proxmox/host/index.test.js"`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/proxmox/host/index.js src/__tests__/pages/api/proxmox/host/index.test.js
git commit -m "feat(proxmox): add GET /api/proxmox/host route"
```

---

### Task 3: `NodeStatusHeader` — wire into `ProxmoxVmsGroup`

**Files:**

- Modify: `src/components/proxmox-vms/group.jsx`
- Modify: `src/components/proxmox-vms/group.test.jsx`

**Interfaces:**

- Consumes: `GET /api/proxmox/host` response shape from Task 2.
- Produces: nothing consumed by later tasks — this is the final task in this plan.

Before touching `group.jsx`, confirm the current baseline is green:

Run: `pnpm exec vitest run src/components/proxmox-vms/group.test.jsx`
Expected: PASS (today's regression safety net — every existing assertion must still pass after this task).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `src/components/proxmox-vms/group.test.jsx`:

```jsx
// src/components/proxmox-vms/group.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
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

  it("renders the Proxmox host status header above the VM grid", async () => {
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

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("redis-server")).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/proxmox/vm-detail?type=lxc&node=proxmox&vmid=200"),
    );
    expect(screen.getByText(/Last update: N\/A/)).toBeInTheDocument();
  });

  it("shows an explicit empty-state message when the detail fetch succeeds with zero processes", async () => {
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

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("No process data available.")).toBeInTheDocument());
    expect(screen.queryByText(/redis-server/)).not.toBeInTheDocument();
    expect(screen.queryByText("Failed to load details.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("shows a failure message when the detail fetch responds with a non-ok status", async () => {
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

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("Failed to load details.")).toBeInTheDocument());
    expect(screen.queryByText("redis-server")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/components/proxmox-vms/group.test.jsx`
Expected: FAIL — the three new host-header tests fail (`node-status-header` never appears, no second fetch happens); the pre-existing tests may also fail now that their `global.fetch` mocks branch by URL while `group.jsx` doesn't yet make a second request.

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
  if (error) {
    return <p className="text-rose-500/80 text-sm mb-2">Failed to load Proxmox host status.</p>;
  }
  if (!status) {
    return <p className="text-theme-500 dark:text-theme-300 text-sm mb-2">Loading host status...</p>;
  }

  const cpuValue = status.cpuUsedCores == null ? null : `${status.cpuUsedCores.toFixed(2)} / ${status.cpuTotalCores}`;
  const memValue = formatCapacity(status.memUsedBytes, status.memTotalBytes);
  const diskValue = formatCapacity(status.diskUsedBytes, status.diskTotalBytes);
  const loadAvgText = Array.isArray(status.loadAvg) ? status.loadAvg.map((n) => n.toFixed(2)).join(" / ") : "-";

  return (
    <div
      className="mb-2 pb-2 border-b border-theme-300/30 dark:border-theme-500/10"
      data-testid="node-status-header"
      data-status={status.status}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium">Proxmox Host</span>
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
        <h2 className="flex text-theme-800 dark:text-theme-300 text-xl font-medium service-group-name">
          Virtual Machines
        </h2>
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

      {error && <p className="text-rose-500/80">Failed to load VM/LXC data.</p>}
      {!vms && !error && <p className="text-theme-500 dark:text-theme-300 text-sm">Loading...</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {Array.isArray(vms) && vms.map((vm) => <VmCard key={vm.vmid} vm={vm} cardClassName={cardClassName} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/components/proxmox-vms/group.test.jsx`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Run the full suite, lint, format, and build**

Run: `pnpm test && pnpm lint && pnpm exec prettier --check "src/**/*.{js,jsx}" && pnpm build`
Expected: all green. This is the project-wide regression gate — `pnpm build` specifically must succeed; a failure here means something in this task pulled server-only code into the client bundle (the exact class of bug a prior feature shipped with) and must be fixed before proceeding, not deferred.

- [ ] **Step 6: Commit**

```bash
git add src/components/proxmox-vms/group.jsx src/components/proxmox-vms/group.test.jsx
git commit -m "feat(proxmox): show host status header above the VM/LXC card grid"
```

---

## Self-Review Notes

- **Spec coverage:** host status as a header above the VM grid inside the existing section (Task 3), CPU/RAM/disk/uptime/PVE-version/load-average fields (Tasks 2-3), single-node assumption with no selector (Task 2's `nodes?.[0]`), independent degradation from the VM list (Task 3's separate `useSWR` + dedicated error/loading branches), reused visual language (`Stat`/`STAT_CLASS`/`STATUS_DOT_CLASS`/`formatCapacity` — Task 3 adds zero new style constants), shared Refresh button (Task 3's `onClick` calling both `mutate()`s), no new draggable section (no changes to `src/pages/index.jsx`/`KNOWN_SECTION_IDS` anywhere in this plan) — all covered.
- **Type/interface consistency check:** `parsePveVersion(raw)`'s signature (Task 1) matches its only call site in the route (Task 2: `parsePveVersion(nodeStatus?.pveversion)`). The route's response shape (Task 2's exact JSON) matches every field `NodeStatusHeader` reads (Task 3: `status.status`, `.cpuUsedCores`, `.cpuTotalCores`, `.memUsedBytes`, `.memTotalBytes`, `.diskUsedBytes`, `.diskTotalBytes`, `.uptimeSeconds`, `.pveVersion`, `.loadAvg`) — no field name drift.
- **No placeholders:** every step above contains complete, runnable code — no "add appropriate tests", no "similar to Task N" elisions. The full `group.jsx`/`group.test.jsx` contents are given verbatim in Task 3 rather than as a diff, since the changes touch multiple non-contiguous parts of both files.
