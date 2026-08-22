# VM/LXC Detail & Disk Widgets — Design

**Date:** 2026-08-11
**Status:** Approved for planning
**Supersedes:** the `/disks` page built by the Disks & SMART plan (`docs/superpowers/plans/2026-08-11-disks-smart.md`) — that page is removed by this plan, its data folded into a dashboard widget instead. The Proxmox VE widget (upstream Homepage, unmodified until now) is replaced by a custom per-VM/LXC widget.

## Problem

The current dashboard shows only cluster-wide aggregates (VM/LXC running counts, cluster CPU%, cluster MEM%) via Homepage's stock Proxmox VE widget, and disk health lives on a separate `/disks` page. The operator wants everything on the main dashboard, with real used/total numbers (not just percentages) down to the level of each individual VM and LXC container, plus process-level and OS-level detail.

## Goals

- Replace the aggregate Proxmox VE widget with a card per VM/LXC showing: name, status, CPU used/total (cores), RAM used/total, allocated-disk used/total, uptime, IP address, MAC address, OS name, and an expandable section with the 5 highest-CPU processes and last-OS-update date (best-effort).
- Move disk health from the standalone `/disks` page onto the main dashboard as its own widget group, with real used/total per disk (not just SMART wear) — this time computed from actual filesystem/LVM usage, not just raw capacity.
- Keep the security discipline established in Foundation: any new remote-command capability is a strict, server-side-enforced allowlist, never arbitrary exec.

## Non-goals

- No changes to Quick VM/CT actions (start/stop/reboot) — still deferred to the Backups plan.
- No changes to `smartClient.js`'s existing SMART/lsblk capability — this plan extends the _allowed command set_ on the restricted SSH key, but doesn't touch the existing device-path validation logic.
- No attempt at OS-update detection for every possible guest OS family — best-effort for common Linux package managers (apt/dpkg first; report `N/A` for anything else, including appliance OSes like Home Assistant OS which use image-based updates (`rauc`) rather than package management).
- No arbitrary command execution capability anywhere, for any user, ever — every new remote command this plan adds is a fixed, server-side-validated allowlist entry, parameterized only by a validated container ID where necessary. This is a hard constraint, not a preference.

## Real Data Verified During Planning

Checked directly against the real Proxmox host before writing this spec (not assumed):

- **QEMU guest agent works on VM 100** (`agent: 1` in config, confirmed responsive via `qm agent 100 ping`). `qm agent 100 network-get-interfaces` returns real IP/MAC data. `qm agent 100 get-osinfo` returns `{"name": "Home Assistant OS", "pretty-name": "Home Assistant OS 18.2", ...}`. `qm guest exec 100 -- ps aux` returns a real process list — guest-exec is a genuine, working capability via the Proxmox API (`/nodes/{node}/qemu/{vmid}/agent/exec` + `/agent/exec-status`), authenticated with the same API token already in use, no SSH needed for VMs.
- **LXC network interfaces are available natively via the Proxmox API**, no agent and no exec needed: `pvesh get /nodes/proxmox/lxc/200/interfaces` returns real IP/MAC directly (Proxmox can read a running container's network namespace directly since it shares the host kernel).
- **LXC OS family is available for free from config**: `pvesh get /nodes/proxmox/lxc/200/config` includes `ostype: debian` — enough for a basic OS label with zero new remote-execution capability. Richer detail (pretty name, version, last-update timestamp) still requires `pct exec`.
- **LXC has no API-level exec** — Proxmox does not expose `pct exec` over the REST API (unlike QEMU's guest-agent exec). Process listing and richer OS/update detail for LXC must go over SSH to the Proxmox host, the same restricted-key mechanism `smartClient.js` already uses, extended with new allowlisted commands.

## Architecture

Two data paths, matching how the underlying data is actually reachable:

### Path 1: Proxmox REST API (existing token, no new access)

Everything for VMs, and most things for LXC, come from the Proxmox API token already configured (`config/proxmox.yaml`'s `pve:` block, used today by the stock Proxmox VE widget and by the existing `src/pages/api/proxmox/stats/[...service].js` route):

- Status/resources: `/nodes/{node}/qemu/{vmid}/status/current`, `/nodes/{node}/lxc/{vmid}/status/current` — CPU%, mem/maxmem, disk/maxdisk (LXC — real; QEMU's `maxdisk` is the allocated size, actual used requires the guest agent's filesystem info, see below), uptime.
- Config (for MAC + LXC OS family): `/nodes/{node}/qemu/{vmid}/config`, `/nodes/{node}/lxc/{vmid}/config`.
- LXC network (IP/MAC, no agent needed): `/nodes/{node}/lxc/{vmid}/interfaces`.
- QEMU network/OS (needs guest agent, degrades gracefully if absent — see Error Handling): `/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces`, `/nodes/{node}/qemu/{vmid}/agent/get-osinfo`.
- QEMU process list (needs guest agent): `/nodes/{node}/qemu/{vmid}/agent/exec` (POST, body `{"command": ["ps", "aux", "--sort=-%cpu"]}`) then poll `/nodes/{node}/qemu/{vmid}/agent/exec-status?pid={pid}` until `exited: 1`.
- QEMU actual disk usage (needs guest agent; without it, only allocated size is known): `/nodes/{node}/qemu/{vmid}/agent/get-fsinfo`.

### Path 2: Restricted SSH (extends the existing key from Foundation/Disks & SMART)

LXC process listing and richer OS/update detail have no API equivalent — they go over the same restricted SSH key `smartClient.js` already uses, with new allowlisted commands added to `deploy/proxmox-smart-helper.sh` (and the client-side equivalent in a new `src/utils/ssh/` module, sibling to `smartClient.js`, not a modification of it). Also used for the disk-widget's `df`/`lvs`/`vgs` calls (see Disk Widget below).

**New allowlist entries** (forced-command pattern identical to the existing `smartctl`/`lsblk` entries — exact literal match or a validated-and-reconstructed parameter, never the client's raw string executed directly):

- `pct exec <vmid> -- ps aux --sort=-%cpu` — `<vmid>` extracted from the request, validated as `^[0-9]+$`, then interpolated into a fixed command template server-side.
- `pct exec <vmid> -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'` — one combined probe (OS release info + apt's last-successful-update timestamp if present) rather than two separate allowlist entries, to keep the exec surface as small as possible. Any other package manager (or an appliance OS with no apt) reports `none` for the timestamp half, which the API route turns into `lastOsUpdate: null` → rendered as "N/A".
- `df -B1 --output=target,used,size <mountpoints...>` and `lvs --noheadings --units b --nosuffix -o lv_name,data_percent,lv_size <vg>` — for the disk widget's used/total (see below). Exact allowlist syntax (fixed flags, validated mountpoint/VG names) is an implementation-planning detail, same validate-and-reconstruct pattern as the rest of this list.

## VM/LXC Detail Widget

One card per VM/LXC (both types, visually consistent), replacing the single aggregate Proxmox VE widget group. Card contents:

- **Header:** name, status (running/stopped — colored dot, matching the existing status-dot convention from the Disks & SMART work), type (VM/LXC badge).
- **Stat row 1:** CPU (used/total cores), RAM (used/total, e.g. `1.2 GiB / 4 GiB`).
- **Stat row 2:** Disk (used/total — LXC always real via `disk`/`maxdisk`; QEMU real only if the guest agent's `get-fsinfo` succeeds, otherwise shows allocated size only with a note), Uptime.
- **Identity row:** IP address, MAC address, OS name (LXC: `ostype` from config as a fast/free fallback if the richer SSH probe hasn't returned yet or fails; QEMU: guest agent's `pretty-name` if available).
- **Expandable section** (reusing the existing hover/toggle "stats" interaction pattern already present in `src/components/services/item.jsx`'s `statsOpen`/`closeStats` state, rather than inventing a new expand/collapse mechanism): top 5 processes by CPU (PID, command, %CPU, %MEM) and "Last OS update: `<date>` or N/A".

### Error Handling / Graceful Degradation

Every enrichment beyond the base Proxmox API status call (guest-agent data for VMs, SSH-derived data for LXC) is independently optional — a VM without a running guest agent, or an LXC where the SSH probe times out, still shows the base card (name/status/CPU/RAM/disk/uptime) with the enrichable fields showing a clear "unavailable" state rather than blocking or erroring the whole card. This mirrors the per-disk error-isolation principle already established in the Disks & SMART plan (one bad data source degrades one field, never crashes the page).

## Disk Widget (replaces `/disks` page)

Moves onto the main dashboard as its own widget group (visual language unchanged from the Disks & SMART plan — same card/stat-pill classes, same SMART health/status-dot logic from `src/utils/disks/health.js`, unmodified). The one substantive change: **capacity is now real used/total**, not just raw size:

- **Simple case (e.g. `sdc`, one mounted filesystem):** `df` on its mountpoint(s) gives real used/total directly.
- **LVM case (e.g. `sda`, system disk with a thin pool):** combine `df` across the disk's directly-mounted filesystems (e.g. `/boot/efi`, `/`) with `lvs`'s thin-pool `data_percent` (the space actually consumed by VM disks living in that pool) to produce one aggregate used/total for the physical disk. Exact aggregation formula (which mountpoints/LVs belong to which physical disk, derived from `lsblk`'s existing nested `children` structure that the current `/api/disks` route already receives but discards after filtering to top-level entries) is an implementation-planning detail.
- SMART wear (`percentage_used` for NVMe) remains a separate, distinct stat on the card — it answers "how worn out is this drive," which is different information from "how full is it."

## Security Design for the Extended SSH Allowlist

Every new capability follows the exact pattern already reviewed and approved for `smartctl`/`lsblk` in Foundation:

1. The restricted SSH key's forced command (`deploy/proxmox-smart-helper.sh`) is the sole enforcement point — the client-side code can request anything, but the server only ever executes one of a small number of fixed command shapes it recognizes.
2. Any parameter (vmid, mountpoint, VG name) is extracted from the request and validated against a strict pattern (e.g. `^[0-9]+$` for a vmid) _before_ being substituted into a hardcoded command template — never passed through to a shell that could interpret metacharacters. This is the identical technique already used for `smartctl`'s device-path parameter and already survived one round of adversarial security review during Foundation.
3. No new command is a general-purpose exec primitive. `pct exec <vmid> -- ps aux --sort=-%cpu` and the combined OS-release/update-stamp probe are each one fixed, complete command — there is no way to ask the forced-command script to run anything other than these specific, named, read-only operations.
4. This is genuinely a larger trust surface than Foundation's SMART-only key (it now reads live process lists across every container), so implementation planning should include a dedicated review pass specifically re-examining `proxmox-smart-helper.sh`'s new branches with the same adversarial rigor Foundation's final review applied to the original two.

## Testing

- Pure-function threshold/aggregation logic (disk used/total combination, process-list formatting) gets unit tests with real-data-shaped fixtures, following the pattern already established by `src/utils/disks/health.js`'s tests.
- API routes get the same mock-based test pattern as `src/pages/api/disks/index.js` and `src/pages/api/proxmox/stats/[...service].js` — mocking the Proxmox API client and the new SSH module, never hitting real infrastructure in the test suite.
- Graceful-degradation paths (missing guest agent, SSH probe failure/timeout) each get an explicit test — this plan's error-handling principle only holds if it's actually verified, not just designed.
- Live verification against the real Proxmox host (VM 100 with guest agent, LXC 200/202 without needing one) is required before the plan is considered done, same as every prior plan.

## Open Items for Implementation Planning

- Exact new API route(s) and file structure for VM/LXC detail (one route per VM/LXC, or one composed route like `/api/disks` does for disks — decide based on how many round-trips per dashboard load that implies).
- Exact `df`/`lvs` flag choices and output-parsing format for the disk-widget aggregation.
- Exact mapping logic from `lsblk`'s nested `children` tree to "which mountpoints/LVs belong to this physical disk" for the disk widget's used/total aggregation.
- Whether QEMU's `get-fsinfo` (actual in-guest disk usage) is worth the extra API round-trip for VMs, or whether allocated-size-only is an acceptable first cut for VMs specifically (LXC's `disk`/`maxdisk` from the base status call is already real usage, no extra call needed).
- Polling/refresh strategy for the new widgets (matching the Disks & SMART page's 60s SWR pattern, or something else given this now pulls from more data sources per refresh).
