import { readFileSync } from "node:fs";

import { Client } from "ssh2";

// Same shape as smartClient.js's execCommand, but resolves with the live
// stream instead of buffering it - a backup archive can be many GB, and
// smartClient's execCommand accumulates stdout into a single string, which
// would be wrong here. This constant only bounds the connect+exec-launch
// phase, not the data transfer itself - once resolved, the caller owns the
// stream and its lifetime.
export const SSH_CONNECT_TIMEOUT_MS = 15000;

const VOLID_PATTERN =
  /^[A-Za-z0-9_-]+:backup\/vzdump-(qemu|lxc)-\d+-\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.(vma(\.(gz|zst))?|tar(\.(gz|zst))?)$/;

// Shared connect/exec/settle skeleton for both streamBackupFile and
// streamConfigBackup below - each just picks a different forced-command
// string to run on the same restricted SSH key.
function execAndStreamCommand(sshConfig, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(new Error(`SSH connection timed out after ${SSH_CONNECT_TIMEOUT_MS}ms`));
    }, SSH_CONNECT_TIMEOUT_MS);

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            settle(reject, err);
            return;
          }
          settle(resolve, { stream, conn });
        });
      })
      .on("error", (err) => {
        conn.end();
        settle(reject, err);
      })
      .connect({
        host: sshConfig.host,
        port: sshConfig.port ?? 22,
        username: sshConfig.username,
        privateKey: readFileSync(sshConfig.privateKeyPath),
      });
  });
}

export function streamBackupFile(sshConfig, volid) {
  if (!VOLID_PATTERN.test(volid)) {
    return Promise.reject(new Error(`Refusing to stream unsafe backup path: ${volid}`));
  }

  return execAndStreamCommand(sshConfig, `cat-backup ${volid}`);
}

// No parameters at all - the forced command on the Proxmox host runs a
// single fixed `tar czf - -C / etc/pve`, so there's nothing here to validate.
export function streamConfigBackup(sshConfig) {
  return execAndStreamCommand(sshConfig, "pve-config-backup");
}
