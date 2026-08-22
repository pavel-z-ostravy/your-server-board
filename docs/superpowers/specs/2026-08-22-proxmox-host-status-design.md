# Proxmox Host Status Above VMs — Design

**Date:** 2026-08-22
**Status:** Approved for planning

## Problem

The dashboard shows per-VM/LXC cards (`ProxmoxVmsGroup`, built in a prior plan) but nothing about the Proxmox host itself — the physical server those guests run on. Pavel wants the host's own status (CPU/RAM/disk, uptime, PVE version, load average) visible in a hierarchy above the VM cards, so the "parent" server and its "child" guests read as one coherent picture rather than VMs floating with no host context.

## Goals

- Show the Proxmox host's live status — CPU, RAM, disk, uptime, PVE version, load average (1/5/15 min) — as a header block above the existing VM/LXC card grid, inside the same "Virtual Machines" section.
- Single Proxmox node (confirmed: this deployment is a single-host homelab, not a cluster) — no per-node list/selector needed.
- Degrade independently from the VM list: a host-status failure shows an inline error without blanking out the VM cards below it, and vice versa.
- Reuse the existing visual language (stat-pill/status-dot pattern already used by `VmCard`) rather than introducing a new card style.

## Non-goals

- Multi-node / cluster support — explicitly out of scope; this design assumes exactly one Proxmox node and takes the first (only) entry from `GET /nodes`.
- A new draggable top-level section — the host status is _part of_ the existing `proxmox-vms` section's rendering, not a new entry in `KNOWN_SECTION_IDS`/the drag-and-drop system built in the prior plan.
- Historical trend graphs for host resource usage — that's the separately-tracked "Resource/Load History" feature in the original project design spec, not this one.

## Architecture

### API route

New `GET /api/proxmox/host`, alongside the existing `src/pages/api/proxmox/vms/index.js`, reusing the same `getPveConfig()`/`pveGet()` pattern (same API token, same `httpProxy` helper — no new credential).

Two sequential Proxmox API calls:

1. `GET /nodes` — returns an array of cluster nodes; for a single-node deployment this is one entry with `node` (name), `status` (`"online"`/`"offline"`), `cpu`, `maxcpu`, `mem`, `maxmem`, `uptime`. Take the first entry.
2. If that entry's `status === "online"`: `GET /nodes/{node}/status` — richer detail in one call: `cpu`, `memory: {total, used, free}`, `rootfs: {total, used, free}`, `loadavg: [1min, 5min, 15min]`, `uptime`, `pveversion`. This is the primary data source for the response; the `/nodes` call above exists mainly to discover the node name and online/offline state without hardcoding a node name in config.

If the node is offline (or the first call's array is empty), skip the second call — it would just fail — and return a minimal entry with `status: "offline"` and every other field `null`, mirroring the existing "degrade this entry's fields to null rather than fail the whole route" convention already used in `enrichLxc`/`enrichQemu`.

Response shape:

```json
{
  "status": "online",
  "cpuUsedCores": 3.2,
  "cpuTotalCores": 8,
  "memUsedBytes": 12884901888,
  "memTotalBytes": 34359738368,
  "diskUsedBytes": 107374182400,
  "diskTotalBytes": 536870912000,
  "uptimeSeconds": 1234567,
  "pveVersion": "8.2.4",
  "loadAvg": [0.42, 0.51, 0.48]
}
```

`status: "offline"` still returns `200` with every numeric field `null` and `pveVersion`/`loadAvg` `null` — this is a valid, expected state, not an error. Only a genuine failure to reach the Proxmox API at all (bad token, network error, both calls throwing) returns `500 { error: "..." }`, matching the `/api/proxmox/vms` precedent.

### Component

New presentational piece inside `src/components/proxmox-vms/group.jsx` (not a new top-level component file — this is a header for the existing group, tightly coupled to it, analogous to how `VmCard` already lives in that same file): a `NodeStatusHeader` function rendered at the top of `ProxmoxVmsGroup`, above the VM card grid.

- Own `useSWR("/api/proxmox/host", fetcher, { refreshInterval: 60000 })` call — independent of the VM list's `useSWR("/api/proxmox/vms", ...)`, so one failing doesn't block the other from rendering.
- Same `Stat`/`STAT_CLASS` stat-pill components `VmCard` already defines — CPU, RAM, Disk stats reused verbatim (extract `formatCapacity`/`Stat` for reuse between `VmCard` and `NodeStatusHeader` rather than duplicating them).
- A status dot using the same `STATUS_DOT_CLASS` map, keyed off `status` (`"online"` reuses the `"running"` → emerald color; `"offline"` reuses the `"stopped"` → grey color).
- Below the stat-pills, a small text line with PVE version and load average (`"PVE 8.2.4 · load 0.42 / 0.51 / 0.48"`), styled like `VmCard`'s existing IP/MAC/OS line (`text-theme-500 dark:text-theme-300 text-xs font-light`).
- The section's existing "Refresh" button (in `ProxmoxVmsGroup`'s header) calls both SWR hooks' `mutate()` — one click refreshes host status and VM list together, since they now read as one hierarchy.

### Layout

Inside `ProxmoxVmsGroup`'s render, `NodeStatusHeader` sits between the existing section header (`"Virtual Machines"` title + Refresh button) and the VM card grid — visually the "parent" row above the "children" grid. No changes to `src/pages/index.jsx`, `KNOWN_SECTION_IDS`, or the drag-and-drop section-order system from the prior plan.

## Testing

- API route: same mock-based pattern as `src/pages/api/proxmox/vms/index.test.js` — online node returns full stats, offline node returns the degraded `status: "offline"` shape without attempting the second call, total failure (both/either call throwing) returns `500`.
- Component: new tests for `NodeStatusHeader` (or extended `group.test.jsx` coverage) mocking `useSWR` — verifies stat values render, offline state shows the grey dot and `-` stats, error state shows an inline message without hiding the VM grid, and the Refresh button triggers both `mutate()` calls.
- No new SSH/exec capability, so no new SSH-mocking test surface beyond what `/api/proxmox/vms`'s tests already established.
