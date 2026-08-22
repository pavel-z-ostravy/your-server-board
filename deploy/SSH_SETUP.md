# Restricted SSH key setup (Proxmox host)

This key can only run `lsblk`, `smartctl -j -a <device>`, `df`, `lvs`,
`pvs`, a fixed host-level `ps` (process listing for the Proxmox host
itself), or `pct exec <vmid> -- ...` (process listing and OS-release probe
for a specific container) (each a single fixed, read-only, parameterless,
path-validated, or vmid-validated command) — nothing else — enforced
server-side by a forced command, not just by client-side discipline.

If you ran `./install.sh`, it already did step 1 for you and printed the
step 2/3 instructions on screen — it does not copy the script or edit
`authorized_keys` itself, so do steps 2-3 manually before continuing.

## Upgrading from an earlier version

Already set this up before and just pulled a new version of the app? Re-run
step 2 below (re-copy `deploy/proxmox-smart-helper.sh` to the Proxmox host)
whenever this file changes. The forced-command script lives on the Proxmox
host, not on the app's own host, so deploying a new version of the app does
NOT update it automatically. If you skip this, LXC process/OS-detail fetches and the Proxmox host's own
Details toggle will fail with `refused: command not permitted for this key`
until you re-copy the script.

1. Generate a dedicated keypair (run on your workstation, not the Proxmox host).
   Generate it under `config/ssh/` (gitignored) — not the repo root, which is
   NOT gitignored and would leave an unprotected private key one `git add .`
   away from being committed:

   ```bash
   mkdir -p config/ssh
   ssh-keygen -t ed25519 -f config/ssh/id_smart -N "" -C "your-server-board-smart-reader"
   ```

2. Copy `deploy/proxmox-smart-helper.sh` to the Proxmox host and make it executable:

   ```bash
   scp deploy/proxmox-smart-helper.sh proxmox:/usr/local/bin/your-server-board-smart-helper.sh
   ssh proxmox 'chmod 755 /usr/local/bin/your-server-board-smart-helper.sh'
   ```

3. Append the public key to `/root/.ssh/authorized_keys` on the Proxmox host,
   prefixed with the forced command and restriction flags:

   ```
   command="/usr/local/bin/your-server-board-smart-helper.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...<paste-generated-pubkey-here> your-server-board-smart-reader
   ```

   SMART data requires raw block device access, which in practice means root
   on Proxmox — there's no standard non-root group for it. The forced command
   is what makes this safe to expose behind a public tunnel: the key is root,
   but it is _only_ able to run the whitelisted read-only commands above.

4. The private key already lives at `config/ssh/id_smart` (gitignored — never
   commit it) from step 1. Uncomment and fill in the `smart:` block in
   `config/proxmox.yaml` (see `src/skeleton/proxmox.yaml` for the shape) to
   point at this key — the Disks section on the dashboard reads that block
   and will show a 500/error state until it's filled in.
