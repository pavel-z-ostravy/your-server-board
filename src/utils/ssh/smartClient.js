import { readFileSync } from "node:fs";

import { Client } from "ssh2";

const DEVICE_PATTERN = /^\/dev\/(sd[a-z]|nvme\d+n\d+)$/;

function execCommand(sshConfig, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code) => {
              conn.end();
              if (code !== 0) {
                reject(new Error(`Command exited with code ${code}: ${stderr}`));
                return;
              }
              resolve(stdout);
            })
            .on("data", (data) => {
              stdout += data.toString();
            });
          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
        });
      })
      .on("error", reject)
      .connect({
        host: sshConfig.host,
        port: sshConfig.port ?? 22,
        username: sshConfig.username,
        privateKey: readFileSync(sshConfig.privateKeyPath),
      });
  });
}

export async function listBlockDevices(sshConfig) {
  const output = await execCommand(sshConfig, "lsblk -J -o NAME,SIZE,TYPE,MODEL,MOUNTPOINT,ROTA");
  return JSON.parse(output);
}

export async function getSmartData(sshConfig, devicePath) {
  if (!DEVICE_PATTERN.test(devicePath)) {
    throw new Error(`Refusing to query unsafe device path: ${devicePath}`);
  }
  const output = await execCommand(sshConfig, `smartctl -j -a ${devicePath}`);
  return JSON.parse(output);
}
