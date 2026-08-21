<p align="center">
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  &nbsp;
  <a href="https://github.com/gethomepage/homepage"><img alt="Fork of gethomepage/homepage" src="https://img.shields.io/badge/fork%20of-gethomepage%2Fhomepage-7c6ff7"></a>
  &nbsp;
  <a href="https://github.com/pavel-z-ostravy/your-server-board/commits/dev"><img alt="Last commit" src="https://img.shields.io/github/last-commit/pavel-z-ostravy/your-server-board"></a>
</p>

# your-server-board

A self-hosted homelab dashboard for Proxmox — forked from [Homepage](https://github.com/gethomepage/homepage)
and extended with real disk-health monitoring and Proxmox backup lifecycle
management, the two things a homelab operator actually needs from a status
dashboard that Homepage doesn't provide out of the box. Everything Homepage
already does — 100+ service widgets, bookmarks, search, weather, full
theming — still works, unmodified.

License: **GPL-3.0**, inherited from upstream. See [`NOTICE.md`](NOTICE.md)
for exactly what in this repo is original vs. derivative.

## Status

- **Foundation deployed and live.** The app runs as a Docker container on a
  real homelab host, connected to a real Proxmox cluster via API token, and
  the Proxmox VE widget renders real VM/CT/CPU/memory data.
- **Disks & SMART health monitoring deployed and live.** The Disks section
  on the main dashboard and `/api/disks` route (built on top of the
  restricted-SSH `src/utils/ssh/smartClient.js` client from Foundation) are
  live in the deployed container, wired to a real restricted-command SSH key
  on a real Proxmox host. `/api/disks` returns real per-drive SMART data —
  model, size, temperature, health status — confirmed against real hardware
  (a SATA SSD and a USB-enclosure NVMe drive), both reporting
  `"status": "ok"`.
- **Not yet implemented — tracked as separate follow-up plans**
  (see `docs/superpowers/plans/`):
  - Backup lifecycle management for Proxmox VMs/CTs (list/run/download/delete, retention)
  - Quick VM/CT actions (start/stop/reboot)
  - TOTP-based 2FA login
  - SMART/disk/backup-failure alerting and load history

## Getting Started (your own server)

1. Clone this repo onto the machine that will run the dashboard container.
2. Run `./install.sh` — it walks you through the host/port you'll access it
   at, generates a restricted SSH key for disk-health queries, and tells you
   exactly what to add to your Proxmox host's `authorized_keys`.
   (Optional: edit `.env` first if you want a port other than the default
   3050 — `YSB_PORT` in `.env.example`.)
3. Edit `config/proxmox.yaml` (created from a template on first run) with
   your Proxmox host URL and an API token. Create one with:
   ```bash
   pveum user token add root@pam your-server-board --privsep 0
   ```
   This token inherits full `root@pam` privileges. Before exposing this
   dashboard publicly (e.g. via a Cloudflare Tunnel), replace it with a
   token scoped to a custom least-privilege Proxmox role — verify exact
   privilege names against current Proxmox ACL docs when doing so, rather
   than guessing them.

   Also uncomment and fill in the `smart:` block in the same file, pointing
   at the SSH key `install.sh` just generated — see
   [`deploy/SSH_SETUP.md`](deploy/SSH_SETUP.md) for the remaining setup on
   the Proxmox host. Without it, the Disks section on the dashboard shows an
   error instead of disk health data.
4. `docker compose restart`

Prefer to do it by hand instead of `./install.sh`? See
[`deploy/SSH_SETUP.md`](deploy/SSH_SETUP.md) for the manual restricted-key
setup, and `docker-compose.yml` + `.env.example` for the raw Docker Compose
invocation (`docker compose up -d --build` once `.env` is filled in).

**Security note:** by default the dashboard has no login at all — anyone who
can reach the port can use it. Homepage's own optional password gate
(`HOMEPAGE_AUTH_ENABLED`/`HOMEPAGE_AUTH_PASSWORD`) works today; TOTP 2FA on
top of it is planned (see Status above) but not built yet. Don't expose this
past your LAN without at least the password gate, and ideally an
authenticating reverse proxy or tunnel (Cloudflare Access, Authelia, etc.)
in front of it too.

## What this fork adds on top of Homepage

| Area | Upstream Homepage | This fork |
|---|---|---|
| Service widgets, bookmarks, search, theming, i18n | ✅ full support | unchanged |
| Proxmox VM/CT status widget | ✅ read-only | unchanged (used for the live data above) |
| Disk health (SMART) | ❌ none | ✅ live (dashboard section + `/api/disks`) |
| Drag-and-drop section reordering | ❌ none | ✅ live (drag whole dashboard sections into any order) |
| Backup lifecycle (list/run/download/delete/retention) | ❌ none | planned |
| VM/CT power actions | ❌ none | planned |
| Login | optional password only | password today, TOTP 2FA planned |
| Alerting | ❌ none | planned (SMART/disk/backup-failure via email) |

For everything in the "unchanged" row — the config format, the 100+
third-party service integrations, custom CSS/JS, layout options — the
[official Homepage documentation](https://gethomepage.dev/) is accurate and
still applies; this fork hasn't touched any of it.

## Development

Next.js app, **pnpm only** (`npx only-allow pnpm` blocks npm/yarn):

```bash
git clone https://github.com/pavel-z-ostravy/your-server-board.git
cd your-server-board
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
pnpm test     # Vitest
pnpm build    # next build --webpack
pnpm lint
```

## Support

Bugs or questions about this fork's Proxmox/disk/backup features:
[open an issue](https://github.com/pavel-z-ostravy/your-server-board/issues)
on this repo.

Questions about the underlying Homepage config engine, widgets, or themes
(anything in the "unchanged" row above) are better answered by the upstream
project directly: their
[documentation](https://gethomepage.dev/), [Discord](https://discord.gg/k4ruYNrudu),
and [discussions](https://github.com/gethomepage/homepage/discussions) — this
is a small personal fork, not a general Homepage support channel.

## License & Attribution

GPL-3.0, inherited from [gethomepage/homepage](https://github.com/gethomepage/homepage)
— see [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md). Thanks to the
Homepage project and its 200+ contributors; this fork exists because their
dashboard was worth building on.
