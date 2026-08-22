import { readFileSync } from "node:fs";

import { Client } from "ssh2";

export const SSH_COMMAND_TIMEOUT_MS = 15000;

function execCommand(sshConfig, command, timeoutMs = SSH_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(new Error(`SSH command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

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
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code) => {
              conn.end();
              settle(resolve, { stdout, stderr, code });
            })
            .on("data", (data) => {
              stdout += data.toString();
            });
          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
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

// No vmid, no interpolation of anything - this command is fixed and targets
// the Proxmox host itself, not a container, so there is nothing to validate.
export async function getHostProcesses(sshConfig) {
  const { stdout, stderr, code } = await execCommand(sshConfig, "ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu");
  if (code !== 0) {
    throw new Error(`Command exited with code ${code}: ${stderr}`);
  }
  return stdout;
}
