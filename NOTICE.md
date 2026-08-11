# Notice

your-server-board is a derivative work of [gethomepage/homepage](https://github.com/gethomepage/homepage),
licensed under the GNU General Public License v3.0 (see `LICENSE`).

This fork adds:
- Disks & SMART health monitoring (auto-detected, not in upstream)
- Backup lifecycle management for Proxmox VMs/CTs (list, run, download, delete, retention)
- Quick VM/CT actions (start/stop/reboot)
- TOTP-based 2FA login
- SMART/disk/backup-failure alerting

Everything else is unmodified or lightly modified upstream Homepage functionality,
available under its original GPL-3.0 terms.
