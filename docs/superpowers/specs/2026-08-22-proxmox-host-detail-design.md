# Proxmox Host IP + Process Detail — Design

**Date:** 2026-08-22
**Status:** Approved for planning

## Problem

The Proxmox host status header (built in a prior plan) shows CPU/RAM/disk/uptime/PVE-version/load-average, but nothing about the host's network identity or what's actually running on it — unlike `VmCard`, which shows IP/MAC and has a "Details" toggle exposing a live process list. Pavel wants the host header to have the same IP-address visibility and process-detail drill-down the VM/LXC cards already have.

## Goals

- Show the Proxmox host's own IP address in the status header.
- Add a "Details" toggle to the host status header, matching `VmCard`'s existing lazy-fetch-on-first-expand behavior, showing the host's top processes (by CPU).
- Reuse every existing pattern this codebase already has for this shape of feature (`parseTopProcesses`, the `getSmartConfig()`-scoped restricted SSH key, the lazy-detail-toggle UI) rather than inventing new ones.

## Non-goals

- **MAC address for the host.** Proxmox's `GET /nodes/{node}/network` has no dedicated MAC field for the host; the only signal is an `altnames` entry like `enx484d7eef14ee`, which embeds a MAC only for interfaces named by that specific `udev` predictable-naming convention (typically USB NICs) — not guaranteed for every interface type or Linux distribution. Explicit decision (confirmed 2026-08-22): skip it entirely rather than show an unreliably-derived value.
- **OS-release / last-update line for the host**, unlike `VmCard`'s detail panel. The host's own OS identity is already implicitly known (it's the Proxmox host, not a mystery guest) and `pveVersion` already covers the version story. Adding it would need a new SSH command for no clear benefit — YAGNI.
- **Any change to how VM/LXC "Details" works.** This plan only adds a sibling capability for the host itself; `VmCard`'s existing detail flow (`/api/proxmox/vm-detail`, `agentExec.js`, `lxcClient.js`) is untouched.

## Architecture

### IP address

Add `ipAddress` to the existing `GET /api/proxmox/host` response. The route already calls `GET /nodes` and (when online) `GET /nodes/{node}/status`; this adds one more call, `GET /nodes/{node}/network`, only when the node is online (mirrors the existing "second call only if online" pattern). Verified against a live Proxmox 9.2 host: this endpoint returns an array of interface objects; the host's address lives on whichever entry has both `families: ["inet"]` and a populated `address` field (on this host, that's the bridge `vmbr0`, but the selection logic must not hardcode a bridge name — a different deployment may use a different bridge/interface as its primary). Pick the first such entry; if none exists (or the call fails), `ipAddress` is `null` — same graceful-degradation posture as `pveVersion`/`loadAvg` already have for the second/third call.

### Process detail

New route `GET /api/proxmox/host-detail` (no query params — there's exactly one host), modeled directly on the existing `GET /api/proxmox/vm-detail`'s LXC branch: same `getSmartConfig()` SSH config, same `parseTopProcesses` pure parser, same `{ processes: [...] }` response shape (minus the `osReleaseName`/`lastUpdate` fields per the Non-goals above — this route returns `{ processes: [...] }` only).

New SSH client function in a new module `src/utils/ssh/hostClient.js` (sibling to the existing `lxcClient.js`, same `execCommand`/timeout/connect pattern, copied rather than shared — matches this codebase's existing precedent of each SSH client module owning its own `execCommand`, e.g. `smartClient.js` and `lxcClient.js` already both do this): `getHostProcesses(sshConfig)` runs `ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu` directly over SSH — no `pct exec` wrapper, since this targets the host itself rather than a container.

### Restricted SSH allowlist (security-sensitive — requires explicit deployment approval)

`deploy/proxmox-smart-helper.sh` (the forced-command script already installed on the live Proxmox host, gating the same restricted key used for SMART/`lsblk`/`pct exec`) gets one new `case` arm: an **exact, parameter-free string match** on `"ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu"` — no vmid, no wildcard, nothing derived from client input, so there is no injection surface to validate (unlike the existing `pct exec "$vmid" -- ...` arms, which do need vmid validation because the vmid is attacker/client-influenced). `deploy/SSH_SETUP.md` gets the corresponding documentation update.

This script change must be applied to the live Proxmox host's `authorized_keys`-gated script for the feature to work end-to-end. **Do not deploy this change to the live host without asking first** — updating a live, security-sensitive forced-command script is a different risk class from redeploying the Docker container, and gets its own explicit go-ahead at that point in the implementation, separate from this plan's approval.

### Frontend

`NodeStatusHeader` (in `src/components/proxmox-vms/group.jsx`) gains:

- An IP-address line, styled like `VmCard`'s existing `{vm.ipAddress ?? "-"} · {vm.macAddress ?? "-"} · {vm.osName ?? "-"}` line, but IP-only (no MAC/OS placeholders, per the Non-goals above): `{status.ipAddress ?? "-"}`.
- A "Details" toggle button and expand panel, copied structurally from `VmCard`'s existing `detailOpen`/`detail`/`detailLoading`/`detailError` state and `toggleDetail` fetch-on-first-expand logic, fetching `/api/proxmox/host-detail` (no query params) instead of `/api/proxmox/vm-detail?...`. Same lazy-caching behavior: the request only fires the first time Details is expanded, a failed fetch allows retry on next reopen, a successful fetch is cached for the component's lifetime.

## Testing

- `parseTopProcesses` already has full test coverage (existing) — no new pure-function tests needed for the parsing itself, since this feature reuses it unchanged.
- `src/utils/ssh/hostClient.js`: unit tests mocking `ssh2`'s `Client`, matching the existing test pattern for `lxcClient.js`/`smartClient.js` (successful exec, non-zero exit, timeout).
- `GET /api/proxmox/host` (extended): new test cases for the `ipAddress` field — network call succeeds with a matching interface, network call succeeds with no matching interface (`ipAddress: null`), network call fails (`ipAddress: null`, base stats still present) — matching the existing "degrades gracefully" test pattern already used for `pveVersion`/`loadAvg`.
- `GET /api/proxmox/host-detail` (new route): mock-based tests matching `vm-detail`'s existing LXC-branch test pattern — successful process listing, SSH failure degrades to `{ processes: [] }` with a logged error (never a 500 for a process-listing failure, matching `vm-detail`'s existing precedent), missing SSH config returns 500.
- `NodeStatusHeader` (component): tests for the IP-address line rendering, and Details lazy-fetch/cache/error behavior — same shape as `VmCard`'s existing Details tests (fetch-only-on-first-expand, empty-process-list message, fetch-failure message), reusing this codebase's already-established assertions for those states.
