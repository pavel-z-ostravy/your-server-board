# Notice

your-server-board is a derivative work of [gethomepage/homepage](https://github.com/gethomepage/homepage),
licensed under the GNU General Public License v3.0 (see `LICENSE`).

This fork is adding (planned) — none of these are user-facing yet, see
`README.md`'s Status section for current state:
- Disks & SMART health monitoring (auto-detected, not in upstream)
- Backup lifecycle management for Proxmox VMs/CTs (list, run, download, delete, retention)
- Quick VM/CT actions (start/stop/reboot)
- TOTP-based 2FA login
- SMART/disk/backup-failure alerting

Currently built, as original/new code not derived from upstream:
- A restricted-SSH client for disk/SMART queries (`src/utils/ssh/smartClient.js`),
  built and verified but not yet wired into any route or UI

(The Proxmox VE widget itself is pre-existing upstream Homepage functionality —
this fork deploys and configures it against a real cluster, but did not
originate it.)

Everything else is unmodified or lightly modified upstream Homepage functionality,
available under its original GPL-3.0 terms.
