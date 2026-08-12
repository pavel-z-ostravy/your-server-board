# VM/LXC Enrichment (processes + OS update info) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan introduces the first real exec-shaped capability in this codebase** (every prior plan was read-only status/config/df/lvs/pvs). Task 6 is a MANDATORY dedicated adversarial security review — do not skip it, do not fold it into the normal final whole-branch review, and do not treat it as optional because "the final review will catch it anyway." Dispatch it on the most capable available model with an explicitly adversarial brief, exactly as this plan's Task 6 specifies.

**Goal:** Add an expandable "Details" section to each VM/LXC card (built in Plan 3) showing its top 5 processes by CPU and its last OS update date (or "N/A") — fetched on demand when a user expands a card, not on every 60s dashboard poll.

**Architecture:** Two genuinely different, narrow, hardcoded-command execution paths — never a general-purpose exec primitive, matching the security discipline established in Foundation and re-applied in every subsequent plan:
- **QEMU**: the guest agent's `exec`/`exec-status` RPCs, reached over the existing Proxmox API token (no new SSH). The Next.js route sends a fixed, hardcoded `command` array — never anything derived from client input.
- **LXC**: `pct exec`, which has no Proxmox API equivalent (confirmed live during planning — see below), reached over the SAME restricted SSH key Plans 1-2 already extended, with two new forced-command branches using the exact validate-and-reconstruct pattern (extract a numeric vmid, validate strictly, substitute into a literal fixed template) already reviewed and shipped for `smartctl`'s device-path parameter.

A new on-demand route (`GET /api/proxmox/vm-detail`) is fetched only when a card's "Details" toggle is opened — Plan 3's existing `/api/proxmox/vms` route (still polled every 60s) is untouched and unaware this plan exists, so process-listing/exec calls never run in the background unprompted.

**Tech Stack:** Next.js 16 (Pages Router), React 19, Vitest, `ssh2` (existing), Proxmox REST API (existing token).

## Global Constraints

- Node 22, pnpm only. Test via `pnpm test` (Vitest, `vitest run`).
- **No general-purpose exec primitive, ever, for any user.** Every new capability this plan adds is exactly one fixed, named, read-only operation (list processes; read `/etc/os-release` + one update-timestamp file) — there is no way for a client to request anything else through either new code path. This is a hard constraint per the design spec, restated here because it's the single thing Task 6's adversarial review exists to verify.
- **QEMU path:** the `command` array sent to the guest agent's `/agent/exec` endpoint MUST be a JS constant baked into server code — never built from `req.query`, `req.body`, or any other client-controlled value. Only `node`/`vmid` (both strictly validated) select *which* guest the fixed command runs against.
- **LXC path:** every new `case` branch added to `deploy/proxmox-smart-helper.sh` extracts and validates the `vmid` parameter as `^[0-9]+$` *before* substituting it into a hardcoded command template — the exact pattern the existing `smartctl -j -a /dev/nvme...` branch already uses for its device-path parameter. No other part of the client-supplied command string is ever passed through to `exec`.
- Do not modify `src/pages/api/proxmox/vms/index.js` (Plan 3's route) — this plan's enrichment lives entirely in a new, separate, on-demand route. Do not modify the existing `lsblk`/`smartctl`/`df`/`lvs`/`pvs` case branches in `deploy/proxmox-smart-helper.sh`, or any existing export in `src/utils/ssh/smartClient.js`.
- Top-5-processes uses a custom `ps -eo pid=,pcpu=,pmem=,comm=` format (not `ps aux`) — `comm` (not the full command line) is deliberately used: it's a single, no-spaces token (trivial and safe to parse, no risk of embedded whitespace breaking column splitting) and it avoids surfacing full process argv (which can contain secrets — tokens, connection strings — passed as CLI args to some processes) on a dashboard that, like `/api/disks` and `/api/proxmox/vms` before it, may be running with no authentication at all.
- "Last OS update" is best-effort for apt/dpkg-based Linux only, exactly as the design spec's non-goals state — any other package manager, or an appliance OS with no apt (confirmed live: Home Assistant OS), reports `null` → UI renders "N/A". Do not attempt broader package-manager detection.
- No i18n in the new UI pieces — matches `DisksGroup`/`ProxmoxVmsGroup`'s established precedent.

## Real Data Verified During Planning

Checked directly against the real Proxmox API and the real Proxmox host (`ssh proxmox`, i.e. full admin SSH — NOT the restricted key, which can't run `pct exec` yet; that capability is exactly what this plan adds) before writing this plan:

- **`GET /nodes/proxmox/lxc/200/agent` → `{"message":"Method 'GET /nodes/proxmox/lxc/200/agent' not implemented"}`.** Confirms the design spec's claim: LXC genuinely has no API-level exec equivalent. `pct exec` over SSH is the only path.
- **QEMU guest-agent exec confirmed working end-to-end** against VM 100: `POST /nodes/proxmox/qemu/100/agent/exec` with **form-encoded, repeated `command` fields** (`command=ps&command=-eo&command=pid=,pcpu=,pmem=,comm=&command=--sort=-pcpu`, URL-encoded) returns `{"data":{"pid":180884}}`. Polling `GET .../agent/exec-status?pid=180884` (no delay needed for a command this fast, but poll — don't assume instant) returns `{"data":{"out-data":"...","err-data":"","exited":1,"exitcode":0,"out-truncated":0,"err-truncated":0}}`. **The `%` in `-pcpu`'s sort flag must be genuinely URL-encoded** (`%25` in the raw request) — an earlier attempt without proper encoding produced a `ps` usage error instead of the sort output, so a naive client-side implementation that doesn't url-encode form values correctly will silently break this specific flag.
- **Custom `ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu` output is clean and trivially parseable** — 4 whitespace-separated columns per line, no header (the `=` suffix on each `-eo` field name suppresses the column header in GNU `ps`), sorted CPU-descending:
  ```
     3368  0.8 18.4 python3
     5200  0.4  2.5 plugin_start_li
      395  0.3  0.1 bluetoothd
  ```
  `comm` truncates to 15 characters (`plugin_start_li` from `plugin_start_linux_amd64`) — this is `ps`'s standard `/proc/[pid]/comm` limitation, not a bug in this plan's command; acceptable for a dashboard glance view.
- **`pct exec 200 -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu`** (direct SSH, confirming the exact same command works identically via `pct exec` for LXC) returns the same clean 4-column format for `lxc-homelab`'s real processes (`redis-server`, `dockerd`, `immich`, `containerd`, ...).
- **The combined OS-release + update-timestamp probe works identically on BOTH guest types** — same exact command string, same exact output shape, confirmed live on all three real guests:
  - `pct exec 200 -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'` → real Debian 12 `os-release` block, then `---`, then `none` (this container's apt periodic timer has no success stamp — a real, live-confirmed "N/A" case, not hypothetical).
  - The identical command sent via QEMU guest-agent exec (`sh`/`-c`/the same string as three `command` array elements) against VM 100 (Home Assistant OS) works too — HAOS's minimal image still has a POSIX `sh`, returns real HAOS `os-release` fields, then `---`, then `none` (HAOS uses image-based `rauc` updates, no apt — matches the design spec's stated non-goal exactly).
  - Because the exact same command/output shape works for both guest types, **one shared pure parser handles both** (Task 3) — this is a deliberate simplification made possible by live-verifying the QEMU shell environment rather than assuming LXC-only.
- **`pct exec <nonexistent-vmid> -- ...` fails cleanly**: `pct exec 9999 -- ps aux` → `Configuration file 'nodes/proxmox/lxc/9999.conf' does not exist` on stderr, non-zero exit — confirms Proxmox's own error handling for a bad vmid is well-behaved (no crash, no ambiguous output), useful for this plan's own error-path design.
- **`src/components/services/item.jsx`'s `statsOpen`/`showStats` toggle** (the pattern the design spec pointed at for the expand/collapse interaction) uses an animated `max-h-0 opacity-0` ↔ `max-h-[Npx] opacity-100` transition with a separate `statsClosing` state for the close animation. This plan's `VmCard` Details toggle borrows the *affordance* (a button that reveals more info) but not the animation complexity — a plain conditional render is enough here and matches `DisksGroup`/`ProxmoxVmsGroup`'s already-established preference for simplicity over `item.jsx`'s more elaborate transitions.

## File Structure

- Modify: `deploy/proxmox-smart-helper.sh` — add 2 fixed-prefix/fixed-suffix, vmid-validated `case` branches for `pct exec`.
- Modify: `deploy/SSH_SETUP.md` — update the capability description again.
- Create: `src/utils/ssh/lxcClient.js` — new module (sibling to `smartClient.js`, NOT a modification of it, per the design spec's explicit guidance for this specific capability).
- Create: `src/utils/ssh/lxcClient.test.js`.
- Create: `src/utils/proxmox/agentExec.js` — QEMU guest-agent exec client (hardcoded command arrays, exec-status polling with timeout).
- Create: `src/utils/proxmox/agentExec.test.js`.
- Create: `src/utils/proxmox/processDetail.js` — shared pure parsers: `parseTopProcesses(stdout)`, `parseOsProbe(stdout)`.
- Create: `src/utils/proxmox/processDetail.test.js`.
- Create: `src/pages/api/proxmox/vm-detail/index.js` — new on-demand route.
- Create: `src/__tests__/pages/api/proxmox/vm-detail/index.test.js`.
- Modify: `src/components/proxmox-vms/group.jsx` — add a "Details" toggle + on-demand fetch to `VmCard`.
- Modify: `src/components/proxmox-vms/group.test.jsx`.

---

### Task 1: Restricted-SSH `pct exec` support

**Files:**
- Modify: `deploy/proxmox-smart-helper.sh`
- Modify: `deploy/SSH_SETUP.md`
- Create: `src/utils/ssh/lxcClient.js`
- Test: `src/utils/ssh/lxcClient.test.js`

**Interfaces:**
- Consumes: the SSH connection mechanism already established (this new file makes its own `ssh2` connections following `smartClient.js`'s exact `execCommand` shape — read `smartClient.js` first and copy the pattern; do not import from it, this is a deliberate sibling module per the design spec).
- Produces:
  - `export async function getLxcProcesses(sshConfig, vmid)` → resolves to raw stdout string (parsing happens in Task 3's shared parser, not here — keep this module's responsibility to "run the SSH command", not "understand `ps` output").
  - `export async function getLxcOsProbe(sshConfig, vmid)` → resolves to raw stdout string (same separation of concerns).
  - Both throw if `vmid` doesn't match `/^\d+$/` **before making any SSH connection** — client-side defense in depth, even though the server-side forced-command script is the real enforcement boundary.
  - Both throw on non-zero exit code, matching `listBlockDevices`'s convention.

The current `deploy/proxmox-smart-helper.sh` (read it first to confirm nothing has changed since Plan 2):

```sh
#!/bin/sh
# deploy/proxmox-smart-helper.sh
#
# Installed at /usr/local/bin/your-server-board-smart-helper.sh on the Proxmox
# host and bound to a dedicated SSH key via a forced `command=` entry in
# authorized_keys. That key can NEVER run anything except the exact
# operations below, regardless of what the client requests — OpenSSH ignores
# the client's requested command when `command=` is set and exposes it only
# via $SSH_ORIGINAL_COMMAND, which this script validates before acting on it.
set -eu

cmd="$SSH_ORIGINAL_COMMAND"

case "$cmd" in
  "lsblk -J -o NAME,SIZE,TYPE,MODEL,MOUNTPOINT,ROTA")
    exec lsblk -J -o NAME,SIZE,TYPE,MODEL,MOUNTPOINT,ROTA
    ;;
  "smartctl -j -a /dev/sd"[a-z])
    device="/dev/sd${cmd##*/dev/sd}"
    exec smartctl -j -a "$device"
    ;;
  "smartctl -j -a /dev/nvme"*)
    device="/dev/nvme${cmd##*/dev/nvme}"
    case "$device" in
      /dev/nvme[0-9]n[0-9]|/dev/nvme[0-9][0-9]n[0-9]|/dev/nvme[0-9]n[0-9][0-9]|/dev/nvme[0-9][0-9]n[0-9][0-9])
        exec smartctl -j -a "$device"
        ;;
      *)
        echo "refused: unsafe device path" >&2
        exit 1
        ;;
    esac
    ;;
  "df -B1 --output=source,target,fstype,used,size")
    exec df -B1 --output=source,target,fstype,used,size
    ;;
  "lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size")
    exec lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size
    ;;
  "pvs --noheadings -o pv_name,vg_name")
    exec pvs --noheadings -o pv_name,vg_name
    ;;
  *)
    echo "refused: command not permitted for this key" >&2
    exit 1
    ;;
esac
```

- [ ] **Step 1: Add the two new `pct exec` branches**

Insert these two `case` arms directly above the existing `*)` catch-all:

```sh
  "pct exec "[0-9]*" -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu")
    vmid="${cmd#pct exec }"
    vmid="${vmid% -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu}"
    case "$vmid" in
      ''|*[!0-9]*)
        echo "refused: invalid vmid" >&2
        exit 1
        ;;
    esac
    exec pct exec "$vmid" -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu
    ;;
  "pct exec "[0-9]*" -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'")
    vmid="${cmd#pct exec }"
    vmid="${vmid% -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'}"
    case "$vmid" in
      ''|*[!0-9]*)
        echo "refused: invalid vmid" >&2
        exit 1
        ;;
    esac
    exec pct exec "$vmid" -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'
    ;;
```

Both branches follow the exact pattern already used for `smartctl`'s `/dev/nvme` device path: the `case` pattern's `[0-9]*` glob only narrows which strings *reach* this branch (a coarse pre-filter, matching a plausible shape) — the REAL security boundary is the subsequent `case "$vmid" in ''|*[!0-9]*)` check, which runs unconditionally on the extracted substring before it is ever substituted into the `exec` line. `${cmd#prefix}`/`${vmid%suffix}` are pure POSIX string-stripping parameter expansions — they never execute anything, and if the prefix/suffix didn't actually match (impossible here since we're already inside the matching `case` arm) they'd simply no-op rather than corrupt anything.

- [ ] **Step 2: Update `deploy/SSH_SETUP.md`'s capability description**

Read the current file first. Find the capability-description line (updated by Plan 2 to list `lsblk`, `smartctl`, `df`, `lvs`, `pvs`) and extend it to also mention `pct exec` (process listing and OS-release probe, vmid-validated) — keep the existing "parameterless" vs "path-validated"/"vmid-validated" distinction Plan 2 established.

- [ ] **Step 3: Write the failing tests for `lxcClient.js`**

Read `src/utils/ssh/smartClient.js` and `smartClient.test.js` first to copy the `execCommand`/`FakeClient`/`FakeStream` pattern exactly (this is a NEW file with its own copy of `execCommand` — do not import it from `smartClient.js`, they are deliberately independent per the design spec).

```javascript
// src/utils/ssh/lxcClient.js — implementation, write AFTER the test below fails

import { readFileSync } from "node:fs";

import { Client } from "ssh2";

const VMID_PATTERN = /^\d+$/;
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

export async function getLxcProcesses(sshConfig, vmid) {
  if (!VMID_PATTERN.test(String(vmid))) {
    throw new Error(`Refusing to query unsafe vmid: ${vmid}`);
  }
  const { stdout, stderr, code } = await execCommand(
    sshConfig,
    `pct exec ${vmid} -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu`,
  );
  if (code !== 0) {
    throw new Error(`Command exited with code ${code}: ${stderr}`);
  }
  return stdout;
}

export async function getLxcOsProbe(sshConfig, vmid) {
  if (!VMID_PATTERN.test(String(vmid))) {
    throw new Error(`Refusing to query unsafe vmid: ${vmid}`);
  }
  const { stdout, stderr, code } = await execCommand(
    sshConfig,
    `pct exec ${vmid} -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'`,
  );
  if (code !== 0) {
    throw new Error(`Command exited with code ${code}: ${stderr}`);
  }
  return stdout;
}
```

```javascript
// src/utils/ssh/lxcClient.test.js
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "fake-private-key"),
}));

const PS_COMMAND_200 = "pct exec 200 -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu";
const OS_PROBE_COMMAND_200 =
  "pct exec 200 -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'";

let commandBehavior = "success"; // "success" | "nonzero"

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

class FakeClient extends EventEmitter {
  connect() {
    setImmediate(() => this.emit("ready"));
  }

  exec(command, callback) {
    const stream = new FakeStream();
    setImmediate(() => {
      callback(null, stream);

      if (command === PS_COMMAND_200) {
        if (commandBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("pct: container 200 not running\n"));
          stream.emit("close", 1);
        } else {
          stream.emit("data", Buffer.from("   3368  0.8 18.4 redis-server\n    174  0.0  1.3 dockerd\n"));
          stream.emit("close", 0);
        }
        return;
      }

      if (command === OS_PROBE_COMMAND_200) {
        stream.emit(
          "data",
          Buffer.from('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n---\nnone\n'),
        );
        stream.emit("close", 0);
        return;
      }

      stream.stderr.emit("data", Buffer.from(`unexpected command: ${command}\n`));
      stream.emit("close", 127);
    });
  }

  end() {}
}

vi.mock("ssh2", () => ({
  Client: FakeClient,
}));

const { getLxcProcesses, getLxcOsProbe } = await import("./lxcClient");

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "/config/ssh/id_smart" };

afterEach(() => {
  commandBehavior = "success";
});

describe("lxcClient", () => {
  it("fetches raw process listing output via the exact pct exec command", async () => {
    const result = await getLxcProcesses(sshConfig, 200);
    expect(result).toBe("   3368  0.8 18.4 redis-server\n    174  0.0  1.3 dockerd\n");
  });

  it("rejects getLxcProcesses when pct exec exits non-zero", async () => {
    commandBehavior = "nonzero";
    await expect(getLxcProcesses(sshConfig, 200)).rejects.toThrow(/exited with code 1/);
  });

  it("rejects getLxcProcesses for a non-numeric vmid without making any SSH connection", async () => {
    const connectSpy = vi.spyOn(FakeClient.prototype, "connect");
    await expect(getLxcProcesses(sshConfig, "200; rm -rf /")).rejects.toThrow(/unsafe vmid/);
    expect(connectSpy).not.toHaveBeenCalled();
    connectSpy.mockRestore();
  });

  it("fetches raw OS-release/update-probe output via the exact pct exec command", async () => {
    const result = await getLxcOsProbe(sshConfig, 200);
    expect(result).toBe('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n---\nnone\n');
  });

  it("rejects getLxcOsProbe for a non-numeric vmid without making any SSH connection", async () => {
    const connectSpy = vi.spyOn(FakeClient.prototype, "connect");
    await expect(getLxcOsProbe(sshConfig, "$(reboot)")).rejects.toThrow(/unsafe vmid/);
    expect(connectSpy).not.toHaveBeenCalled();
    connectSpy.mockRestore();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail, then implement, then verify they pass**

Run: `pnpm test src/utils/ssh/lxcClient.test.js` — expect FAIL (`Cannot find module './lxcClient'`), then create `src/utils/ssh/lxcClient.js` with the code shown above, then re-run — expect PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add deploy/proxmox-smart-helper.sh deploy/SSH_SETUP.md src/utils/ssh/lxcClient.js src/utils/ssh/lxcClient.test.js
git commit -m "feat: add pct exec support to the restricted SSH allowlist and a new lxcClient"
```

---

### Task 2: QEMU guest-agent exec client

**Files:**
- Create: `src/utils/proxmox/agentExec.js`
- Test: `src/utils/proxmox/agentExec.test.js`

**Interfaces:**
- Consumes: `httpProxy` (`utils/proxy/http`), `createLogger` (`utils/logger`) — same as Plan 3's route.
- Produces:
  - `export async function getQemuProcesses(pveConfig, node, vmid)` → resolves to raw stdout string.
  - `export async function getQemuOsProbe(pveConfig, node, vmid)` → resolves to raw stdout string.
  - Both send a **hardcoded** `command` array — never anything derived from a parameter beyond `node`/`vmid` selecting the target. Both poll `exec-status` with a bounded timeout (`AGENT_EXEC_TIMEOUT_MS`, mirroring `smartClient.js`'s `SSH_COMMAND_TIMEOUT_MS` pattern) rather than polling forever.
  - Both throw on a non-200 HTTP status from either the `exec` or `exec-status` call, and on exec timeout.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/utils/proxmox/agentExec.test.js
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { httpProxy } = vi.hoisted(() => ({ httpProxy: vi.fn() }));
vi.mock("utils/proxy/http", () => ({ httpProxy }));
vi.mock("utils/logger", () => ({ default: () => ({ error: vi.fn() }) }));

const { getQemuOsProbe, getQemuProcesses, AGENT_EXEC_TIMEOUT_MS } = await import("./agentExec");

const pveConfig = { url: "https://10.0.1.9:8006", token: "root@pam!ysb", secret: "s3cr3t" };

function jsonResponse(status, body) {
  return [status, "application/json", Buffer.from(JSON.stringify(body)), null];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agentExec", () => {
  it("launches the exact hardcoded ps command and polls exec-status until exited, returning stdout", async () => {
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/agent/exec") && !url.includes("exec-status")) {
        return jsonResponse(200, { data: { pid: 12345 } });
      }
      if (url.includes("exec-status")) {
        return jsonResponse(200, { data: { "out-data": "   3368  0.8 18.4 python3\n", exited: 1, exitcode: 0 } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getQemuProcesses(pveConfig, "proxmox", 100);

    expect(result).toBe("   3368  0.8 18.4 python3\n");
    // The command array must be exactly this fixed set — never derived from vmid/node beyond selecting the URL.
    const execCall = httpProxy.mock.calls.find(([url]) => url.includes("/agent/exec") && !url.includes("exec-status"));
    expect(execCall[1].body).toContain("ps");
    expect(execCall[1].body).toContain("--sort=-pcpu");
  });

  it("polls exec-status more than once when the command hasn't exited yet", async () => {
    let pollCount = 0;
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/agent/exec") && !url.includes("exec-status")) {
        return jsonResponse(200, { data: { pid: 999 } });
      }
      if (url.includes("exec-status")) {
        pollCount += 1;
        if (pollCount < 3) return jsonResponse(200, { data: { exited: 0 } });
        return jsonResponse(200, { data: { "out-data": "done\n", exited: 1, exitcode: 0 } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getQemuProcesses(pveConfig, "proxmox", 100);

    expect(result).toBe("done\n");
    expect(pollCount).toBe(3);
  });

  it("rejects when the command never exits within the timeout", async () => {
    vi.useFakeTimers();
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/agent/exec") && !url.includes("exec-status")) {
        return jsonResponse(200, { data: { pid: 1 } });
      }
      return jsonResponse(200, { data: { exited: 0 } });
    });

    const promise = getQemuProcesses(pveConfig, "proxmox", 100);
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(AGENT_EXEC_TIMEOUT_MS + 1000);
    await assertion;
  });

  it("rejects when the initial exec call fails", async () => {
    httpProxy.mockImplementation(async () => jsonResponse(500, { error: "boom" }));

    await expect(getQemuProcesses(pveConfig, "proxmox", 100)).rejects.toThrow(/exec/i);
  });

  it("fetches the OS probe via the exact hardcoded sh -c command", async () => {
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/agent/exec") && !url.includes("exec-status")) {
        return jsonResponse(200, { data: { pid: 42 } });
      }
      if (url.includes("exec-status")) {
        return jsonResponse(200, {
          data: { "out-data": 'PRETTY_NAME="Home Assistant OS 18.2"\n---\nnone\n', exited: 1, exitcode: 0 },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getQemuOsProbe(pveConfig, "proxmox", 100);

    expect(result).toBe('PRETTY_NAME="Home Assistant OS 18.2"\n---\nnone\n');
    const execCall = httpProxy.mock.calls.find(([url]) => url.includes("/agent/exec") && !url.includes("exec-status"));
    expect(execCall[1].body).toContain("os-release");
    expect(execCall[1].body).toContain("update-success-stamp");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/proxmox/agentExec.test.js` — expect FAIL, `Cannot find module './agentExec'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/utils/proxmox/agentExec.js
import createLogger from "utils/logger";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxAgentExec");

export const AGENT_EXEC_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 300;

// Both command arrays are fixed JS constants. Nothing derived from a
// request parameter is ever appended to either array — node/vmid only
// select which guest's agent receives one of these two exact operations.
// This is the QEMU-side equivalent of proxmox-smart-helper.sh's forced
// command pattern: the "server" enforcing the fixed shape is this file.
const PS_COMMAND = ["ps", "-eo", "pid=,pcpu=,pmem=,comm=", "--sort=-pcpu"];
const OS_PROBE_COMMAND = [
  "sh",
  "-c",
  "cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)",
];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pveAuthedGet(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "GET", headers });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

async function launchExec(pveConfig, node, vmid, command) {
  const url = `${pveConfig.url}/api2/json/nodes/${node}/qemu/${vmid}/agent/exec`;
  const headers = {
    Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body = command.map((part) => `command=${encodeURIComponent(part)}`).join("&");
  const [status, , data] = await httpProxy(url, { method: "POST", headers, body });
  if (status !== 200) {
    throw new Error(`Failed to launch guest-agent exec on qemu/${vmid}: status ${status}`);
  }
  const parsed = JSON.parse(Buffer.from(data).toString());
  return parsed.data.pid;
}

async function pollExecStatus(pveConfig, node, vmid, pid) {
  const deadline = Date.now() + AGENT_EXEC_TIMEOUT_MS;
  for (;;) {
    const status = await pveAuthedGet(pveConfig, `nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`);
    if (status.exited === 1) {
      return status["out-data"] ?? "";
    }
    if (Date.now() >= deadline) {
      throw new Error(`Guest-agent exec on qemu/${vmid} (pid ${pid}) timed out after ${AGENT_EXEC_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runAgentCommand(pveConfig, node, vmid, command) {
  const pid = await launchExec(pveConfig, node, vmid, command);
  return pollExecStatus(pveConfig, node, vmid, pid);
}

export async function getQemuProcesses(pveConfig, node, vmid) {
  try {
    return await runAgentCommand(pveConfig, node, vmid, PS_COMMAND);
  } catch (error) {
    logger.error("Guest-agent process listing failed for qemu/%s:", vmid, error);
    throw error;
  }
}

export async function getQemuOsProbe(pveConfig, node, vmid) {
  try {
    return await runAgentCommand(pveConfig, node, vmid, OS_PROBE_COMMAND);
  } catch (error) {
    logger.error("Guest-agent OS probe failed for qemu/%s:", vmid, error);
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/proxmox/agentExec.test.js` — expect PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/proxmox/agentExec.js src/utils/proxmox/agentExec.test.js
git commit -m "feat: add QEMU guest-agent exec client for process listing and OS probe"
```

---

### Task 3: Shared pure parsers

**Files:**
- Create: `src/utils/proxmox/processDetail.js`
- Test: `src/utils/proxmox/processDetail.test.js`

**Interfaces:**
- Consumes: nothing (pure, standalone — the raw stdout strings Task 1/2's clients produce).
- Produces:
  - `export function parseTopProcesses(stdout, limit = 5)` → `Array<{ pid: number, cpuPercent: number, memPercent: number, command: string }>`, already sorted CPU-descending by the upstream `ps --sort=-pcpu`, truncated to `limit`.
  - `export function parseOsProbe(stdout)` → `{ prettyName: string | null, lastUpdate: string | null }` — `lastUpdate` is an ISO 8601 date string derived from the Unix timestamp, or `null` for the literal `none` sentinel or a missing/unparseable timestamp.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/utils/proxmox/processDetail.test.js
import { describe, expect, it } from "vitest";

import { parseOsProbe, parseTopProcesses } from "./processDetail";

describe("parseTopProcesses", () => {
  it("parses real ps -eo pid=,pcpu=,pmem=,comm= output into structured entries", () => {
    const stdout =
      "   3368  0.8 18.4 python3\n" +
      "   5200  0.4  2.5 plugin_start_li\n" +
      "    395  0.3  0.1 bluetoothd\n" +
      "   5162  0.2  4.7 grafana\n" +
      "  71220  0.2  7.4 MainThread\n" +
      "    497  0.1  2.0 dockerd\n";

    const result = parseTopProcesses(stdout);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ pid: 3368, cpuPercent: 0.8, memPercent: 18.4, command: "python3" });
    expect(result[4]).toEqual({ pid: 71220, cpuPercent: 0.2, memPercent: 7.4, command: "MainThread" });
  });

  it("respects a custom limit", () => {
    const stdout = "1 0.5 0.1 a\n2 0.4 0.1 b\n3 0.3 0.1 c\n";
    expect(parseTopProcesses(stdout, 2)).toHaveLength(2);
  });

  it("returns an empty array for empty or whitespace-only output", () => {
    expect(parseTopProcesses("")).toEqual([]);
    expect(parseTopProcesses("   \n  \n")).toEqual([]);
  });

  it("skips a malformed line rather than throwing", () => {
    const stdout = "1 0.5 0.1 real-process\nnot-a-valid-line\n2 0.3 0.1 also-real\n";
    const result = parseTopProcesses(stdout);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.command)).toEqual(["real-process", "also-real"]);
  });
});

describe("parseOsProbe", () => {
  it("parses a real Debian os-release block with no update timestamp (none)", () => {
    const stdout =
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n' +
      "NAME=\"Debian GNU/Linux\"\n" +
      "VERSION_ID=\"12\"\n" +
      "---\n" +
      "none\n";

    const result = parseOsProbe(stdout);

    expect(result).toEqual({ prettyName: "Debian GNU/Linux 12 (bookworm)", lastUpdate: null });
  });

  it("parses a real Home Assistant OS os-release block with no update timestamp", () => {
    const stdout =
      'NAME="Home Assistant OS"\n' +
      'PRETTY_NAME="Home Assistant OS 18.2"\n' +
      "VERSION_ID=18.2\n" +
      "---\n" +
      "none\n";

    const result = parseOsProbe(stdout);

    expect(result).toEqual({ prettyName: "Home Assistant OS 18.2", lastUpdate: null });
  });

  it("parses a real Unix timestamp into an ISO date string", () => {
    const stdout = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\n---\n1734000000\n';

    const result = parseOsProbe(stdout);

    expect(result.prettyName).toBe("Ubuntu 24.04.1 LTS");
    expect(result.lastUpdate).toBe(new Date(1734000000 * 1000).toISOString());
  });

  it("returns null prettyName when PRETTY_NAME is absent", () => {
    const stdout = "NAME=Alpine\n---\nnone\n";
    expect(parseOsProbe(stdout).prettyName).toBeNull();
  });

  it("returns null lastUpdate for an unparseable timestamp line", () => {
    const stdout = "PRETTY_NAME=X\n---\nnot-a-number\n";
    expect(parseOsProbe(stdout).lastUpdate).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/proxmox/processDetail.test.js` — expect FAIL, `Cannot find module './processDetail'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/utils/proxmox/processDetail.js

export function parseTopProcesses(stdout, limit = 5) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)$/);
      if (!match) return null;
      const [, pid, cpu, mem, command] = match;
      return { pid: Number(pid), cpuPercent: Number(cpu), memPercent: Number(mem), command };
    })
    .filter((entry) => entry !== null)
    .slice(0, limit);
}

export function parseOsProbe(stdout) {
  const [osReleaseBlock, timestampBlock] = stdout.split("---\n");

  const prettyNameMatch = (osReleaseBlock ?? "").match(/^PRETTY_NAME="?([^"\n]+)"?$/m);
  const prettyName = prettyNameMatch ? prettyNameMatch[1] : null;

  const timestampLine = (timestampBlock ?? "").trim();
  let lastUpdate = null;
  if (timestampLine && timestampLine !== "none" && /^\d+$/.test(timestampLine)) {
    lastUpdate = new Date(Number(timestampLine) * 1000).toISOString();
  }

  return { prettyName, lastUpdate };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/proxmox/processDetail.test.js` — expect PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/proxmox/processDetail.js src/utils/proxmox/processDetail.test.js
git commit -m "feat: add pure parsers for process listing and OS-release probe output"
```

---

### Task 4: On-demand `/api/proxmox/vm-detail` route

**Files:**
- Create: `src/pages/api/proxmox/vm-detail/index.js`
- Test: `src/__tests__/pages/api/proxmox/vm-detail/index.test.js`

**Interfaces:**
- Consumes: `getPveConfig`/`getSmartConfig` (`utils/config/proxmox`); `getLxcProcesses`/`getLxcOsProbe` (Task 1); `getQemuProcesses`/`getQemuOsProbe` (Task 2); `parseTopProcesses`/`parseOsProbe` (Task 3).
- Produces: `GET /api/proxmox/vm-detail?type=<qemu|lxc>&node=<node>&vmid=<vmid>` → 200 with:
  ```js
  { processes: Array<{pid, cpuPercent, memPercent, command}>, osReleaseName: string | null, lastUpdate: string | null }
  ```
  Both the process listing and the OS probe are fetched independently and degrade independently to `[]`/`null` on failure — one failing must never fail the whole response, matching every prior route in this project. 400 for invalid/missing `type`/`node`/`vmid`. 500 only if BOTH the SSH config (for `lxc`) or the Proxmox config (for `qemu`) is missing outright — a config that's present but whose live query fails degrades to empty/null, not 500.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/__tests__/pages/api/proxmox/vm-detail/index.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, getPveConfig, getLxcProcesses, getLxcOsProbe, getQemuProcesses, getQemuOsProbe, logger } =
  vi.hoisted(() => ({
    getSmartConfig: vi.fn(),
    getPveConfig: vi.fn(),
    getLxcProcesses: vi.fn(),
    getLxcOsProbe: vi.fn(),
    getQemuProcesses: vi.fn(),
    getQemuOsProbe: vi.fn(),
    logger: { error: vi.fn() },
  }));

vi.mock("utils/config/proxmox", () => ({ getSmartConfig, getPveConfig }));
vi.mock("utils/ssh/lxcClient", () => ({ getLxcProcesses, getLxcOsProbe }));
vi.mock("utils/proxmox/agentExec", () => ({ getQemuProcesses, getQemuOsProbe }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/proxmox/vm-detail/index";

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "./config/ssh/id_smart" };
const pveConfig = { url: "https://10.0.1.9:8006", token: "root@pam!ysb", secret: "s3cr3t" };

const REAL_PS_OUTPUT = "   3368  0.8 18.4 redis-server\n    174  0.0  1.3 dockerd\n";
const REAL_OS_PROBE_OUTPUT = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n---\nnone\n';

describe("pages/api/proxmox/vm-detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [{ type: "qemu", node: "proxmox" }, "vmid"],
    [{ type: "qemu", vmid: "100" }, "node"],
    [{ node: "proxmox", vmid: "100" }, "type"],
    [{ type: "container", node: "proxmox", vmid: "100" }, "type"],
    [{ type: "qemu", node: "../etc", vmid: "100" }, "node"],
    [{ type: "qemu", node: "proxmox", vmid: "100; rm -rf /" }, "vmid"],
  ])("returns 400 for invalid query %o (bad %s)", async (query) => {
    const req = { query };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(getLxcProcesses).not.toHaveBeenCalled();
    expect(getQemuProcesses).not.toHaveBeenCalled();
  });

  it("returns 500 when the LXC SSH config is missing for a type=lxc request", async () => {
    getSmartConfig.mockReturnValue(null);

    const req = { query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
  });

  it("returns 500 when the Proxmox API config is missing for a type=qemu request", async () => {
    getPveConfig.mockReturnValue(null);

    const req = { query: { type: "qemu", node: "proxmox", vmid: "100" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
  });

  it("returns parsed process list and OS info for a successful lxc request", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    getLxcProcesses.mockResolvedValue(REAL_PS_OUTPUT);
    getLxcOsProbe.mockResolvedValue(REAL_OS_PROBE_OUTPUT);

    const req = { query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(getLxcProcesses).toHaveBeenCalledWith(sshConfig, "200");
    expect(res.statusCode).toBe(200);
    expect(res.body.processes[0]).toEqual({ pid: 3368, cpuPercent: 0.8, memPercent: 18.4, command: "redis-server" });
    expect(res.body.osReleaseName).toBe("Debian GNU/Linux 12 (bookworm)");
    expect(res.body.lastUpdate).toBeNull();
  });

  it("returns parsed process list and OS info for a successful qemu request", async () => {
    getPveConfig.mockReturnValue(pveConfig);
    getQemuProcesses.mockResolvedValue(REAL_PS_OUTPUT);
    getQemuOsProbe.mockResolvedValue(REAL_OS_PROBE_OUTPUT);

    const req = { query: { type: "qemu", node: "proxmox", vmid: "100" } };
    const res = createMockRes();

    await handler(req, res);

    expect(getQemuProcesses).toHaveBeenCalledWith(pveConfig, "proxmox", "100");
    expect(res.statusCode).toBe(200);
    expect(res.body.processes).toHaveLength(2);
  });

  it("degrades to empty processes and null OS info, without failing the request, when both live calls fail", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    getLxcProcesses.mockRejectedValue(new Error("SSH command timed out after 15000ms"));
    getLxcOsProbe.mockRejectedValue(new Error("SSH command timed out after 15000ms"));

    const req = { query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ processes: [], osReleaseName: null, lastUpdate: null });
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("timed out");
  });

  it("degrades only the failing half when process listing succeeds but the OS probe fails", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    getLxcProcesses.mockResolvedValue(REAL_PS_OUTPUT);
    getLxcOsProbe.mockRejectedValue(new Error("boom"));

    const req = { query: { type: "lxc", node: "proxmox", vmid: "200" } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.processes).toHaveLength(2);
    expect(res.body.osReleaseName).toBeNull();
    expect(res.body.lastUpdate).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/__tests__/pages/api/proxmox/vm-detail/index.test.js` — expect FAIL, `Cannot find module 'pages/api/proxmox/vm-detail/index'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/pages/api/proxmox/vm-detail/index.js
import { getPveConfig, getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { getQemuOsProbe, getQemuProcesses } from "utils/proxmox/agentExec";
import { parseOsProbe, parseTopProcesses } from "utils/proxmox/processDetail";
import { getLxcOsProbe, getLxcProcesses } from "utils/ssh/lxcClient";

const logger = createLogger("proxmoxVmDetailService");

const VALID_TYPE = new Set(["qemu", "lxc"]);
const VALID_NODE = /^[A-Za-z0-9._-]+$/;
const VALID_VMID = /^\d+$/;

async function fetchLxcDetail(sshConfig, vmid) {
  const [processesResult, osProbeResult] = await Promise.allSettled([
    getLxcProcesses(sshConfig, vmid),
    getLxcOsProbe(sshConfig, vmid),
  ]);
  return { processesResult, osProbeResult };
}

async function fetchQemuDetail(pveConfig, node, vmid) {
  const [processesResult, osProbeResult] = await Promise.allSettled([
    getQemuProcesses(pveConfig, node, vmid),
    getQemuOsProbe(pveConfig, node, vmid),
  ]);
  return { processesResult, osProbeResult };
}

export default async function handler(req, res) {
  const { type, node, vmid } = req.query;

  if (typeof type !== "string" || !VALID_TYPE.has(type)) {
    return res.status(400).json({ error: "Invalid or missing type parameter" });
  }
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof vmid !== "string" || !VALID_VMID.test(vmid)) {
    return res.status(400).json({ error: "Invalid or missing vmid parameter" });
  }

  let processesResult;
  let osProbeResult;

  if (type === "lxc") {
    const sshConfig = getSmartConfig();
    if (!sshConfig) {
      return res.status(500).json({ error: "SMART SSH configuration not found" });
    }
    ({ processesResult, osProbeResult } = await fetchLxcDetail(sshConfig, vmid));
  } else {
    const pveConfig = getPveConfig();
    if (!pveConfig) {
      return res.status(500).json({ error: "Proxmox server configuration not found" });
    }
    ({ processesResult, osProbeResult } = await fetchQemuDetail(pveConfig, node, vmid));
  }

  let processes = [];
  if (processesResult.status === "fulfilled") {
    processes = parseTopProcesses(processesResult.value);
  } else {
    logger.error("Process listing failed for %s/%s:", type, vmid, processesResult.reason);
  }

  let osReleaseName = null;
  let lastUpdate = null;
  if (osProbeResult.status === "fulfilled") {
    ({ prettyName: osReleaseName, lastUpdate } = parseOsProbe(osProbeResult.value));
  } else {
    logger.error("OS probe failed for %s/%s:", type, vmid, osProbeResult.reason);
  }

  return res.status(200).json({ processes, osReleaseName, lastUpdate });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/__tests__/pages/api/proxmox/vm-detail/index.test.js` — expect PASS (10 tests).

- [ ] **Step 5: Run the full suite, lint, and prettier**

Run: `pnpm test` — expect PASS, no regressions.
Run: `pnpm lint` — expect clean.
Run: `npx prettier --check src/pages/api/proxmox/vm-detail/index.js src/__tests__/pages/api/proxmox/vm-detail/index.test.js` — expect clean.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/proxmox/vm-detail/index.js src/__tests__/pages/api/proxmox/vm-detail/index.test.js
git commit -m "feat: add on-demand /api/proxmox/vm-detail route"
```

---

### Task 5: `VmCard` Details toggle

**Files:**
- Modify: `src/components/proxmox-vms/group.jsx`
- Modify: `src/components/proxmox-vms/group.test.jsx`

**Interfaces:**
- Consumes: `GET /api/proxmox/vm-detail` (Task 4).
- Produces: each `VmCard` gains a "Details" toggle button. Expanding it lazily fetches `/api/proxmox/vm-detail?type=${vm.type}&node=${vm.node}&vmid=${vm.vmid}` (only on first expand, not on every render) and shows the top-5-process list plus "Last update: <date>" or "Last update: N/A".

Read the current `src/components/proxmox-vms/group.jsx` first (it may have shifted since this plan was written).

- [ ] **Step 1: Write the failing test**

Add to `src/components/proxmox-vms/group.test.jsx` (read the current file first to match its exact fetch-mocking convention):

```javascript
  it("lazily fetches and shows process/update detail only after the Details toggle is clicked", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200, node: "proxmox", type: "lxc", name: "lxc-homelab", status: "running",
            cpuUsedCores: 1, cpuTotalCores: 4, memUsedBytes: 1, memTotalBytes: 2,
            diskUsedBytes: 1, diskTotalBytes: 2, uptimeSeconds: 100,
            macAddress: "BC:24:11:AE:7C:89", ipAddress: "10.0.1.104", osName: "debian",
          },
        ]),
    };
    const detailResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          processes: [{ pid: 3368, cpuPercent: 0.8, memPercent: 18.4, command: "redis-server" }],
          osReleaseName: "Debian GNU/Linux 12 (bookworm)",
          lastUpdate: null,
        }),
    };
    global.fetch = vi.fn((url) => (url.includes("vm-detail") ? Promise.resolve(detailResponse) : Promise.resolve(listResponse)));

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("lxc-homelab")).toBeInTheDocument());

    // Before expanding: no detail fetch, no process data visible.
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("vm-detail"));
    expect(screen.queryByText("redis-server")).not.toBeInTheDocument();

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("redis-server")).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/proxmox/vm-detail?type=lxc&node=proxmox&vmid=200"));
    expect(screen.getByText(/Last update: N\/A/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/components/proxmox-vms/group.test.jsx` — expect FAIL, "Details" not found / no toggle exists yet.

- [ ] **Step 3: Implement the Details toggle in `VmCard`**

Add a lazy-fetch-on-expand `useState`/`useEffect` (or a manual fetch-on-click, simpler — no `useEffect` needed if the fetch is triggered directly in the click handler) to `VmCard`. Read the current file's exact structure before editing; the shape to add:

```jsx
function VmCard({ vm, cardClassName }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const toggleDetail = async () => {
    if (detailOpen) {
      setDetailOpen(false);
      return;
    }
    setDetailOpen(true);
    if (detail || detailLoading) return; // already fetched or in flight — don't refetch on every toggle
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/proxmox/vm-detail?type=${vm.type}&node=${vm.node}&vmid=${vm.vmid}`);
      if (res.ok) {
        setDetail(await res.json());
      }
    } finally {
      setDetailLoading(false);
    }
  };

  // ... existing cpuValue/memValue/diskValue unchanged ...

  return (
    <div className={cardClassName} data-testid="vm-card" data-status={vm.status}>
      {/* ...existing header/stat-row/identity-row unchanged... */}
      <button type="button" onClick={toggleDetail} className="text-xs text-theme-500 dark:text-theme-300 mt-2">
        Details
      </button>
      {detailOpen && (
        <div className="mt-2 text-xs">
          {detailLoading && <p className="text-theme-500 dark:text-theme-300">Loading...</p>}
          {detail && (
            <>
              <ul>
                {detail.processes.map((p) => (
                  <li key={p.pid}>
                    {p.command} — {p.cpuPercent}% CPU
                  </li>
                ))}
              </ul>
              <p className="text-theme-500 dark:text-theme-300 mt-1">
                Last update: {detail.lastUpdate ? new Date(detail.lastUpdate).toLocaleDateString() : "N/A"}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

Add `import { useState } from "react";` (or extend the existing React import if `useContext` is already imported from `"react"`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/components/proxmox-vms/group.test.jsx` — expect PASS.

- [ ] **Step 5: Run the full suite, lint, and prettier**

Run: `pnpm test` — expect PASS, no regressions.
Run: `pnpm lint` — expect clean.
Run: `npx prettier --check src/components/proxmox-vms/group.jsx src/components/proxmox-vms/group.test.jsx` — expect clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/proxmox-vms/group.jsx src/components/proxmox-vms/group.test.jsx
git commit -m "feat: add lazy-loaded Details toggle (processes + last update) to VmCard"
```

---

### Task 6: Dedicated adversarial security review (MANDATORY, do not skip)

**Files:** none (review only)

This is separate from, and in addition to, the normal per-task reviews and the final whole-branch review. Dispatch it on the most capable available model, after Tasks 1-5 are complete and individually reviewed clean, but BEFORE the final whole-branch review — its findings should be fixed and re-verified before the final review even starts, since the final review is a broad pass and this one needs to be narrow and hostile.

- [ ] **Step 1: Generate a review package covering only the exec-surface files**

Not the whole branch diff — specifically `deploy/proxmox-smart-helper.sh` (full file, not just the diff, since an adversarial reviewer needs the complete case-statement to check for shadowing/ordering issues), `src/utils/ssh/lxcClient.js`, `src/utils/proxmox/agentExec.js`, and `src/pages/api/proxmox/vm-detail/index.js`.

- [ ] **Step 2: Dispatch with this exact adversarial framing**

The reviewer's brief must instruct it to actively try to find a way to:
1. Get the `pct exec` forced-command branches in `proxmox-smart-helper.sh` to run something other than the exact two commands they're supposed to — try constructing `$SSH_ORIGINAL_COMMAND` values that might slip past the `case` pattern match, confuse the `${cmd#...}`/`${vmid%...}` stripping, or exploit shell word-splitting/globbing in the vmid validation. Specifically: does the vmid validation correctly reject a vmid containing shell metacharacters, a vmid that's a valid-looking number followed by injected content the suffix-stripping might not fully remove, an empty vmid, a vmid with leading zeros or extreme length, or unicode digit look-alikes?
2. Get `src/utils/proxmox/agentExec.js`'s `command` array to include anything not in the two hardcoded constants — trace every code path from the Next.js route (`vm-detail/index.js`) down to `launchExec`'s `command` parameter and confirm no request data (query params, headers, body) reaches it.
3. Find any way `type`/`node`/`vmid` validation in `vm-detail/index.js` could be bypassed to reach either exec path with attacker-controlled data beyond the validated node name and numeric vmid.
4. Confirm the vmid client-side validation in `lxcClient.js` (`VMID_PATTERN.test`) and the server-side shell-script validation are not the ONLY layer relied upon anywhere — i.e., confirm defense-in-depth actually exists (both layers independently reject bad input) rather than one layer silently trusting the other.
5. Check whether the new SSH forced-command branches could be reordered, shadowed, or bypassed by an earlier `case` arm — e.g. does `"pct exec "[0-9]*" -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu")` risk accidentally matching (or being matched by) any EXISTING branch's pattern in a way that changes behavior?

Findings from this review use the same Critical/Important/Minor severity calibration as every other review in this plan sequence — but for this specific review, any finding that demonstrates even a THEORETICAL path to running an unintended command, regardless of how implausible the trigger seems, must be treated as Critical and fixed before proceeding, not deferred as a Minor "edge case."

- [ ] **Step 3: Fix any findings, re-verify with a scoped re-review, and confirm live** (once findings are fixed) by re-running the exact adversarial test strings the reviewer proposed against the real forced-command script — via `ssh -i config/ssh/id_smart` in Task 7's live verification, not just unit tests, since the real enforcement boundary is the actual shell script running on the actual host.

- [ ] **Step 4: Record in the ledger**

Whatever this review finds and how it was resolved must be recorded in the SDD ledger with full detail (not summarized away) — this is the one review in this plan sequence whose findings should be over-documented, not under-documented, given what's at stake if something is missed.

---

### Task 7: Live verification

**Files:** none (verification only)

- [ ] **Step 1: Re-copy the updated forced-command script to the Proxmox host**

```bash
scp deploy/proxmox-smart-helper.sh proxmox:/usr/local/bin/your-server-board-smart-helper.sh
ssh proxmox 'chmod 755 /usr/local/bin/your-server-board-smart-helper.sh'
```

- [ ] **Step 2: Verify the new commands directly over the restricted key, from lxc200 (per this project's established live-verification requirement — the real key only exists there, not on the local dev machine)**

```bash
ssh lxc200 '
KEY=/opt/stacks/your-server-board/config/ssh/id_smart
ssh -i "$KEY" -o BatchMode=yes root@10.0.1.9 "pct exec 200 -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu"
ssh -i "$KEY" -o BatchMode=yes root@10.0.1.9 "pct exec 200 -- sh -c '"'"'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'"'"'"
# Confirm the catch-all and every adversarial input Task 6 identified still get refused:
ssh -i "$KEY" -o BatchMode=yes root@10.0.1.9 "pct exec 200 -- rm -rf /"
ssh -i "$KEY" -o BatchMode=yes root@10.0.1.9 "pct exec 200; rm -rf /"
ssh -i "$KEY" -o BatchMode=yes root@10.0.1.9 "rm -rf /"
'
```

Expected: the first two return real data. The rest return `refused: ...` on stderr with a non-zero exit — if ANY of them succeeds or produces unexpected output, STOP, do not proceed to Step 3, and treat it as a Critical finding requiring an immediate fix and re-verification.

- [ ] **Step 3: Deploy the app**

```bash
git push origin dev
ssh lxc200 'cd /opt/stacks/your-server-board && git pull origin dev && docker compose up -d --build'
```

- [ ] **Step 4: Verify the API and UI**

```bash
curl -s "http://10.0.1.104:3050/api/proxmox/vm-detail?type=lxc&node=proxmox&vmid=200" | python3 -m json.tool
curl -s "http://10.0.1.104:3050/api/proxmox/vm-detail?type=qemu&node=proxmox&vmid=100" | python3 -m json.tool
```

Expected: both return real process lists and OS info (or `null`/N/A for the update timestamp, matching this plan's live-verified "none" case for both real guests). Open `http://10.0.1.104:3050/` in a browser if available, click "Details" on a card, confirm the process list and "Last update" line render.

- [ ] **Step 5: Confirm nothing else broke**

Confirm the existing Virtual Machines basic stats (from Plan 3), Disks section, and the rest of the dashboard render normally — this plan only adds an on-demand detail path.
