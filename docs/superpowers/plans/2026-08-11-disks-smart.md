# Disks & SMART Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/disks` page showing every physical disk on the real Proxmox host, with auto-detected SMART health, temperature, and wear — built on top of the restricted-SSH client Foundation already shipped.

**Architecture:** A pure status-computation utility (testable without I/O) feeds a Next.js API route (`src/pages/api/disks`) that composes `lsblk` + per-disk `smartctl` calls via the existing `src/utils/ssh/smartClient.js`, which a new `/disks` page polls via SWR (matching the codebase's existing `useSWR(url)` convention) and renders using the same Tailwind classes Homepage's own service cards use, for visual consistency.

**Tech Stack:** Next.js 16 (Pages Router), React 19, Vitest, SWR (already a dependency, already globally configured with a default fetcher in `src/pages/_app.jsx`).

## Global Constraints

- Node 22, pnpm only — never npm/yarn.
- Test via `pnpm test` (Vitest, `vitest run`).
- No new dependencies needed for this plan (SWR, classnames already present).
- SSH connection details come from the `smart:` block in `config/proxmox.yaml` (commented template already in `src/skeleton/proxmox.yaml`) — never hardcode a host/user/key path in application code.
- Quick VM/CT actions and backup management are explicitly out of scope for this plan (deferred to the Backups plan).
- Filesystem-fullness (">90% used") is explicitly out of scope for this plan (deferred to the Alerting plan, via the Proxmox storage API, not SSH).
- Visual style must reuse Homepage's existing card/stat-pill Tailwind classes (see Task 4) — no new design system.

---

### Task 1: Disk health status computation

**Files:**

- Create: `src/utils/disks/health.js`
- Test: `src/utils/disks/health.test.js`

**Interfaces:**

- Produces: `computeDiskHealth(smartData) -> { status, temperature, smartPassed, reallocatedSectors, wearPercentage, mediaErrors }` where `status` is `"ok" | "warn" | "critical"`, and `smartData` is the parsed JSON object returned by `getSmartData()` (real shape, verified against a live Proxmox host — see field names below). This is a pure function — no I/O, no SSH — Task 3 imports and calls it per-disk.

Real field names this function reads (verified against real `smartctl -j -a` output on both a SATA SSD and a USB-NVMe enclosure on the actual target Proxmox host):

- `smartData.smart_status.passed` — boolean, present on both ATA and NVMe.
- `smartData.temperature.current` — number, present on both. NVMe drives additionally report `smartData.temperature.op_limit_max` and `smartData.temperature.critical_limit_max` (device-reported thresholds); ATA drives on this host do not report these two fields.
- `smartData.device.protocol` — `"ATA"` or `"NVMe"`, the reliable discriminator (the sibling `device.type` field varies by controller chipset, e.g. `"sat"` vs `"sntrealtek"` — not reliable to branch on).
- ATA only: `smartData.ata_smart_attributes.table` — array of `{ id, raw: { value } }`; SMART attribute `id === 5` is the reallocated-sector count (standard across ATA drives regardless of vendor-specific `name` string).
- NVMe only: `smartData.nvme_smart_health_information_log.percentage_used` (wear, 0-100+) and `.media_errors` (count).

- [ ] **Step 1: Write the failing tests**

```javascript
// src/utils/disks/health.test.js
import { describe, expect, it } from "vitest";

import { computeDiskHealth } from "./health";

const ataHealthy = {
  device: { protocol: "ATA" },
  smart_status: { passed: true },
  temperature: { current: 40 },
  ata_smart_attributes: { table: [{ id: 5, raw: { value: 0 } }] },
};

const nvmeHealthy = {
  device: { protocol: "NVMe" },
  smart_status: { passed: true },
  temperature: { current: 33, op_limit_max: 90, critical_limit_max: 95 },
  nvme_smart_health_information_log: { percentage_used: 0, media_errors: 0 },
};

describe("computeDiskHealth", () => {
  it("reports ok for a healthy ATA drive", () => {
    expect(computeDiskHealth(ataHealthy)).toEqual({
      status: "ok",
      temperature: 40,
      smartPassed: true,
      reallocatedSectors: 0,
      wearPercentage: null,
      mediaErrors: null,
    });
  });

  it("reports ok for a healthy NVMe drive", () => {
    expect(computeDiskHealth(nvmeHealthy)).toEqual({
      status: "ok",
      temperature: 33,
      smartPassed: true,
      reallocatedSectors: null,
      wearPercentage: 0,
      mediaErrors: 0,
    });
  });

  it("reports critical when smart_status.passed is false, overriding everything else", () => {
    const data = { ...ataHealthy, smart_status: { passed: false } };
    expect(computeDiskHealth(data).status).toBe("critical");
  });

  it("reports warn for any reallocated sector on an ATA drive", () => {
    const data = { ...ataHealthy, ata_smart_attributes: { table: [{ id: 5, raw: { value: 1 } }] } };
    expect(computeDiskHealth(data).status).toBe("warn");
    expect(computeDiskHealth(data).reallocatedSectors).toBe(1);
  });

  it("reports warn using the device's own temperature threshold when present (NVMe)", () => {
    const data = { ...nvmeHealthy, temperature: { current: 91, op_limit_max: 90, critical_limit_max: 95 } };
    expect(computeDiskHealth(data).status).toBe("warn");
  });

  it("reports critical using the device's own critical temperature threshold when present (NVMe)", () => {
    const data = { ...nvmeHealthy, temperature: { current: 96, op_limit_max: 90, critical_limit_max: 95 } };
    expect(computeDiskHealth(data).status).toBe("critical");
  });

  it("falls back to generic temperature thresholds when the device reports none (ATA)", () => {
    expect(computeDiskHealth({ ...ataHealthy, temperature: { current: 55 } }).status).toBe("warn");
    expect(computeDiskHealth({ ...ataHealthy, temperature: { current: 65 } }).status).toBe("critical");
    expect(computeDiskHealth({ ...ataHealthy, temperature: { current: 45 } }).status).toBe("ok");
  });

  it("reports warn for NVMe wear at or above 80%, critical above 95%", () => {
    expect(
      computeDiskHealth({ ...nvmeHealthy, nvme_smart_health_information_log: { percentage_used: 80, media_errors: 0 } })
        .status,
    ).toBe("warn");
    expect(
      computeDiskHealth({ ...nvmeHealthy, nvme_smart_health_information_log: { percentage_used: 96, media_errors: 0 } })
        .status,
    ).toBe("critical");
  });

  it("reports warn for any NVMe media error regardless of wear percentage", () => {
    const data = { ...nvmeHealthy, nvme_smart_health_information_log: { percentage_used: 0, media_errors: 1 } };
    expect(computeDiskHealth(data).status).toBe("warn");
    expect(computeDiskHealth(data).mediaErrors).toBe(1);
  });

  it("takes the worst of multiple simultaneous issues", () => {
    const data = {
      ...nvmeHealthy,
      smart_status: { passed: false },
      nvme_smart_health_information_log: { percentage_used: 85, media_errors: 0 },
    };
    expect(computeDiskHealth(data).status).toBe("critical");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/disks/health.test.js`
Expected: FAIL — `Cannot find module './health'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/utils/disks/health.js
const DEFAULT_TEMP_WARN_C = 50;
const DEFAULT_TEMP_CRITICAL_C = 60;
const NVME_WEAR_WARN_PERCENT = 80;
const NVME_WEAR_CRITICAL_PERCENT = 95;
const REALLOCATED_SECTOR_ATTRIBUTE_ID = 5;

const SEVERITY_ORDER = ["ok", "warn", "critical"];

export function computeDiskHealth(smartData) {
  const smartPassed = smartData?.smart_status?.passed ?? null;
  const temperature = smartData?.temperature?.current ?? null;
  const tempWarnThreshold = smartData?.temperature?.op_limit_max ?? DEFAULT_TEMP_WARN_C;
  const tempCriticalThreshold = smartData?.temperature?.critical_limit_max ?? DEFAULT_TEMP_CRITICAL_C;
  const isNvme = smartData?.device?.protocol === "NVMe";

  let reallocatedSectors = null;
  if (!isNvme) {
    const attribute = smartData?.ata_smart_attributes?.table?.find(
      (entry) => entry.id === REALLOCATED_SECTOR_ATTRIBUTE_ID,
    );
    reallocatedSectors = attribute?.raw?.value ?? null;
  }

  let wearPercentage = null;
  let mediaErrors = null;
  if (isNvme) {
    wearPercentage = smartData?.nvme_smart_health_information_log?.percentage_used ?? null;
    mediaErrors = smartData?.nvme_smart_health_information_log?.media_errors ?? null;
  }

  let status = "ok";
  const escalate = (level) => {
    if (SEVERITY_ORDER.indexOf(level) > SEVERITY_ORDER.indexOf(status)) {
      status = level;
    }
  };

  if (smartPassed === false) escalate("critical");

  if (temperature !== null) {
    if (temperature > tempCriticalThreshold) escalate("critical");
    else if (temperature > tempWarnThreshold) escalate("warn");
  }

  if (reallocatedSectors !== null && reallocatedSectors > 0) escalate("warn");

  if (wearPercentage !== null) {
    if (wearPercentage > NVME_WEAR_CRITICAL_PERCENT) escalate("critical");
    else if (wearPercentage >= NVME_WEAR_WARN_PERCENT) escalate("warn");
  }

  if (mediaErrors !== null && mediaErrors > 0) escalate("warn");

  return { status, temperature, smartPassed, reallocatedSectors, wearPercentage, mediaErrors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/disks/health.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/disks/health.js src/utils/disks/health.test.js
git commit -m "feat: add disk health status computation from SMART data"
```

---

### Task 2: SMART SSH config loader

**Files:**

- Modify: `src/utils/config/proxmox.js`
- Modify: `src/utils/config/proxmox.test.js`

**Interfaces:**

- Consumes: `getProxmoxConfig()` (already exists in this file, unchanged).
- Produces: `getSmartConfig() -> { host, username, privateKeyPath, port? } | null` — reads the `smart:` block from the same `proxmox.yaml`. Task 3's API route calls this to get the `sshConfig` object it passes to `smartClient.js`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `src/utils/config/proxmox.test.js` (inside the existing `describe` block, alongside the existing `getProxmoxConfig` import — add `getSmartConfig` to the import on line 31):

```javascript
// change line 31 from:
//   import { getProxmoxConfig } from "./proxmox";
// to:
import { getProxmoxConfig, getSmartConfig } from "./proxmox";

// add these two tests inside the existing describe("utils/config/proxmox", ...) block:
it("returns the smart block when present", () => {
  yaml.load.mockReturnValueOnce({
    pve: { url: "http://pve" },
    smart: { host: "10.0.1.9", username: "root", privateKeyPath: "./config/ssh/id_smart" },
  });

  expect(getSmartConfig()).toEqual({ host: "10.0.1.9", username: "root", privateKeyPath: "./config/ssh/id_smart" });
});

it("returns null when the smart block is absent", () => {
  yaml.load.mockReturnValueOnce({ pve: { url: "http://pve" } });

  expect(getSmartConfig()).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/config/proxmox.test.js`
Expected: FAIL — `getSmartConfig is not a function` (or similar import error).

- [ ] **Step 3: Write the implementation**

Add to `src/utils/config/proxmox.js` (after the existing `getProxmoxConfig` function):

```javascript
export function getSmartConfig() {
  const config = getProxmoxConfig();
  return config?.smart ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/config/proxmox.test.js`
Expected: PASS (3 tests total: the existing one plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/utils/config/proxmox.js src/utils/config/proxmox.test.js
git commit -m "feat: add getSmartConfig() to read the smart: block from proxmox.yaml"
```

---

### Task 3: Disks API route

**Files:**

- Create: `src/pages/api/disks/index.js`
- Test: `src/__tests__/pages/api/disks/index.test.js`

**Interfaces:**

- Consumes: `getSmartConfig()` (Task 2), `computeDiskHealth(smartData)` (Task 1), `listBlockDevices(sshConfig)` and `getSmartData(sshConfig, devicePath)` (already exist, `src/utils/ssh/smartClient.js`).
- Produces: `GET /api/disks` → `200` with a JSON array, one entry per physical disk:

  ```
  { name, device, model, size, protocol, temperature, smartPassed,
    reallocatedSectors, wearPercentage, mediaErrors, status, error }
  ```

  (`error` is `null` normally; if a single disk's SMART query fails, that disk's entry has `error: "<message>"` and every other field except `name`/`device`/`size` is `null` — one failing disk must not fail the whole response.) Task 4's page fetches this route directly.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/__tests__/pages/api/disks/index.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, listBlockDevices, getSmartData, logger } = vi.hoisted(() => ({
  getSmartConfig: vi.fn(),
  listBlockDevices: vi.fn(),
  getSmartData: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/config/proxmox", () => ({
  getSmartConfig,
}));

vi.mock("utils/ssh/smartClient", () => ({
  listBlockDevices,
  getSmartData,
}));

vi.mock("utils/logger", () => ({
  default: () => logger,
}));

import handler from "pages/api/disks/index";

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "./config/ssh/id_smart" };

const ataSmart = {
  device: { protocol: "ATA" },
  smart_status: { passed: true },
  temperature: { current: 40 },
  ata_smart_attributes: { table: [{ id: 5, raw: { value: 0 } }] },
};

describe("pages/api/disks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 500 when smart config is missing", async () => {
    getSmartConfig.mockReturnValue(null);

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "SMART SSH configuration not found" });
    expect(listBlockDevices).not.toHaveBeenCalled();
  });

  it("filters lsblk output to physical disks only and returns composed health data", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    listBlockDevices.mockResolvedValue({
      blockdevices: [
        { name: "loop0", size: "20G", type: "loop", model: null },
        {
          name: "sda",
          size: "238.5G",
          type: "disk",
          model: "MTFDDAK256TBN-1AR1ZABHA",
          children: [{ name: "sda1", size: "1G", type: "part" }],
        },
      ],
    });
    getSmartData.mockResolvedValue(ataSmart);

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(getSmartData).toHaveBeenCalledTimes(1);
    expect(getSmartData).toHaveBeenCalledWith(sshConfig, "/dev/sda");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      {
        name: "sda",
        device: "/dev/sda",
        model: "MTFDDAK256TBN-1AR1ZABHA",
        size: "238.5G",
        protocol: "ATA",
        temperature: 40,
        smartPassed: true,
        reallocatedSectors: 0,
        wearPercentage: null,
        mediaErrors: null,
        status: "ok",
        error: null,
      },
    ]);
  });

  it("returns a per-disk error without failing the whole response when one disk's SMART query fails", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    listBlockDevices.mockResolvedValue({
      blockdevices: [
        { name: "sda", size: "238.5G", type: "disk", model: "A" },
        { name: "sdb", size: "1T", type: "disk", model: "B" },
      ],
    });
    getSmartData.mockImplementation(async (_config, device) => {
      if (device === "/dev/sdb") throw new Error("boom");
      return ataSmart;
    });

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ name: "sda", status: "ok", error: null });
    expect(res.body[1]).toMatchObject({
      name: "sdb",
      device: "/dev/sdb",
      size: "1T",
      status: null,
      error: "boom",
    });
  });

  it("returns 500 when listBlockDevices itself fails", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    listBlockDevices.mockRejectedValue(new Error("ssh unreachable"));

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(logger.error).toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to enumerate block devices" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/__tests__/pages/api/disks/index.test.js`
Expected: FAIL — `Cannot find module 'pages/api/disks/index'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/pages/api/disks/index.js
import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { computeDiskHealth } from "utils/disks/health";
import { getSmartData, listBlockDevices } from "utils/ssh/smartClient";

const logger = createLogger("disksApi");

async function buildDiskEntry(sshConfig, device) {
  const base = { name: device.name, device: `/dev/${device.name}`, model: device.model, size: device.size };

  try {
    const smartData = await getSmartData(sshConfig, base.device);
    const health = computeDiskHealth(smartData);
    return {
      ...base,
      protocol: smartData?.device?.protocol ?? null,
      temperature: health.temperature,
      smartPassed: health.smartPassed,
      reallocatedSectors: health.reallocatedSectors,
      wearPercentage: health.wearPercentage,
      mediaErrors: health.mediaErrors,
      status: health.status,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      protocol: null,
      temperature: null,
      smartPassed: null,
      reallocatedSectors: null,
      wearPercentage: null,
      mediaErrors: null,
      status: null,
      error: error.message,
    };
  }
}

export default async function handler(req, res) {
  const sshConfig = getSmartConfig();

  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let blockDevices;
  try {
    ({ blockdevices: blockDevices } = await listBlockDevices(sshConfig));
  } catch (error) {
    logger.error("Failed to enumerate block devices:", error);
    return res.status(500).json({ error: "Failed to enumerate block devices" });
  }

  const physicalDisks = (blockDevices ?? []).filter((device) => device.type === "disk");
  const entries = await Promise.all(physicalDisks.map((device) => buildDiskEntry(sshConfig, device)));

  return res.status(200).json(entries);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/__tests__/pages/api/disks/index.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/disks/index.js src/__tests__/pages/api/disks/index.test.js
git commit -m "feat: add /api/disks route composing lsblk + per-disk SMART health"
```

---

### Task 4: Disks page UI + navigation link

**Files:**

- Create: `src/pages/disks.jsx`
- Test: `src/__tests__/pages/disks.test.jsx`
- Modify: `src/pages/index.jsx` (add a nav link to `/disks`)

**Interfaces:**

- Consumes: `GET /api/disks` (Task 3) via `useSWR("/api/disks", { refreshInterval: 60000 })` — the codebase's existing global `SWRConfig` (`src/pages/_app.jsx`) already provides the default `fetch(...).then(r => r.json())` fetcher, so no custom fetcher is needed here (same pattern as `src/components/services/status.jsx`).
- Produces: the `/disks` route, and a link to it from the main dashboard footer.

- [ ] **Step 1: Write the failing test**

```javascript
// src/__tests__/pages/disks.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import DisksPage from "pages/disks";

function renderWithSWR(ui) {
  // disable SWR's dedupe/cache between tests so each test's mocked fetch is used fresh
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

describe("pages/disks", () => {
  it("renders a card per disk with the correct status color", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve([
          {
            name: "sda",
            device: "/dev/sda",
            model: "MTFDDAK256TBN-1AR1ZABHA",
            size: "238.5G",
            protocol: "ATA",
            temperature: 40,
            smartPassed: true,
            reallocatedSectors: 0,
            wearPercentage: null,
            mediaErrors: null,
            status: "ok",
            error: null,
          },
          {
            name: "sdc",
            device: "/dev/sdc",
            model: "Vi3000",
            size: "1.9T",
            protocol: "NVMe",
            temperature: 91,
            smartPassed: true,
            reallocatedSectors: null,
            wearPercentage: 10,
            mediaErrors: 0,
            status: "warn",
            error: null,
          },
        ]),
    });

    renderWithSWR(<DisksPage />);

    await waitFor(() => expect(screen.getByText("sda")).toBeInTheDocument());
    expect(screen.getByText("sdc")).toBeInTheDocument();
    expect(screen.getByText("40°C")).toBeInTheDocument();
    expect(screen.getByText("91°C")).toBeInTheDocument();

    const okCard = screen.getByText("sda").closest('[data-testid="disk-card"]');
    const warnCard = screen.getByText("sdc").closest('[data-testid="disk-card"]');
    expect(okCard).toHaveAttribute("data-status", "ok");
    expect(warnCard).toHaveAttribute("data-status", "warn");
  });

  it("shows the per-disk error message when a disk failed to query", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve([
          {
            name: "sdb",
            device: "/dev/sdb",
            model: "B",
            size: "1T",
            protocol: null,
            temperature: null,
            smartPassed: null,
            reallocatedSectors: null,
            wearPercentage: null,
            mediaErrors: null,
            status: null,
            error: "boom",
          },
        ]),
    });

    renderWithSWR(<DisksPage />);

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/__tests__/pages/disks.test.jsx`
Expected: FAIL — `Cannot find module 'pages/disks'`.

- [ ] **Step 3: Write the implementation**

```jsx
// src/pages/disks.jsx
import classNames from "classnames";
import Head from "next/head";
import Link from "next/link";
import useSWR from "swr";

const STATUS_DOT_CLASS = {
  ok: "bg-emerald-500",
  warn: "bg-orange-400",
  critical: "bg-rose-500",
};

// Same stat-pill classes src/components/services/widget/block.jsx uses, so
// disk cards read as native Homepage UI rather than a bolted-on page.
const STAT_CLASS =
  "bg-theme-200/50 dark:bg-theme-900/20 rounded-sm m-1 flex-1 flex flex-col items-center justify-center text-center p-1";

// Same card wrapper classes src/components/services/item.jsx uses.
const CARD_CLASS =
  "transition-all mb-2 p-3 rounded-md font-medium text-theme-700 dark:text-theme-200 shadow-md shadow-theme-900/10 dark:shadow-theme-900/20 bg-theme-100/20 dark:bg-white/5 relative overflow-clip";

function Stat({ value, label }) {
  return (
    <div className={STAT_CLASS}>
      <div className="font-thin text-sm">{value === null || value === undefined ? "-" : value}</div>
      <div className="font-bold text-xs uppercase">{label}</div>
    </div>
  );
}

function DiskCard({ disk }) {
  if (disk.error) {
    return (
      <div className={CARD_CLASS} data-testid="disk-card" data-status="error">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm">{disk.name}</span>
          <span className={classNames("w-2.5 h-2.5 rounded-full", STATUS_DOT_CLASS.critical)} />
        </div>
        <p className="text-rose-500/80 text-xs">{disk.error}</p>
      </div>
    );
  }

  const wearOrReallocated = disk.wearPercentage !== null ? `${disk.wearPercentage}%` : (disk.reallocatedSectors ?? "-");

  return (
    <div className={CARD_CLASS} data-testid="disk-card" data-status={disk.status}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-sm">{disk.name}</span>
          <p className="text-theme-500 dark:text-theme-300 text-xs font-light">
            {disk.model} &middot; {disk.size}
          </p>
        </div>
        <span className={classNames("w-2.5 h-2.5 rounded-full", STATUS_DOT_CLASS[disk.status])} />
      </div>
      <div className="flex flex-row">
        <Stat value={disk.temperature !== null ? `${disk.temperature}°C` : null} label="Temp" />
        <Stat value={disk.smartPassed === null ? null : disk.smartPassed ? "PASSED" : "FAILED"} label="SMART" />
        <Stat value={wearOrReallocated} label={disk.wearPercentage !== null ? "Wear" : "Realloc"} />
      </div>
    </div>
  );
}

export default function DisksPage() {
  const { data: disks, error } = useSWR("/api/disks", { refreshInterval: 60000 });

  return (
    <>
      <Head>
        <title>Disks &amp; SMART</title>
      </Head>
      <div className="container relative m-auto flex flex-col justify-start z-10 min-h-screen p-4">
        <div className="flex items-center justify-between mb-4">
          <Link href="/" className="text-sm text-theme-500 dark:text-theme-300">
            &larr; Dashboard
          </Link>
          <button type="button" onClick={() => window.location.reload()} className="text-sm">
            Refresh
          </button>
        </div>

        {error && <p className="text-rose-500/80">Failed to load disk data.</p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {(disks ?? []).map((disk) => (
            <DiskCard key={disk.name} disk={disk} />
          ))}
        </div>
      </div>
    </>
  );
}
```

Modify `src/pages/index.jsx`: add a link to `/disks` in the footer row, next to the existing style toggles (find this block — it's the `<div id="style" ...>` row shown around line 505-510):

```jsx
// find:
        <div id="style" className="flex w-full justify-end">
          {!settings?.color && <ColorToggle />}
          <Revalidate />
          <SignOut />
          {!settings.theme && <ThemeToggle />}
        </div>

// replace with:
        <div id="style" className="flex w-full justify-end items-center">
          <Link href="/disks" className="text-sm mr-4 text-theme-500 dark:text-theme-300">
            Disks
          </Link>
          {!settings?.color && <ColorToggle />}
          <Revalidate />
          <SignOut />
          {!settings.theme && <ThemeToggle />}
        </div>
```

`src/pages/index.jsx` does not currently import `next/link` (verified — its import block has `next/dynamic`, `next/head`, `next/router`, `next/script`, but not `next/link`). Add this line to its import block, alphabetically among the other `next/*` imports (after `import Head from "next/head";`, before `import { useRouter } from "next/router";`):

```javascript
import Link from "next/link";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/__tests__/pages/disks.test.jsx`
Expected: PASS (2 tests).

Run the full suite once to confirm the `index.jsx` edit didn't break its existing tests:
Run: `pnpm test src/__tests__/pages/index.test.jsx`
Expected: PASS (no regressions from adding the Link).

- [ ] **Step 5: Commit**

```bash
git add src/pages/disks.jsx src/__tests__/pages/disks.test.jsx src/pages/index.jsx
git commit -m "feat: add /disks page with per-disk SMART health cards, link from dashboard"
```

---

### Task 5: Live verification against the real Proxmox host

**Files:** none (verification only, plus a config change on the deployed host — not in this git repo)

**Interfaces:**

- Consumes: everything from Tasks 1-4, deployed via the existing `docker-compose.yml` / Dockge setup from the Foundation plan.

- [ ] **Step 1: Deploy the built code to the real host**

```bash
ssh lxc200 'cd /opt/stacks/your-server-board && git pull origin dev && docker compose up -d --build'
```

- [ ] **Step 2: Add the `smart:` block to the real `config/proxmox.yaml` on lxc200**

The private key already exists there from Foundation (`config/ssh/id_smart`), and the restricted `authorized_keys` entry on the real Proxmox host is already installed and verified working (Foundation Task 3). This step just wires the app to use it — uncomment and fill in the `smart:` block:

```bash
ssh lxc200 'cat /opt/stacks/your-server-board/config/proxmox.yaml'
```

Edit that file on lxc200 (via `ssh lxc200` + an editor or heredoc) so it contains, in addition to the existing `pve:` block:

```yaml
smart:
  host: 10.0.1.9
  username: root
  privateKeyPath: ./config/ssh/id_smart
```

- [ ] **Step 3: Restart and verify the API route against real data**

```bash
ssh lxc200 'cd /opt/stacks/your-server-board && docker compose restart'
curl -s http://10.0.1.104:3050/api/disks
```

Expected: a JSON array with (at least) `sda` and `sdc` entries, real temperatures, `"status": "ok"` for both (both disks were confirmed healthy during Foundation's research), no `error` fields populated.

- [ ] **Step 4: Verify the page renders correctly**

Open `http://10.0.1.104:3050/disks` in a browser. Expected: cards for `sda` and `sdc` with green status dots, real temperature/model/size values, matching the API response from Step 3. Confirm the "Disks" link added to the main dashboard's footer (Step 4 of Task 4) navigates here correctly.

- [ ] **Step 5: Update README status**

Edit `README.md`'s Status section: move "Disks & SMART health monitoring" from the "Not yet implemented" list to a new bullet describing it as live (mirroring how the Foundation plan's Status section was written), and remove it from the `docs/superpowers/plans/` follow-up list.

```bash
git add README.md
git commit -m "docs: mark Disks & SMART as live in README status"
git push origin dev
```
