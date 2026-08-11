# Restricted SSH key setup (Proxmox host)

This key can only run `lsblk` or `smartctl -j -a <device>` — nothing else —
enforced server-side by a forced command, not just by client-side discipline.

If you ran `./install.sh`, it already did step 1 for you and printed the
step 2/3 instructions on screen — it does not copy the script or edit
`authorized_keys` itself, so do steps 2-3 manually before continuing.

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
   but it is *only* able to run the two whitelisted read-only commands above.

4. The private key already lives at `config/ssh/id_smart` (gitignored — never
   commit it) from step 1. A future update will read this from
   `config/proxmox.yaml` (see the commented `smart:` block in
   `src/skeleton/proxmox.yaml` for the intended shape) — for now, nothing
   wires it into the app yet, so `install.sh` just places it there for that
   future wiring to use. `src/utils/ssh/smartClient.js` (`listBlockDevices`,
   `getSmartData`) already knows how to use a key at this path once called,
   it just isn't called from anywhere yet.

   Note: because nothing currently imports `smartClient.js`, Next.js's
   standalone build output excludes it from the deployed container image —
   this is expected and will resolve automatically once a future task wires
   it into an API route. Don't be surprised if
   `docker exec ... node -e "require('./smartClient')"` fails with
   `MODULE_NOT_FOUND` in the meantime.
