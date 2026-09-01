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
  config through this feature when `HOMEPAGE_AUTH_ENABLED=false` (it was the
  default when this shipped; login is on by default as of the default-on
  login entry below) — see "Widget-install write path hardening" below for
  what happens when auth is on.
  - Spec: `docs/superpowers/specs/2026-08-23-widget-install-design.md`
  - Plan: `docs/superpowers/plans/2026-08-23-widget-install.md`
- **Widget uninstall** — a trash-can icon on any live dashboard service card
  that currently has a widget removes just that service's `widget:` block
  (the service tile itself stays, reverting to a plain link card), with a
  lightweight inline confirm instead of a wizard. The `/widgets` catalog page
  shows an "Installed on:" list with a trash-can per instance for every
  installed entry, covering both service widgets and info widgets
  (`resources`, `datetime`, `search`, ...) — info widgets have no
  dashboard-side removal affordance yet, only the catalog page. Every removal
  reuses the same backup-before-write, re-parse-validated
  `configWriter.writeConfigDocument` the install feature already uses.
  - Spec: `docs/superpowers/specs/2026-08-23-widget-uninstall-design.md`
  - Plan: `docs/superpowers/plans/2026-08-23-widget-uninstall.md`
- **Widget-install write path hardening** (phase 2 of the install feature
  above) — turned out the global `middleware.js` already gates every route,
  including the widgets-catalog install/uninstall/services/installed
  endpoints, whenever `HOMEPAGE_AUTH_ENABLED` is on: a route handler with its
  own session check would never even run, since middleware intercepts first.
  The actual gap was UX, not authorization — an unauthenticated `fetch()` to
  any JSON API route followed the signin redirect and got HTML back,
  breaking `res.json()` with a confusing parse error instead of a clean 401.
  Fixed at the middleware level: unauthenticated requests to any `/api/...`
  path now get `401 { error: "Unauthorized" }` instead of a redirect; page
  routes still redirect to `/auth/signin` as before. Deliberately scoped to
  this fix — Pavel declined the larger alternative of a separate write-gate
  that would apply even with auth turned off, since that would contradict
  this project's documented "no login at all by default" model.
- **Backup lifecycle management** — a new `/backups` page lists every VM/CT
  with an expandable table of its Proxmox backups (date, size, storage,
  read-only retention from that storage's `prune-backups`), plus buttons to
  trigger an immediate ad-hoc backup, download a backup (streamed through a
  new forced-command SSH capability, never buffered — a backup archive can be
  many GB), and delete one (gated by a type-to-confirm dialog, stricter than
  the widget-uninstall feature's lightweight confirm, since losing a backup
  is a more serious mistake). This is the first feature in this codebase that
  mutates real state on the Proxmox host — everything before it was
  read-only. Development caught and fixed a real path-traversal bug in the
  first draft of the new forced-command's filename validation, and a real
  regex bug that broke the run→poll flow 100% of the time in production
  (surfaced only by the whole-branch final review, invisible to every
  task-level test). Live-verified against the real Proxmox host: real
  backups list correctly, the forced-command's security boundary rejects a
  crafted path-traversal payload, and an ad-hoc backup was triggered for
  real via `/backups`.
  - Spec: `docs/superpowers/specs/2026-08-25-backup-lifecycle-design.md`
  - Plan: `docs/superpowers/plans/2026-08-25-backup-lifecycle.md`
- **NextDNS widget enhancements** — surfaces account-level context that
  disappeared when switching to `widget.view: devices`: total queries,
  blocked queries, the NextDNS config ID, and the profile's DNS server
  addresses (IPv6 first, then the generic IPv4 anycast pair, since NextDNS
  doesn't expose per-profile IPv4 addresses). Verified against the real
  NextDNS dashboard. Laid out as two visual rows — an account-summary row,
  then the per-client breakdown — after a single combined row read as
  confusing once both were present.
- **Page styling/theme unification** — `/widgets` and `/backups` now match
  the dashboard: same card classes, same wallpaper background, and the same
  color/theme settings from `settings.yaml` (previously only the dashboard
  applied them). Caught a real bug in the process: both pages used
  `getStaticProps`, which this Docker image's multi-stage build evaluates
  *before* the real `config/` volume is mounted, so they silently served
  whatever the auto-copied template config contained at build time, not the
  user's actual settings — fixed by switching both to
  `getServerSideProps`. Nav order changed so Backups appears above Widgets.
- **Proxmox host configuration backup** — a "Proxmox Configuration" card at
  the top of `/backups` streams a fresh `tar` of `/etc/pve` (the
  cluster/storage/VM-config filesystem the Proxmox host itself relies on,
  not a VM/CT disk image) on demand, through a new parameterless
  forced-command SSH entry. Tiny and cheap to generate compared to a VM/CT
  backup, so there's no list/run/delete lifecycle, just download.
- **Mobile responsiveness fixes** — three bugs found testing at a real
  390×844 viewport (Chrome's OS-window resize floor at 500px had been
  silently masking all three in earlier "mobile" checks): (1) the shared
  widget `Block`/`Container` components let flex items shrink without
  limit, so a widget with many fields (e.g. NextDNS's 7 blocks) crammed
  onto one line and either overflowed the page horizontally, or — once
  `flex-wrap`/`min-w-0` were added — shrank to unreadable ~47px columns
  where multi-character values wrapped one character per line; fixed with a
  real `min-width` (84px) so rows wrap into a readable grid instead; (2)
  the hamburger nav button had no top clearance on mobile, overlapping the
  page heading on `/widgets`/`/backups` and the resource-stats row on the
  dashboard; (3) the hamburger button is a sibling of the scrollable
  content container, absolutely positioned against the document root
  rather than the viewport, so it never scrolls away — with no background
  at rest it visually merged with whatever content scrolled underneath it
  (e.g. the Proxmox card's "Host" label). Fixed with a persistent
  semi-opaque backdrop.
- **Username + password + optional TOTP 2FA login** — the password login
  gate now takes a username *and* a password. **BREAKING:** existing
  deployments that only set `HOMEPAGE_AUTH_PASSWORD` must now also set
  `HOMEPAGE_AUTH_USERNAME`, or password auth refuses to start. An optional
  authenticator-app second factor is enrolled from a new **Security** page
  (reachable from the nav menu): scan a QR code, confirm a 6-digit code,
  done. Sign-in becomes two-step — username/password, then (if 2FA is on) a
  code prompt — driven by a session-less `POST /api/auth/2fa-check`
  pre-check (later removed — the 2FA-on flag moved server-side into the
  sign-in page's `getServerSideProps`). 2FA state lives in an app-managed
  `config/auth.json` (mode
  `0600`, corrupt/missing → treated as disabled); recovery from a lost
  authenticator is deleting or emptying that file. No recovery codes.
  - Spec: `docs/superpowers/specs/2026-08-31-dashboard-2fa-login-design.md`
  - Plan: `docs/superpowers/plans/2026-08-31-dashboard-2fa-login.md`
- **Default-on login + `admin`/`admin` bootstrap + credential wizard** —
  the dashboard login gate is now **on by default**. First server start
  with no `config/auth.json` and no auth env vars creates a bootstrap user
  `admin` / `admin` and auto-generates the NextAuth session signing secret
  into `config/auth.json` (mode `0600`); the console prints a one-time box
  telling the operator to change the credentials. Every page then shows a
  non-dismissible red banner (`role="alert"`) until the password is
  changed, at `/security` → a new **Account** card whose wizard verifies
  the current password, sets a new username + password, and optionally
  walks straight into 2FA enrolment as step 2 (the standalone 2FA card
  stays too). `authorize()` gained an in-process progressive-delay
  brute-force throttle (5 wrong passwords → a growing block, capped 30s, no
  hash evaluation and no log line while blocked; a failed 2FA code does not
  advance the counter). The session-less `POST /api/auth/2fa-check`
  endpoint was **deleted** — the sign-in page reads the 2FA-on flag
  server-side in `getServerSideProps` instead. Password mode no longer
  needs `HOMEPAGE_EXTERNAL_URL` (still required for OIDC and for `Secure`
  cookies on HTTPS). Recovery from a forgotten password: `rm
  config/auth.json` (or delete just the `user` key) and restart.
  **BREAKING #1:** any deployment that did *not* set
  `HOMEPAGE_AUTH_ENABLED` now shows a login screen — set
  `HOMEPAGE_AUTH_ENABLED=false` to keep no login. **BREAKING #2:**
  `/api/mcp` gates its session check on `isAuthEnabled()`, so with auth
  default-on the MCP endpoint now needs a bearer token *or* a session
  unless `HOMEPAGE_AUTH_ENABLED=false` (the `HOMEPAGE_MCP_TOKEN` path is
  unaffected).
  - Spec: `docs/superpowers/specs/2026-09-01-default-admin-and-credential-wizard-design.md`
  - Plan: `docs/superpowers/plans/2026-09-01-default-admin-and-credential-wizard.md`
- **Card visibility/contrast pass** — the card background/shadow shared by
  Disks, Proxmox, Backups, and Widgets was subtle enough to be hard to
  distinguish from the page background; bumped background opacity and
  shadow one notch and added a hairline border on all four. The Proxmox
  "Host" summary previously had no card background at all (just a bottom
  divider) despite sitting directly above VM/CT cards that do have one —
  given the same card treatment for visual consistency.

## Not yet implemented — tracked as separate follow-up plans

- Quick VM/CT actions (start/stop/reboot)
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
- Backup download logs an error line even for a normal client-cancelled
  download (the SSH exit code is `null`, not `0`, on cancellation) — cosmetic
  log noise, not a functional defect.
- The "Backup running..." dialog has no way to close it if the status poll
  fails persistently (vs. transiently) — strictly better than the pre-fix
  behavior, but still no escape hatch beyond a page reload.
- A failed post-delete list revalidation isn't surfaced to the user (the
  delete itself succeeds and the dialog closes correctly either way).
- `pveGet`-style helpers are now duplicated across four files
  (`agentExec.js`, `backups.js`, `host/index.js`, `vms/index.js`) — worth
  consolidating into a shared module in a future cleanup pass.
- TOTP codes have no replay protection — a valid 6-digit code can be
  redeemed more than once within its 30s step. Acceptable for a single-user
  self-hosted dashboard; would matter if the acceptance window is ever
  widened or the deployment becomes multi-user.
- The `CARD_CLASS`/`STAT_CLASS` style strings are duplicated across five
  files (`disks/group.jsx`, `proxmox-vms/group.jsx`, `backups/vm-list.jsx`,
  `backups/config-backup.jsx`, `pages/widgets.jsx`) instead of a shared
  constant — every visual tweak (e.g. the contrast pass above) currently
  means editing all five in lockstep.

## How this project is being built

Every feature above went through a full brainstorm → written spec → written
implementation plan → subagent-driven-development execution (fresh
implementer + reviewer subagent per task, whole-branch final review) →
merge → CI → redeploy cycle. Specs and plans for every shipped and planned
feature live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.
