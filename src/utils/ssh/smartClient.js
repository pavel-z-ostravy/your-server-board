import { readFileSync } from "node:fs";

import { Client } from "ssh2";

const DEVICE_PATTERN = /^\/dev\/(sd[a-z]|nvme\d+n\d+)$/;

// Timeout for the whole SSH round trip (connect + command completion). A
// hung connect or an unresponsive remote command must not block the caller
// indefinitely — this module is expected to eventually be called from a
// Next.js API route serving a public-facing dashboard. Kept as a
// module-level constant so it's easy to find and adjust.
export const SSH_COMMAND_TIMEOUT_MS = 15000;

// Resolves with { stdout, stderr, code } — it never rejects on a non-zero
// exit code itself. What counts as "success" is command-specific (see
// getSmartData vs. listBlockDevices below), so that decision is left to the
// caller. It does reject if the connection/exec itself fails, or if the
// command doesn't complete within timeoutMs.
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

export async function listBlockDevices(sshConfig) {
  const { stdout, stderr, code } = await execCommand(sshConfig, "lsblk -J -o NAME,SIZE,TYPE,MODEL,MOUNTPOINT,ROTA");
  if (code !== 0) {
    throw new Error(`Command exited with code ${code}: ${stderr}`);
  }
  return JSON.parse(stdout);
}

export async function getSmartData(sshConfig, devicePath) {
  if (!DEVICE_PATTERN.test(devicePath)) {
    throw new Error(`Refusing to query unsafe device path: ${devicePath}`);
  }
  const { stdout, stderr, code } = await execCommand(sshConfig, `smartctl -j -a ${devicePath}`);
  // smartctl's exit status is a bitmask — bit 3 (disk failing), bit 4
  // (prefail attribute below threshold), bit 6 (errors in the error log)
  // and bit 7 (self-test failures) are all non-zero exits that still come
  // with a complete, valid JSON payload on stdout. That's exactly the
  // condition this feature exists to detect, so a non-zero exit code alone
  // must never discard otherwise-valid data. `smartctl -j` reports its own
  // exit status inside the JSON payload (`smartctl.exit_status`) for
  // callers that want it, so the shell exit code doesn't need to be
  // inspected here at all once JSON parsing succeeds. Only genuine
  // invocation failures (no such device, permission denied, etc.) — which
  // produce unparseable or empty stdout — should reject.
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse smartctl output (exit code ${code}): ${stderr || stdout}`);
  }
}
