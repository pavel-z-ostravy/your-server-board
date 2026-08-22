# VM/LXC Detail — Basic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's aggregate "Proxmox VE" widget (cluster-wide totals only) with a per-VM/per-LXC card group showing real used/total CPU, RAM, and disk, plus IP/MAC/OS identity — using only the existing Proxmox API token (no new SSH/exec capability).

**Architecture:** One composed API route (`/api/proxmox/vms`, no query params — auto-discovers everything) fetches `cluster/resources?type=vm` once for basic stats, then per-VM/LXC fetches `config` (for the MAC address and, for LXC, the OS family) and either `/lxc/{vmid}/interfaces` (LXC) or the QEMU guest agent's `network-get-interfaces`/`get-osinfo` (VM, degrades gracefully when the agent isn't running). A new `ProxmoxVmsGroup` component, architecturally identical to `DisksGroup` (own SWR fetch, own card grid, no props), renders the result and replaces the stock `proxmox` widget on the dashboard.

**Tech Stack:** Next.js 16 (Pages Router), React 19, Vitest, the existing `httpProxy` utility (already used by `src/pages/api/proxmox/stats/[...service].js`), Proxmox REST API (existing token from `config/proxmox.yaml`'s `pve:` block).

## Global Constraints

- Node 22, pnpm only — never npm/yarn.
- Test via `pnpm test` (Vitest, `vitest run`).
- **No new SSH capability and no new exec-shaped capability of any kind.** Every API call this plan adds is a read-only Proxmox REST GET against data the existing `pve:` token can already reach (status, config, network interfaces, and the QEMU guest agent's structured `network-get-interfaces`/`get-osinfo` RPCs — NOT the guest agent's `exec` RPC, which runs an arbitrary command in the guest and is explicitly Plan 4's scope, not this plan's).
- Real per-guest disk usage for QEMU VMs (via the guest agent's `get-fsinfo`) is an explicit non-goal of this plan — see "Deviation from Design Spec" below. VM cards show allocated disk size only (`maxdisk`); LXC cards show real used/total (Proxmox reports this natively for containers, no agent needed).
- No i18n (`useTranslation`/`t(...)`) in the new component — matches the precedent already set by `src/components/disks/group.jsx` (plain English strings throughout, unreviewed/unflagged across two full review cycles). Introducing i18n now would make the two sibling dashboard-section components inconsistent with each other; this plan keeps that consistency rather than "fixing" it unprompted.
- Reuse `src/components/disks/group.jsx`'s established visual patterns exactly: the `<h2>` heading class, `STAT_CLASS`, `CARD_CLASS`, the `cardBlur` handling, the `Stat` null-placeholder convention (`"-"` for missing data). No new CSS classes.
- Do not modify `src/pages/api/proxmox/stats/[...service].js`, `src/widgets/proxmox/*`, or `src/widgets/proxmoxvm/*` — see "Pre-existing issues discovered" below for why, and why fixing them is explicitly out of scope.

## Deviation from Design Spec

`docs/superpowers/specs/2026-08-11-vm-lxc-disk-widgets-design.md` listed QEMU's `get-fsinfo` (real in-guest disk usage) as an open item: "whether it's worth the extra API round-trip... or whether allocated-size-only is an acceptable first cut." Live-checked `get-fsinfo` against the real VM 100 (Home Assistant OS) while planning this task — it returns a **list of every mounted filesystem inside the guest** (5 entries for VM 100: `/tmp` on `zram2`, `/mnt/data` on `sda8`, `/mnt/overlay` on `sda7`, `/mnt/boot` on `sda1`, and a read-only `/` on `sda5`), not one used/total number. Turning that into a single "disk used/total" figure requires the same kind of aggregation-across-multiple-sources work Plan 2 did for physical-disk capacity (deciding which mountpoints count, avoiding double-counting overlapping views) — a second, separate aggregation problem, not a two-line addition. This plan explicitly defers it: VM cards show `maxdisk` (allocated) only. A future plan can add real VM disk usage the same way Plan 2 added real physical-disk usage, once it's worth a dedicated design pass.

## Pre-existing issues discovered (not fixed by this plan — flagging for awareness)

Live-checking the existing Proxmox integration while planning this task turned up two things already true on `dev`, unrelated to anything this plan changes:

1. **`src/pages/api/proxmox/stats/[...service].js` cannot actually reach this Proxmox host's config.** It resolves credentials via `proxmoxConfig[node]` (a per-node-named key) or a flat legacy `url`/`token`/`secret` at the config root. The real config (`config/proxmox.yaml`'s `pve:` block — confirmed by reading the live file on lxc200) is neither: the block is named `pve`, not `proxmox` (the real node's actual name, confirmed via `GET /nodes`), and it's nested under `pve:`, not flat. Calling this route with the real node name would 400.
2. **Correction: the route is NOT dead code.** An earlier draft of this section claimed `src/widgets/proxmoxvm/component.jsx` was "the only caller" of that route and that the pairing was unreachable. That's wrong — `src/components/services/proxmox-status.jsx` also calls this same route (`GET /api/proxmox/stats/${service.proxmoxNode}/${service.proxmoxVMID}`), and it IS live: `src/components/services/item.jsx` imports it and renders it for any service configured with `proxmoxNode`/`proxmoxVMID` in a user's `services.yaml`, powering the per-service status badge/dot. `src/widgets/proxmoxvm/component.jsx` is the one that remains genuinely unregistered/unreachable (confirmed via grep, it doesn't appear in `src/widgets/widgets.js`'s widget-type registry) — but the route itself has a real, user-facing caller.

Net effect: the route's config-resolution bug is still real and still pre-existing, and it still breaks for anyone relying on `proxmoxNode`/`proxmoxVMID` service badges against a `pve:`-nested config like this fork's. This plan does not touch the route, `proxmox-status.jsx`, or `item.jsx` — it adds a fresh, correct config accessor (`getPveConfig()`, mirroring the already-correct `getSmartConfig()` pattern) and a new route, rather than repairing the existing one outside its scope. Worth a decision from Pavel later: fix the existing route's config resolution (it has a live caller and is worth fixing), and separately, whether to delete or register the genuinely-dead `src/widgets/proxmoxvm/component.jsx` widget.

## Real Data Verified During Planning

Checked directly against the real Proxmox API (`https://10.0.1.9:8006`, token from `config/proxmox.yaml`'s live `pve:` block) before writing this plan:

- **Real node name is `proxmox`** (`GET /nodes` → `"node": "proxmox"`), not "pve" — `pve:` is just this fork's arbitrary label for the credentials block.
- **`GET /cluster/resources?type=vm`** returns all three real guests in ONE call — confirmed this eliminates the need for per-VM `status/current` calls the design spec sketched:
  ```json
  [
    {
      "id": "qemu/100",
      "vmid": 100,
      "node": "proxmox",
      "type": "qemu",
      "name": "homeassistant",
      "status": "running",
      "template": 0,
      "cpu": 0.0625912395730508,
      "maxcpu": 1,
      "mem": 3088969728,
      "maxmem": 3221225472,
      "disk": 0,
      "maxdisk": 34359738368,
      "uptime": 92576
    },
    {
      "id": "lxc/200",
      "vmid": 200,
      "node": "proxmox",
      "type": "lxc",
      "name": "lxc-homelab",
      "status": "running",
      "template": 0,
      "cpu": 0.256998899633673,
      "maxcpu": 4,
      "mem": 4531613696,
      "maxmem": 12582912000,
      "disk": 61370929152,
      "maxdisk": 84358758400,
      "uptime": 135548
    },
    {
      "id": "lxc/202",
      "vmid": 202,
      "node": "proxmox",
      "type": "lxc",
      "name": "lxc-influxdb",
      "status": "running",
      "template": 0,
      "cpu": 0.00303185839164451,
      "maxcpu": 2,
      "mem": 126689280,
      "maxmem": 2147483648,
      "disk": 888872960,
      "maxdisk": 16729894912,
      "uptime": 862972
    }
  ]
  ```
  Confirms: QEMU's `disk` is always `0` (never a real figure without the guest agent — matches the Deviation section above); LXC's `disk` is real, non-zero, independently sourced (Proxmox reads it from the container's own rootfs, a different measurement than Plan 2's host-side thin-pool percentage — no conflict, just a different, already-correct number Proxmox hands over for free).
- **`GET /nodes/proxmox/qemu/100/config`** → `net0: "virtio=BC:24:11:85:3A:8F,bridge=vmbr0"`. The MAC is the value of the FIRST `key=value` pair (before the first comma) — the key name (`virtio` here) varies by configured NIC model (`e1000`, `virtio`, etc.), so the parser must not hardcode the key name, only the position.
- **`GET /nodes/proxmox/lxc/200/config`** → `net0: "name=eth0,bridge=vmbr0,firewall=1,hwaddr=BC:24:11:AE:7C:89,ip=dhcp,type=veth"`, `ostype: "debian"`. LXC's MAC is the value of an explicit `hwaddr=` key, found anywhere in the comma-separated list (not necessarily first) — a **different extraction pattern than QEMU's**, not reusable as one shared parser.
- **`GET /nodes/proxmox/lxc/200/interfaces`** (no agent, no exec — native to Proxmox for containers) returns EVERY interface in the container's network namespace, not just its primary one — for `lxc-homelab` specifically (a Docker host container) this is **26 entries**: loopback, several `br-*`/`docker0` bridges, and ~20 `veth*` pairs from the containers running inside it. The only reliable way to find "this container's actual LAN IP" is to correlate by MAC against `net0`'s `hwaddr` — confirmed the entry with `"hardware-address": "bc:24:11:ae:7c:89"` is the right one, `inet: "10.0.1.104/24"`. **The MAC comparison must be case-insensitive**: config's `hwaddr` is uppercase (`BC:24:11:AE:7C:89`), the live `/interfaces` response is lowercase (`bc:24:11:ae:7c:89`). Each interface entry's `ip-addresses` array uses `"ip-address-type": "inet"` for IPv4, `"inet6"` for IPv6.
- **`GET /nodes/proxmox/qemu/100/agent/ping`, `.../agent/network-get-interfaces`, `.../agent/get-osinfo`** all confirmed reachable and working — **as `GET` requests, not `POST`** (the design spec didn't specify a method; `POST` returns "Method ... not implemented", `GET` works). `network-get-interfaces` has the same "many interfaces, correlate by MAC" shape as LXC's `/interfaces`, but with real, verified differences from it: no `hwaddr` alias field (only `hardware-address`), and `"ip-address-type"` uses `"ipv4"`/`"ipv6"` — **not** `"inet"`/`"inet6"`. `get-osinfo` returns one clean, structured object: `{"pretty-name": "Home Assistant OS 18.2", "name": "Home Assistant OS", "version-id": "18.2", ...}` — `pretty-name` is exactly the human-readable OS name this plan needs, no parsing required.

## File Structure

- Modify: `src/utils/config/proxmox.js` — add `getPveConfig()`.
- Modify: `src/utils/config/proxmox.test.js` — test it.
- Create: `src/utils/proxmox/vmNetwork.js` — pure MAC-extraction (QEMU/LXC, two different formats) and MAC-to-IPv4 correlation (one shared function, parameterized by the verified `inet`-vs-`ipv4` type-string difference).
- Create: `src/utils/proxmox/vmNetwork.test.js`.
- Create: `src/utils/proxmox/uptime.js` — pure `formatUptime(seconds)`.
- Create: `src/utils/proxmox/uptime.test.js`.
- Create: `src/pages/api/proxmox/vms/index.js` — the composed route.
- Create: `src/__tests__/pages/api/proxmox/vms/index.test.js`.
- Create: `src/components/proxmox-vms/group.jsx` — `ProxmoxVmsGroup`, mirrors `disks/group.jsx`.
- Create: `src/components/proxmox-vms/group.test.jsx`.
- Modify: `src/pages/index.jsx` — render `<ProxmoxVmsGroup />` alongside `<DisksGroup />`.

---

### Task 1: Proxmox config accessor + uptime formatter

**Files:**

- Modify: `src/utils/config/proxmox.js`
- Modify: `src/utils/config/proxmox.test.js`
- Create: `src/utils/proxmox/uptime.js`
- Test: `src/utils/proxmox/uptime.test.js`

**Interfaces:**

- Produces: `export function getPveConfig()` in `src/utils/config/proxmox.js` → returns `config?.pve ?? null`, mirroring `getSmartConfig()` exactly (same file, same pattern, do not touch `getSmartConfig()` or `getProxmoxConfig()` themselves).
- Produces: `export function formatUptime(seconds)` in `src/utils/proxmox/uptime.js` → returns a short human string, two units max: `"Xd Yh"` when `seconds >= 86400`, `"Xh Ym"` when `>= 3600`, `"Xm"` when `>= 60`, `"Xs"` otherwise. `0` → `"0m"`.

- [ ] **Step 1: Write the failing tests**

Read `src/utils/config/proxmox.js` and `src/utils/config/proxmox.test.js` first to confirm the current exact structure (they may have shifted since this plan was written). Add to `proxmox.test.js`, inside the existing `describe` block, alongside the existing `getSmartConfig` tests:

```javascript
it("returns the pve block", () => {
  yaml.load.mockReturnValueOnce({ pve: { url: "https://10.0.1.9:8006", token: "t", secret: "s" } });

  expect(getPveConfig()).toEqual({ url: "https://10.0.1.9:8006", token: "t", secret: "s" });
});

it("returns null when the pve block is absent", () => {
  yaml.load.mockReturnValueOnce({});

  expect(getPveConfig()).toBeNull();
});
```

Add `getPveConfig` to the existing import line: `import { getPveConfig, getProxmoxConfig, getSmartConfig } from "./proxmox";`

```javascript
// src/utils/proxmox/uptime.test.js
import { describe, expect, it } from "vitest";

import { formatUptime } from "./uptime";

describe("formatUptime", () => {
  it("formats seconds under a minute", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats zero as 0m", () => {
    expect(formatUptime(0)).toBe("0m");
  });

  it("formats minutes", () => {
    expect(formatUptime(125)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(3661)).toBe("1h 1m");
  });

  it("formats days and hours — real VM 100 uptime", () => {
    // 92576s = 1 day (86400s) + 6176s remainder = 1h 42m 56s
    expect(formatUptime(92576)).toBe("1d 1h");
  });

  it("formats days and hours — real LXC 200 uptime", () => {
    // 135548s = 1 day (86400s) + 49148s remainder = 13h 39m 8s
    expect(formatUptime(135548)).toBe("1d 13h");
  });

  it("formats days and hours — real LXC 202 uptime (9+ days)", () => {
    // 862972s = 9 days (777600s) + 85372s remainder = 23h 42m 52s
    expect(formatUptime(862972)).toBe("9d 23h");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/config/proxmox.test.js src/utils/proxmox/uptime.test.js`
Expected: FAIL — `getPveConfig` is not exported, `Cannot find module './uptime'`.

- [ ] **Step 3: Write the implementation**

Add to `src/utils/config/proxmox.js`, after the existing `getSmartConfig` export:

```javascript
export function getPveConfig() {
  const config = getProxmoxConfig();
  return config?.pve ?? null;
}
```

```javascript
// src/utils/proxmox/uptime.js
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatUptime(seconds) {
  if (seconds >= DAY) {
    const days = Math.floor(seconds / DAY);
    const hours = Math.floor((seconds % DAY) / HOUR);
    return `${days}d ${hours}h`;
  }
  if (seconds >= HOUR) {
    const hours = Math.floor(seconds / HOUR);
    const minutes = Math.floor((seconds % HOUR) / MINUTE);
    return `${hours}h ${minutes}m`;
  }
  if (seconds >= MINUTE) {
    const minutes = Math.floor(seconds / MINUTE);
    return `${minutes}m`;
  }
  if (seconds === 0) {
    return "0m";
  }
  return `${seconds}s`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/config/proxmox.test.js src/utils/proxmox/uptime.test.js`
Expected: PASS (2 new config tests, 7 new uptime tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/config/proxmox.js src/utils/config/proxmox.test.js src/utils/proxmox/uptime.js src/utils/proxmox/uptime.test.js
git commit -m "feat: add getPveConfig accessor and formatUptime helper"
```

---

### Task 2: VM/LXC network parsing (MAC extraction + IP correlation)

**Files:**

- Create: `src/utils/proxmox/vmNetwork.js`
- Test: `src/utils/proxmox/vmNetwork.test.js`

**Interfaces:**

- Consumes: nothing from Task 1 (pure, independent).
- Produces:

  - `export function extractMacFromQemuNet0(net0)` → given a QEMU `net0` config string (e.g. `"virtio=BC:24:11:85:3A:8F,bridge=vmbr0"`), returns the MAC (the value of the first `key=value` pair) or `null` if `net0` is falsy or has no recognizable MAC.
  - `export function extractMacFromLxcNet0(net0)` → given an LXC `net0` config string (e.g. `"name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AE:7C:89,..."`), returns the value of the `hwaddr=` key or `null`.
  - `export function findIPv4ByMac(interfaces, mac, ipv4Type)` → given an array of interface objects (each with `"hardware-address"` and `"ip-addresses"`), a MAC to match, and the exact string used for IPv4 in this array's `"ip-address-type"` field (`"inet"` for LXC, `"ipv4"` for the QEMU guest agent — the two real, verified shapes are different, so the caller supplies which one applies), returns the matching IPv4 address string or `null`. Matching is case-insensitive on the MAC.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/utils/proxmox/vmNetwork.test.js
import { describe, expect, it } from "vitest";

import { extractMacFromLxcNet0, extractMacFromQemuNet0, findIPv4ByMac } from "./vmNetwork";

describe("extractMacFromQemuNet0", () => {
  it("extracts the MAC from a real QEMU net0 string (virtio model)", () => {
    expect(extractMacFromQemuNet0("virtio=BC:24:11:85:3A:8F,bridge=vmbr0")).toBe("BC:24:11:85:3A:8F");
  });

  it("extracts the MAC regardless of NIC model key name", () => {
    expect(extractMacFromQemuNet0("e1000=AA:BB:CC:DD:EE:FF,bridge=vmbr1,firewall=1")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("returns null for a falsy net0", () => {
    expect(extractMacFromQemuNet0(undefined)).toBeNull();
    expect(extractMacFromQemuNet0(null)).toBeNull();
    expect(extractMacFromQemuNet0("")).toBeNull();
  });

  it("returns null when no MAC-shaped value is present", () => {
    expect(extractMacFromQemuNet0("bridge=vmbr0,firewall=1")).toBeNull();
  });
});

describe("extractMacFromLxcNet0", () => {
  it("extracts the MAC from a real LXC net0 string (hwaddr not first)", () => {
    expect(extractMacFromLxcNet0("name=eth0,bridge=vmbr0,firewall=1,hwaddr=BC:24:11:AE:7C:89,ip=dhcp,type=veth")).toBe(
      "BC:24:11:AE:7C:89",
    );
  });

  it("returns null for a falsy net0", () => {
    expect(extractMacFromLxcNet0(undefined)).toBeNull();
  });

  it("returns null when no hwaddr key is present", () => {
    expect(extractMacFromLxcNet0("name=eth0,bridge=vmbr0,ip=dhcp,type=veth")).toBeNull();
  });
});

describe("findIPv4ByMac", () => {
  // Trimmed real shape from GET /nodes/proxmox/lxc/200/interfaces — a
  // container running Docker has many veth/br-* interfaces; only the one
  // matching net0's hwaddr is the container's actual LAN address.
  const lxcInterfaces = [
    {
      name: "lo",
      hwaddr: "00:00:00:00:00:00",
      "hardware-address": "00:00:00:00:00:00",
      inet: "127.0.0.1/8",
      "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "inet", prefix: "8" }],
    },
    {
      name: "eth0",
      hwaddr: "bc:24:11:ae:7c:89",
      "hardware-address": "bc:24:11:ae:7c:89",
      inet: "10.0.1.104/24",
      "ip-addresses": [
        { "ip-address": "10.0.1.104", "ip-address-type": "inet", prefix: "24" },
        { "ip-address": "fe80::be24:11ff:feae:7c89", "ip-address-type": "inet6", prefix: "64" },
      ],
    },
    {
      name: "docker0",
      hwaddr: "9e:1e:12:99:72:43",
      "hardware-address": "9e:1e:12:99:72:43",
      "ip-addresses": [{ "ip-address": "172.17.0.1", "ip-address-type": "inet", prefix: "16" }],
    },
  ];

  it("finds the LXC IPv4 by case-insensitive MAC match against the config's uppercase hwaddr", () => {
    expect(findIPv4ByMac(lxcInterfaces, "BC:24:11:AE:7C:89", "inet")).toBe("10.0.1.104");
  });

  it("returns null when no interface matches the MAC", () => {
    expect(findIPv4ByMac(lxcInterfaces, "00:00:00:00:00:99", "inet")).toBeNull();
  });

  it("returns null when mac is null", () => {
    expect(findIPv4ByMac(lxcInterfaces, null, "inet")).toBeNull();
  });

  // Trimmed real shape from GET /nodes/proxmox/qemu/100/agent/network-get-interfaces
  // — verified different from the LXC shape: no "hwaddr" alias, and
  // "ip-address-type" uses "ipv4"/"ipv6", not "inet"/"inet6".
  const qemuAgentInterfaces = [
    {
      name: "lo",
      "hardware-address": "00:00:00:00:00:00",
      "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4", prefix: 8 }],
    },
    {
      name: "enp0s18",
      "hardware-address": "bc:24:11:85:3a:8f",
      "ip-addresses": [
        { "ip-address": "10.0.1.22", "ip-address-type": "ipv4", prefix: 24 },
        { "ip-address": "fe80::b8e5:9835:5708:de6a", "ip-address-type": "ipv6", prefix: 64 },
      ],
    },
  ];

  it("finds the QEMU IPv4 via the agent's different type-string ('ipv4', not 'inet')", () => {
    expect(findIPv4ByMac(qemuAgentInterfaces, "BC:24:11:85:3A:8F", "ipv4")).toBe("10.0.1.22");
  });

  it("returns null when interfaces is empty or undefined", () => {
    expect(findIPv4ByMac([], "BC:24:11:85:3A:8F", "ipv4")).toBeNull();
    expect(findIPv4ByMac(undefined, "BC:24:11:85:3A:8F", "ipv4")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/proxmox/vmNetwork.test.js`
Expected: FAIL — `Cannot find module './vmNetwork'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/utils/proxmox/vmNetwork.js

// QEMU's net0 config string has the MAC as the value of the FIRST
// key=value pair, e.g. "virtio=BC:24:11:85:3A:8F,bridge=vmbr0" — the key
// name is the configured NIC model (virtio, e1000, ...) and varies, so this
// only relies on position, never the key name itself.
export function extractMacFromQemuNet0(net0) {
  if (!net0) return null;
  const firstPair = net0.split(",")[0];
  const value = firstPair.split("=")[1];
  if (!value || !/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(value)) return null;
  return value;
}

// LXC's net0 config string has an explicit hwaddr=<MAC> key, found anywhere
// in the comma-separated list — a different shape than QEMU's, not
// interchangeable with extractMacFromQemuNet0.
export function extractMacFromLxcNet0(net0) {
  if (!net0) return null;
  const match = net0.match(/(?:^|,)hwaddr=([0-9A-Fa-f:]{17})(?:,|$)/);
  return match ? match[1] : null;
}

// Shared by both LXC's /interfaces (ip-address-type: "inet"/"inet6") and the
// QEMU guest agent's network-get-interfaces (ip-address-type: "ipv4"/"ipv6")
// — the caller supplies which literal string means "IPv4" in its data,
// since the two real Proxmox API shapes disagree on it.
export function findIPv4ByMac(interfaces, mac, ipv4Type) {
  if (!mac) return null;
  const normalizedMac = mac.toLowerCase();
  const iface = (interfaces ?? []).find((entry) => entry["hardware-address"]?.toLowerCase() === normalizedMac);
  if (!iface) return null;
  const ipv4Entry = (iface["ip-addresses"] ?? []).find((addr) => addr["ip-address-type"] === ipv4Type);
  return ipv4Entry?.["ip-address"] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/proxmox/vmNetwork.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/proxmox/vmNetwork.js src/utils/proxmox/vmNetwork.test.js
git commit -m "feat: add VM/LXC net0 MAC parsing and MAC-to-IPv4 correlation"
```

---

### Task 3: Composed `/api/proxmox/vms` route

**Files:**

- Create: `src/pages/api/proxmox/vms/index.js`
- Test: `src/__tests__/pages/api/proxmox/vms/index.test.js`

**Interfaces:**

- Consumes: `getPveConfig()` (Task 1); `extractMacFromQemuNet0`, `extractMacFromLxcNet0`, `findIPv4ByMac` (Task 2); the existing `httpProxy` (`utils/proxy/http`) and `createLogger` (`utils/logger`) utilities — same imports the existing `src/pages/api/proxmox/stats/[...service].js` route already uses, follow its exact `httpProxy` call shape (`const [status, , data] = await httpProxy(url, { method: "GET", headers })`, then `JSON.parse(Buffer.from(data).toString())`).
- Produces: `GET /api/proxmox/vms` → 200 with a JSON array, one entry per non-template VM/LXC:
  ```js
  {
    vmid: number, node: string, type: "qemu" | "lxc", name: string, status: string,
    cpuUsedCores: number, cpuTotalCores: number,
    memUsedBytes: number, memTotalBytes: number,
    diskUsedBytes: number | null,  // real for lxc; null for qemu (see plan's Deviation section)
    diskTotalBytes: number,
    uptimeSeconds: number,
    macAddress: string | null,
    ipAddress: string | null,
    osName: string | null,         // lxc: ostype from config (e.g. "debian"); qemu: agent's pretty-name or null
  }
  ```
  500 with `{ error: "..." }` (generic, no raw upstream detail) only when the config is missing or the initial `cluster/resources` call itself fails — every PER-VM enrichment call (config, interfaces, agent) degrades that VM's specific field(s) to `null` on failure and never fails the whole route, matching the `/api/disks` precedent from Plan 1/2.

The current `src/pages/api/proxmox/stats/[...service].js` (read it first — this plan does not modify it, but read it to match its `httpProxy`/error-handling conventions exactly):

```javascript
import { getProxmoxConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxStatsService");
// ... (existing route body — read the actual file for full context)
```

- [ ] **Step 1: Write the failing tests**

```javascript
// src/__tests__/pages/api/proxmox/vms/index.test.js
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
      if (url.includes("/qemu/100/config")) throw new Error("connect ECONNREFUSED 10.0.1.9:8006");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/__tests__/pages/api/proxmox/vms/index.test.js`
Expected: FAIL — `Cannot find module 'pages/api/proxmox/vms/index'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/pages/api/proxmox/vms/index.js
import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { extractMacFromLxcNet0, extractMacFromQemuNet0, findIPv4ByMac } from "utils/proxmox/vmNetwork";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxVmsService");

async function pveGet(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "GET", headers });
  const parsed = JSON.parse(Buffer.from(data).toString());
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return parsed.data;
}

function basicStatsFromResource(resource) {
  return {
    vmid: resource.vmid,
    node: resource.node,
    type: resource.type,
    name: resource.name,
    status: resource.status,
    cpuUsedCores: resource.cpu * resource.maxcpu,
    cpuTotalCores: resource.maxcpu,
    memUsedBytes: resource.mem,
    memTotalBytes: resource.maxmem,
    diskUsedBytes: resource.type === "lxc" ? resource.disk : null,
    diskTotalBytes: resource.maxdisk,
    uptimeSeconds: resource.uptime,
  };
}

async function enrichLxc(pveConfig, resource) {
  const config = await pveGet(pveConfig, `nodes/${resource.node}/lxc/${resource.vmid}/config`);
  const mac = extractMacFromLxcNet0(config?.net0);
  const interfaces = await pveGet(pveConfig, `nodes/${resource.node}/lxc/${resource.vmid}/interfaces`);
  return { macAddress: mac, ipAddress: findIPv4ByMac(interfaces, mac, "inet"), osName: config?.ostype ?? null };
}

async function enrichQemu(pveConfig, resource) {
  const config = await pveGet(pveConfig, `nodes/${resource.node}/qemu/${resource.vmid}/config`);
  const mac = extractMacFromQemuNet0(config?.net0);

  // The guest agent is independently optional — a VM with agent: undefined
  // (or one where it's configured but not actually running inside the
  // guest) must still return its MAC from config, just with IP/OS as null,
  // rather than failing this VM's entire enrichment.
  let ipAddress = null;
  let osName = null;
  if (config?.agent === "1" || config?.agent?.startsWith?.("1,")) {
    try {
      const agentInterfaces = await pveGet(
        pveConfig,
        `nodes/${resource.node}/qemu/${resource.vmid}/agent/network-get-interfaces`,
      );
      ipAddress = findIPv4ByMac(agentInterfaces?.result, mac, "ipv4");
    } catch (error) {
      logger.error("QEMU guest-agent network lookup failed for vmid %s:", resource.vmid, error);
    }
    try {
      const osinfo = await pveGet(pveConfig, `nodes/${resource.node}/qemu/${resource.vmid}/agent/get-osinfo`);
      osName = osinfo?.result?.["pretty-name"] ?? null;
    } catch (error) {
      logger.error("QEMU guest-agent osinfo lookup failed for vmid %s:", resource.vmid, error);
    }
  }

  return { macAddress: mac, ipAddress, osName };
}

async function buildEntry(pveConfig, resource) {
  const base = basicStatsFromResource(resource);
  try {
    const enrichment =
      resource.type === "lxc" ? await enrichLxc(pveConfig, resource) : await enrichQemu(pveConfig, resource);
    return { ...base, ...enrichment };
  } catch (error) {
    logger.error("Enrichment failed for %s/%s:", resource.type, resource.vmid, error);
    return { ...base, macAddress: null, ipAddress: null, osName: null };
  }
}

export default async function handler(req, res) {
  const pveConfig = getPveConfig();

  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  let resources;
  try {
    resources = await pveGet(pveConfig, "cluster/resources?type=vm");
  } catch (error) {
    logger.error("Failed to fetch Proxmox cluster resources:", error);
    return res.status(500).json({ error: "Failed to fetch Proxmox cluster resources" });
  }

  const guests = (resources ?? []).filter((resource) => resource.template === 0);
  const entries = await Promise.all(guests.map((resource) => buildEntry(pveConfig, resource)));

  return res.status(200).json(entries);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/__tests__/pages/api/proxmox/vms/index.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite, lint, and prettier**

Run: `pnpm test` — expect PASS, no regressions.
Run: `pnpm lint` — expect clean.
Run: `npx prettier --check src/pages/api/proxmox/vms/index.js src/__tests__/pages/api/proxmox/vms/index.test.js` — expect clean (Plan 2's final review found `pnpm lint` alone insufficient — check explicitly, on every new file, not just the ones named in an earlier step).

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/proxmox/vms/index.js src/__tests__/pages/api/proxmox/vms/index.test.js
git commit -m "feat: add composed /api/proxmox/vms route"
```

---

### Task 4: `ProxmoxVmsGroup` UI and dashboard wiring

**Files:**

- Create: `src/components/proxmox-vms/group.jsx`
- Test: `src/components/proxmox-vms/group.test.jsx`
- Modify: `src/pages/index.jsx`

**Interfaces:**

- Consumes: `GET /api/proxmox/vms` (Task 3); `formatUptime` (Task 1).
- Produces: `export default function ProxmoxVmsGroup()` — self-contained component (own SWR fetch, own loading/error states, own grid), no props, rendered directly in `index.jsx` alongside `<DisksGroup />`.

Read `src/components/disks/group.jsx` first (the component this one is architecturally modeled on) to copy its exact patterns: the `fetcher` that throws on `!r.ok`, the `SettingsContext`/`cardBlur` handling, the outer wrapper `className="flex flex-col m-4 sm:m-8 sm:mt-4 mb-2"`, the heading `<h2>` class, `STAT_CLASS`/`CARD_CLASS` constants (import or redeclare identically — check whether `disks/group.jsx` exports them; if not, copy the exact class strings, don't invent new ones), and the `Stat` component's `"-"` null-placeholder convention. Read `src/pages/index.jsx` to find where `<DisksGroup />` is currently rendered (Plan 1/2 already wired it in) and where the current `Proxmox VE` widget lives in the render tree, if it renders through the same file (it may instead only exist in `config/services.yaml`, entirely outside this codebase — check `servicesAndBookmarksGroups`'s source before assuming).

- [ ] **Step 1: Write the failing test**

```javascript
// src/components/proxmox-vms/group.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import ProxmoxVmsGroup from "./group";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

describe("components/proxmox-vms/group", () => {
  it("renders a heading and a card per VM/LXC with real data", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
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
          },
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "lxc-homelab",
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
    });

    renderWithSWR(<ProxmoxVmsGroup />);

    expect(screen.getByText("Virtual Machines")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("homeassistant")).toBeInTheDocument());

    const vmCard = screen.getByText("homeassistant").closest('[data-testid="vm-card"]');
    expect(vmCard).toHaveAttribute("data-status", "running");
    expect(vmCard).toHaveTextContent("Home Assistant OS 18.2");
    expect(vmCard).toHaveTextContent("10.0.1.22");
    expect(vmCard).toHaveTextContent("1d 1h"); // formatUptime(92576)
    expect(vmCard).toHaveTextContent("3.09 GB / 3.22 GB"); // pretty-bytes on mem

    const lxcCard = screen.getByText("lxc-homelab").closest('[data-testid="vm-card"]');
    expect(lxcCard).toHaveAttribute("data-status", "stopped");
    // No MAC/IP/OS available for this entry — reuses the existing Stat "-" placeholder.
    expect(lxcCard).toHaveTextContent("-");
  });

  it("shows a failure message when the API responds with an error status", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    renderWithSWR(<ProxmoxVmsGroup />);

    await waitFor(() => expect(screen.getByText("Failed to load VM/LXC data.")).toBeInTheDocument());
  });
});
```

Note: `3.09 GB / 3.22 GB` is `pretty-bytes@7.1.1`'s actual, verified default formatting for `3088969728`/`3221225472` — confirmed directly via `node --input-type=module -e "import prettyBytes from 'pretty-bytes'; console.log(prettyBytes(3088969728), prettyBytes(3221225472))"` while writing this plan, not guessed (an earlier draft of this plan had this wrong as "2.88 GB" — caught and corrected before finalizing, exactly the kind of slip verifying against the real library catches).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/components/proxmox-vms/group.test.jsx`
Expected: FAIL — `Cannot find module './group'`.

- [ ] **Step 3: Write the implementation**

```jsx
// src/components/proxmox-vms/group.jsx
import classNames from "classnames";
import prettyBytes from "pretty-bytes";
import { useContext } from "react";
import useSWR from "swr";

import { SettingsContext } from "utils/contexts/settings";
import { formatUptime } from "utils/proxmox/uptime";

const STATUS_DOT_CLASS = {
  running: "bg-emerald-500",
  stopped: "bg-theme-400",
};

// Same stat-pill/card classes src/components/disks/group.jsx established for
// this dashboard's non-Homepage-widget sections — reused verbatim so this
// group reads as the same visual family, not a new one.
const STAT_CLASS =
  "bg-theme-200/50 dark:bg-theme-900/20 rounded-sm m-1 flex-1 flex flex-col items-center justify-center text-center p-1 service-block";

const CARD_CLASS =
  "transition-all mb-2 p-3 rounded-md font-medium text-theme-700 dark:text-theme-200 shadow-md shadow-theme-900/10 dark:shadow-theme-900/20 bg-theme-100/20 dark:bg-white/5 relative overflow-clip service-card";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function Stat({ value, label }) {
  return (
    <div className={STAT_CLASS}>
      <div className="font-thin text-sm">{value === null || value === undefined ? "-" : value}</div>
      <div className="font-bold text-xs uppercase">{label}</div>
    </div>
  );
}

function VmCard({ vm, cardClassName }) {
  const cpuValue = `${vm.cpuUsedCores.toFixed(2)} / ${vm.cpuTotalCores}`;
  const memValue = `${prettyBytes(vm.memUsedBytes)} / ${prettyBytes(vm.memTotalBytes)}`;
  const diskValue =
    vm.diskUsedBytes == null ? null : `${prettyBytes(vm.diskUsedBytes)} / ${prettyBytes(vm.diskTotalBytes)}`;

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
    </div>
  );
}

export default function ProxmoxVmsGroup() {
  const settingsContext = useContext(SettingsContext);
  const settings = settingsContext?.settings ?? {};

  const cardClassName = classNames(
    settings.cardBlur !== undefined && `backdrop-blur${settings.cardBlur.length ? "-" : ""}${settings.cardBlur}`,
    CARD_CLASS,
  );

  const {
    data: vms,
    error,
    mutate,
    isValidating,
  } = useSWR("/api/proxmox/vms", fetcher, {
    refreshInterval: 60000,
  });

  return (
    <div id="proxmox-vms-group" className="flex flex-col m-4 sm:m-8 sm:mt-4 mb-2">
      <div className="flex items-center justify-between">
        <h2 className="flex text-theme-800 dark:text-theme-300 text-xl font-medium service-group-name">
          Virtual Machines
        </h2>
        <button type="button" onClick={() => mutate()} disabled={isValidating} className="text-sm">
          Refresh
        </button>
      </div>

      {error && <p className="text-rose-500/80">Failed to load VM/LXC data.</p>}
      {!vms && !error && <p className="text-theme-500 dark:text-theme-300 text-sm">Loading...</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {Array.isArray(vms) && vms.map((vm) => <VmCard key={vm.vmid} vm={vm} cardClassName={cardClassName} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/components/proxmox-vms/group.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `index.jsx`**

Read the current `src/pages/index.jsx` first to confirm exact placement (it has shifted twice already, across Plan 1 and Plan 2). Add the import alphabetically among the `components/*` imports:

```javascript
import DisksGroup from "components/disks/group";
import ProxmoxVmsGroup from "components/proxmox-vms/group";
```

Render it directly after `<DisksGroup />` (find the exact JSX from Plan 1/2's work — it should currently read `{servicesAndBookmarksGroups}` followed by `<DisksGroup />`):

```jsx
        {servicesAndBookmarksGroups}

        <ProxmoxVmsGroup />

        <DisksGroup />
```

(Order — VMs above Disks — is a judgment call, not a hard requirement; keep them adjacent as a pair of "live infra" sections. If the current file's exact surrounding JSX differs from this snippet, adapt the insertion point rather than fighting the diff — the goal is `<ProxmoxVmsGroup />` rendered as a sibling of `<DisksGroup />`, order between the two is not load-bearing.)

- [ ] **Step 6: Run the full suite, lint, and prettier**

Run: `pnpm test` — expect PASS, no regressions.
Run: `pnpm lint` — expect clean.
Run: `npx prettier --check src/components/proxmox-vms/group.jsx src/components/proxmox-vms/group.test.jsx src/pages/index.jsx` — expect clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/proxmox-vms/group.jsx src/components/proxmox-vms/group.test.jsx src/pages/index.jsx
git commit -m "feat: add ProxmoxVmsGroup and wire it into the dashboard"
```

---

### Task 5: Live verification

**Files:** none (verification only, plus one live-config edit on lxc200 — not a code change)

- [ ] **Step 1: Deploy to the real host**

```bash
git push origin dev
ssh lxc200 'cd /opt/stacks/your-server-board && git pull origin dev && docker compose up -d --build'
```

- [ ] **Step 2: Verify the API directly**

```bash
curl -s http://10.0.1.104:3050/api/proxmox/vms | python3 -m json.tool
```

Expected: an array with 3 entries (VM 100 `homeassistant`, LXC 200 `lxc-homelab`, LXC 202 `lxc-influxdb`) — no templates. Confirm against this plan's captured live data: VM 100 should show `macAddress: "BC:24:11:85:3A:8F"`, `ipAddress: "10.0.1.22"`, `osName: "Home Assistant OS 18.2"` (or close to it — the guest agent's exact string could drift if HAOS has updated since planning); both LXCs should show real `diskUsedBytes` and their own `macAddress`/`ipAddress`/`osName` (`"debian"`).

- [ ] **Step 3: Verify the dashboard renders it**

```bash
curl -s http://10.0.1.104:3050/ | grep -o 'Virtual Machines' | head -1
```

Open `http://10.0.1.104:3050/` in a browser if available. Expected: a "Virtual Machines" section shows 3 cards with real CPU/RAM/Disk/uptime/IP/MAC/OS data, laid out consistently with the existing Disks section below it (same card style, same stat-pill style).

- [ ] **Step 4: Remove the old aggregate widget from the live dashboard config**

`config/services.yaml` on lxc200 (a live, user-owned config file — not part of this repo, not touched by any code in this plan) currently has a `Proxmox VE` service entry under `Infrastructure` using the stock `proxmox` widget type. Once Step 3 confirms the new section works, edit that file on lxc200 to remove the `Proxmox VE` entry (or the whole `Infrastructure` group if it was the only entry in it) and restart the container to pick up the config change:

```bash
ssh lxc200 'cat /opt/stacks/your-server-board/config/services.yaml'
# Manually edit to remove the "Proxmox VE" entry, then:
ssh lxc200 'cd /opt/stacks/your-server-board && docker compose restart'
```

- [ ] **Step 5: Confirm nothing else broke**

Confirm the existing Disks section, service groups, and bookmarks all still render normally — this plan only adds a new section and (manually, outside the repo) removes one old widget entry.
