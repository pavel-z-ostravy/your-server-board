# Disks & SMART — Design

**Date:** 2026-08-11
**Status:** Approved for planning
**Supersedes:** the "Disks & SMART" bullet points in `2026-08-11-your-server-board-design.md`'s Feature Detail section (this doc is the detailed follow-up spec that section pointed at).

## Problem

The Foundation plan deployed `your-server-board` with real Proxmox connectivity and built (but never wired up) a restricted-SSH client (`src/utils/ssh/smartClient.js`) capable of pulling `lsblk` and `smartctl` data from the real Proxmox host. No UI or API route exists yet to surface that data to an operator. This is the first of the follow-up plans that build on Foundation.

## Goals

- A `/disks` page showing every physical block device on the configured Proxmox host — auto-detected, not a fixed list — with SMART health, temperature, and capacity/wear per disk.
- Color-coded health status (ok/warn/critical) using sensible, mostly device-reported thresholds.
- Auto-refreshing (SSH round-trips are slower than a typical widget poll) with a manual refresh option.

## Non-goals

- Quick VM/CT actions (start/stop/reboot) — deferred to the Backups plan, which needs the same Proxmox API write-client infrastructure; no reason to duplicate that work here since Disks & SMART only needs the existing SSH client, not a new API write-client.
- Backup management — separate plan.
- Alerting on the thresholds defined here — separate plan (Alerting/History), though this plan's threshold logic is written to be reused by it later (see Architecture).
- No changes to `smartClient.js`'s public interface — Foundation's final review already fixed its exit-code handling and added a timeout; this plan only calls it.

## UI Placement

New top-level page, `/disks` (`src/pages/disks.jsx`), linked from the main navigation — not a widget group mixed into the main dashboard. Rationale (confirmed with the operator): more room for per-disk detail than a dashboard widget card allows, and it establishes the same "dedicated page" pattern the Backups plan will also use, rather than two different UI patterns for the two new modules.

## Data Flow

1. **Config:** SSH connection details (host, username, `privateKeyPath`) come from the `smart:` block in `config/proxmox.yaml` — the commented template already added to `src/skeleton/proxmox.yaml` during Foundation's final-review fix wave. This plan implements the loader that actually reads it (extending `getProxmoxConfig()`'s pattern, or a small sibling function — decide exact shape during planning) — today nothing reads that block yet.
2. **API route** `src/pages/api/disks/index.js` (or similar — exact path decided during planning), following the validation → config-load → SSH-call → JSON-response shape already established by `src/pages/api/proxmox/stats/[...service].js`:
   - Calls `listBlockDevices()`, filters to `type === "disk"` entries only (excludes partitions like `sda1`, loop devices, etc. — SMART queries on those are invalid or meaningless).
   - For each physical disk, calls `getSmartData(sshConfig, devicePath)`.
   - Computes a health status (`ok` | `warn` | `critical`) server-side per the thresholds below — single source of truth, reusable later by the Alerting plan.
   - Returns one composed JSON array: one fetch call from the frontend gets everything needed to render the page (device name, size, model, mountpoint, temperature, SMART health, capacity/wear, computed status).
3. **Frontend:** `useSWR` (already a project dependency, used idiomatically elsewhere) with `refreshInterval: 60000` against the API route above, plus a manual refresh button. No client-side polling logic to hand-roll.

## Health Status Thresholds

Computed server-side in the API route, from the parsed `smartctl -j` JSON:

- **SMART overall health:** `smart_status.passed === false` → `critical`. (Binary — a drive reporting FAILED overrides everything else below.)
- **Temperature:** prefer the device's own reported thresholds when present (NVMe `smartctl -j` output includes `warning_temp`/`critical_temp` — real fields confirmed present in this host's own `sdc` NVMe SMART output during Foundation's research). Fall back to generic thresholds when the device doesn't report its own: `< 50°C` ok, `50–60°C` warn, `> 60°C` critical.
- **Reallocated sectors (SATA, via SMART attribute 5 / "Reallocated_Sector_Ct"):** `0` → ok, `> 0` → warn. Any reallocated sector is treated as an early degradation signal, not waited-out until it's "bad enough."
- **NVMe wear (`percentage_used` in the SMART JSON):** `< 80` ok, `80–95` warn, `> 95` critical. NVMe `media_errors > 0` also forces at least `warn` regardless of `percentage_used`.
- **Capacity/usage** (from `lsblk`/filesystem usage, not SMART): `< 80%` ok, `80–90%` warn, `> 90%` critical — matches the `> 90%` alerting threshold already decided in the parent spec, so the two stay consistent when Alerting is built later.
- **Overall disk status** shown on its card = the worst (highest-severity) of the above checks for that disk.

## Refresh Behavior

`useSWR` with `refreshInterval: 60000` (60s) — chosen because each refresh is an SSH round-trip per disk (slower than a typical HTTP widget poll, and the Foundation plan already added a 15s per-command timeout to `smartClient.js`, so a tight poll interval risks overlapping slow requests). Manual refresh button on the page for on-demand updates between polls.

## Visual Design

Reuses Homepage's existing card / stat-pill / icon / status-dot component language (established during the original brainstorming pass and confirmed against real Homepage screenshots and source) — no new design system. One card per physical disk: name/model in the header, status dot color-coded per the thresholds above, stat-pills for temperature / health / capacity-or-wear, consistent with the mockups already approved for this project.

## Testing

- API route: unit tests mocking `smartClient.js`'s exports, covering each threshold boundary (ok/warn/critical for temperature, reallocated sectors, NVMe wear) and the SMART-FAILED-overrides-everything case.
- Frontend: component test for the disk card rendering each status color correctly given fixture data.
- No live-infra test is required to merge (unlike Foundation) since this plan only adds a UI/API layer on top of already-verified-live `smartClient.js` — but a manual live check against the real Proxmox host (confirming real `sda`/`sdc` render correctly) is still expected before calling the plan done, same spirit as Foundation's end-to-end verification step.

## Open Items for Implementation Planning

- Exact API route path/file structure (single `src/pages/api/disks/index.js` vs. nested).
- Exact shape of the `getProxmoxConfig()` extension (or sibling loader) for the `smart:` block.
- Navigation: how `/disks` gets linked from the main dashboard (Homepage's own nav/settings mechanism — needs a quick look during planning, not investigated yet).
