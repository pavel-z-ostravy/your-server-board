# Restricted SSH key setup (Proxmox host)

This key can only run `lsblk` or `smartctl -j -a <device>` — nothing else —
enforced server-side by a forced command, not just by client-side discipline.

1. Generate a dedicated keypair (run on your workstation, not the Proxmox host):
   ```bash
   ssh-keygen -t ed25519 -f ./your-server-board-smart-key -N "" -C "your-server-board-smart-reader"
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

4. Copy the **private** key into this app's config volume as `config/ssh/id_smart`
   (gitignored — never commit it). The app reads it via `privateKeyPath` in
   `config/proxmox.yaml`.
