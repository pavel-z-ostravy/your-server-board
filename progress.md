# Progress Log

**Status: work in progress — not a finished/production-ready project.** This
file tracks what's actually shipped and deployed vs. what's still planned.
See the README's own "Status" section for the short version aimed at
visitors; this file is the fuller running log.

## Shipped & deployed (live on `lxc200`, `dev` branch)

- **Foundation** — Docker container on a real homelab host, real Proxmox
  API token connection, live VM/CT/CPU/memory data via the Proxmox VE
  widget.
- **Disks & SMART health monitoring** — dashboard section + `/api/disks`,
  backed by a restricted-command SSH key to the Proxmox host. Confirmed
  against real hardware.
- **Drag-and-drop dashboard layout** — reorder whole dashboard sections,
  persisted to `config/layout-order.yaml`.
- **Proxmox host status header** — CPU/RAM/disk/uptime/PVE version/load,
  above the VM/LXC card grid.
- **Proxmox host IP + process detail** — host IP address shown in the
  header; a "Details" toggle on the host card lists top host-level
  processes via a second restricted SSH allowlist entry.
- **Hamburger menu + widgets catalog (`/widgets`)** — persistent nav menu;
  a searchable catalog of every Homepage widget type (service + info),
  synced live from the upstream `gethomepage/homepage` GitHub repo, with
  copy-to-clipboard YAML examples.
- **Widget one-click install** — an "Install..." button next to each
  catalog entry's "Copy" button opens a wizard that writes the widget's
  config directly into the user's real `services.yaml` (attach to an
  existing service, or add as a new service into an existing/new group) or
  `widgets.yaml` (info widgets, append). Every write is preceded by an
  automatic timestamped backup and a server-side re-parse/re-load validation
  (both the `yaml` package and `js-yaml`, matching what the app actually
  reads with) before committing to disk. Gated behind a disclaimer and a
  required "I understand the risk" checkbox. **Explicitly phase 1 of a
  two-phase plan** — this phase adds no new authentication/authorization;
  anyone who can already reach the dashboard can now also write to its
  config through this feature. Hardening (auth around the write path) is
  planned as a separate follow-up, not yet built.
  - Spec: `docs/superpowers/specs/2026-08-23-widget-install-design.md`
  - Plan: `docs/superpowers/plans/2026-08-23-widget-install.md`

## Not yet implemented — tracked as separate follow-up plans

- **Security hardening for the widget-install write path** (phase 2 of the
  install feature above) — authentication/authorization around
  `POST /api/widgets-catalog/install` and `GET /api/widgets-catalog/services`.
- Backup lifecycle management for Proxmox VMs/CTs (list/run/download/delete,
  retention)
- Quick VM/CT actions (start/stop/reboot)
- TOTP-based 2FA login
- SMART/disk/backup-failure alerting and load history

## Known rough edges (deferred, non-blocking, see plan/spec files for detail)

- `yamlDocument.js`'s four navigation functions have some internal loop
  duplication that could be factored into a shared iterator (Minor,
  cosmetic).
- No client-side pre-validation of a widget's YAML example before the
  final "Install" click — a malformed upstream doc example (rare, but
  possible across ~170 independently authored files) surfaces its error
  only at the last wizard step, not the preview step.
- Attach-mode silently overwrites an existing `widget:` block on the target
  service with no explicit warning beyond "this writes to your config file"
  in the general disclaimer.
- Concurrent installs are last-writer-wins (no locking) — acceptable for a
  single-user homelab dashboard; the automatic backup covers recovery.
- No in-app restore UI for the timestamped `.bak` files — restoring a
  backup after a bad install is a manual file operation today.

## How this project is being built

Every feature above went through a full brainstorm → written spec → written
implementation plan → subagent-driven-development execution (fresh
implementer + reviewer subagent per task, whole-branch final review) →
merge → CI → redeploy cycle. Specs and plans for every shipped and planned
feature live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.
