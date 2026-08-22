# your-server-board — Design

**Date:** 2026-08-11
**Status:** Approved for planning

## Problem

The homelab (Proxmox host `10.0.1.9` + LXC containers, notably `lxc200`/10.0.1.104 which also runs a Docker stack: Nextcloud AIO, Immich, Audiobookshelf, Dockge, cloudflared) is currently monitored by a self-built dashboard, **lxc-automat**, running on `lxc200:8091`. Its scope has grown to include an LXC/container generator and dev-environment installer that are no longer wanted. What's missing or weak in the current setup:

- No SMART / physical disk health monitoring beyond what lxc-automat's Proxmox module scrapes.
- No structured backup lifecycle management: today only VM 100 (`homeassistant`) is backed up (weekly `vzdump`, cron job in `/etc/pve/jobs.cfg`), targeting the Proxmox system disk (`local` storage dir, ~46GB free). Containers 200/201/202 are not backed up at all. The originally-configured secondary backup target (NFS export on `10.0.1.150`, disabled in `/etc/pve/storage.cfg`) is currently unreachable.
- No way to delete or download individual backups from the UI.
- lxc-automat's own scope (LXC generator, dev-tool installer) is no longer desired.

## Goals

- A new, visually polished, minimalist status dashboard for the homelab, focused purely on: resource monitoring, physical disk health, and backup lifecycle management.
- Full backup control: list, run (user picks destination storage at run time — no hardcoded target), delete, and download to the operator's Mac.
- Auto-detection of all mounted/attached disks on the Proxmox host for SMART health — not a fixed disk list.
- Password + optional TOTP 2FA login.
- Public GitHub repository.
- Config-driven enough that it isn't hardcoded to this specific homelab (IP addresses, node names, disks are discovered/configured, not baked in).

## Non-goals

- No LXC/container generator, no dev-environment installer (this is what's being dropped from lxc-automat).
- No replacement of lxc-automat — it keeps running independently; this is a new project on its own port.
- No multi-Proxmox-cluster support. Single node, config-driven so it _could_ point at a different single node, but no cluster UI.
- No custom reimplementation of integrations Homepage already ships as configurable widgets (Home Assistant, router/SNMP, Cloudflare, DNS ad-blockers, speedtest, service-uptime, Wake-on-LAN). These remain available to the operator via Homepage's own YAML config with zero custom code — they are not part of this project's development scope.
- No backup restore-testing/verification automation.

## Chosen Approach: Fork gethomepage/homepage

Evaluated three approaches:

1. **Fork [gethomepage/homepage](https://github.com/gethomepage/homepage)** (Next.js, GPL-3.0) and add two new modules (Disks & SMART, Backups) plus a TOTP auth layer. — **Chosen.**
2. **Hybrid**: stock Homepage for the bookmark/status view + a separate microservice for SMART/backups. Rejected — two systems to maintain, more security surface, no real time saved since the hard parts (SMART, backups) are custom code either way.
3. **Fully custom dashboard** (reusing lxc-automat's proven FastAPI/SSH/TOTP patterns). Rejected in favor of forking once it was confirmed Homepage's GPL-3.0 license permits forking + public redistribution (derivative must stay GPL-3.0, preserve notices, note changes — no other constraint), and that Homepage's actual visual system (verified against real screenshots: card-based groups, icon+stat-pill widgets, 20-color accent palette, light/dark/glass themes) already covers the "beautiful minimalist" requirement well enough that a from-scratch UI wouldn't add proportional value.

**License consequence:** the public repo must stay GPL-3.0 (inherited, non-negotiable if forking and publishing), with copyright notices preserved and changes documented.

## Architecture

- **Base:** fork of gethomepage/homepage (Next.js app).
- **New modules**, built as Homepage-style widgets/pages reusing its existing card/stat-pill/icon visual language:
  - **Disks & SMART**
  - **Backups**
  - Quick actions (start/stop/reboot) surfaced on the existing Proxmox VM/CT widget cards.
- **Deployment:** standalone Docker container on `lxc200`, registered in the existing Dockge instance (matching how every other service on that host is run). Runs on its own port (default `3050`, configurable), fully independent from lxc-automat (`8091`) — no cutover, both run side by side.
- **Repo:** new public GitHub repo, `your-server-board`.

## Proxmox Integration

Hybrid, chosen specifically so the design is not tied to one root SSH credential (unlike lxc-automat) and is safer to expose behind a public tunnel:

- **Proxmox REST API** with a scoped API token (not username/password): VM/CT listing and status, start/stop/reboot, backup listing, triggering `vzdump` jobs, deleting backup volumes (`DELETE /nodes/{node}/storage/{storage}/content/{volid}`).
- **Restricted SSH key** (forced-command in `authorized_keys`, limited to `smartctl`/`lsblk` invocations only) for SMART and disk enumeration data — the Proxmox API has no SMART endpoint, so this is unavoidable, but scoped to the minimum possible capability.
- All connection details (host, node name, API token, SSH key path) live in a hand-edited `config/proxmox.yaml` (mounted as a Docker volume), following Homepage's existing convention — every other Homepage config (`settings.yaml`, `services.yaml`, etc.) works the same way, there is no in-app settings UI anywhere in the codebase, and building one would be a large, unsupported-by-precedent subsystem for little gain over editing a file. Nothing hardcoded — the same build works against a different Proxmox host/node for another operator by editing that file.

## Feature Detail

### Disks & SMART

- On each load (or on a refresh interval), enumerate **all** block devices on the Proxmox host via `lsblk` — not a fixed list. Currently known devices on this host: `sda` (256GB system SSD) and `sdc`/`sdc_crypt` (2TB Vi3000 NVMe enclosure, mounted `/mnt/storage`), but the module must not assume any specific device names.
- Per disk: SMART overall health (PASSED/FAILED), temperature, reallocated-sector count (SATA) or wear/media-errors (NVMe), capacity/usage. Color-coded thresholds (ok/warn/critical).

### Backups

- List existing Proxmox backups (VM 100 and any future CT backups) with date, size, source.
- **Run backup now**: operator picks the VM/CT and picks the destination storage from a live list of configured Proxmox storages at run time — no single hardcoded target baked into config.
- **Download**: streams the backup archive to the browser so it saves to the operator's Mac.
- **Delete**: removes a backup volume via the Proxmox API.
- **Retention policy**: per-VM/CT configurable rule (keep last N, or max age in days), applied automatically after each successful backup run.

### Quick Actions

- Start/stop/reboot buttons on the existing Proxmox VM/CT widget cards, via the same API token already used for backups — no additional credential.

### Alerting

- Trigger conditions: SMART health != PASSED, any disk usage > 90%, a backup job failure.
- Delivery: email via the postfix instance already running locally on `lxc200` (no external mail service needed), with ntfy.sh as an optional second channel.

### Resource/Load History

- Lightweight mini trend graphs (CPU, RAM, temperature, and backup size over time) on relevant cards, not just instantaneous values — the same value lxc-automat provided via `stats_history.json`/`temp_history.json`.
- Storage: rolling-window JSON file(s), same lightweight pattern as lxc-automat used — no database.

## Auth

- Homepage's existing optional password login, extended with a custom TOTP 2FA layer (`pyotp`-equivalent flow: QR code at setup, verified 6-digit code at login, optional) — mirrors the proven pattern from lxc-automat's installer wizard.
- Recommended (operator-side, not code): put Cloudflare Access in front of the Cloudflare Tunnel hostname for a second, edge-level auth layer. Documented in the repo README as a recommended deployment step, not implemented in-app.

## Visual Design

Validated against real Homepage screenshots (not assumption):

- **Base theme:** Glass + Wallpaper (Homepage's frosted-glass card style over a background image), as opposed to Homepage's flat light/dark alternatives.
- **Accent color:** defaults to violet (matching lxc-automat's existing brand color `#7c6ff7`), but the `color` setting is left **unlocked** so the operator can switch between Homepage's full 20-color palette at any time from the UI — not a build-time decision.
- New Disks/SMART and Backups cards are built from Homepage's existing card/icon/stat-pill/status-dot component language so they read as native, not bolted on.

## Data Storage & Secrets

- Config (Proxmox host/node, API token, SSH key path, dashboard credentials, TOTP secret) stored locally on the host, `.gitignore`'d — never committed, matching lxc-automat's existing pattern.
- Time-series history stored as rolling-window local JSON, no external DB dependency.

## Testing

- Manual verification against the real lxc200 + Proxmox host (10.0.1.9) environment for: disk auto-detection, SMART reads, backup run/list/download/delete round-trip, retention cleanup, quick actions (start/stop/reboot on a non-critical CT), alert delivery via postfix, TOTP login flow.
- No production data at risk beyond what's already backed up; backup-delete actions should be tested against a manually-created throwaway backup first, not the only existing VM 100 backup.

## Resolved During Planning (codebase research findings)

- **Config:** hand-edited YAML files under `config/` (Docker volume mount), no in-app settings UI — matches Homepage's existing convention for every other integration. `config/proxmox.yaml` already has a skeleton/precedent (`getProxmoxConfig()` in `src/utils/config/proxmox.js`); new `config/backups.yaml` / `config/disks.yaml` follow the same pattern.
- **Homepage internals:** Next.js Pages Router. Read-only widgets live in `src/widgets/<name>/{widget.js,component.jsx}`, credentials injected server-side only via `src/utils/proxy/handlers/credentialed.js`. The existing `src/pages/api/proxmox/stats/[...service].js` route (validate params → `getProxmoxConfig()` → build `PVEAPIToken=` header → proxy → JSON) is the direct template for our new Disks/Backups API routes. New top-level pages are trivial (`src/pages/backups.jsx` → `/backups`).
- **Auth:** NextAuth.js, JWT session, single global password (`HOMEPAGE_AUTH_PASSWORD`, SHA-256 + timing-safe compare), gated by `HOMEPAGE_AUTH_ENABLED`. Sign-in page `src/pages/auth/signin.jsx`. No TOTP precedent anywhere — needs the `otplib` npm package (Node has no built-in TOTP) and a new `HOMEPAGE_TOTP_SECRET` env var, verified inside the `CredentialsProvider.authorize()` callback after the password check.
- **⚠️ No write/action pattern exists anywhere in Homepage** — every widget is read-only display. Quick Actions (start/stop/reboot) and Backup run/delete are genuinely new UI + API patterns for this codebase, not a copy of an existing button. Budget real design and build time for these, not a trivial add-on. The API route _shape_ (param validation → auth header → proxy call → JSON) is reusable from the read-only routes; only the HTTP verb and the button/confirmation UI are new.
- **Build:** Node 22, **pnpm only** (`npx only-allow pnpm` preinstall hook — npm/yarn fail immediately), multi-stage Dockerfile, Next.js `standalone` output, build via webpack (not Turbopack).
- **Testing:** Vitest. Convention: `widget.test.js` next to `widget.js` using the shared `expectWidgetConfigShape()` helper from `src/test-utils/widget-config.js`; `component.test.jsx` for component tests.
