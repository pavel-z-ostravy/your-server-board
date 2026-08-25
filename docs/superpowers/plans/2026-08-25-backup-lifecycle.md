# Backup Lifecycle Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator list, run, download, and delete Proxmox VM/CT backups from a new `/backups` page, with retention shown read-only per storage.

**Architecture:** A new pure PVE-API client (`src/utils/proxmox/backups.js`, GET/POST/DELETE against `nodes/{node}/storage`, `nodes/{node}/vzdump`, `nodes/{node}/tasks/{upid}/status`, `nodes/{node}/storage/{storage}/content/{volid}`) handles list/run/poll/delete. A new SSH streaming client (`src/utils/ssh/backupClient.js`) handles download by extending the existing restricted forced-command key with one new whitelisted subcommand, since Proxmox's REST API has no raw-file-download endpoint. Five new thin API routes wrap these for the frontend; a new `/backups` page (mirroring `/widgets`, not a dashboard section) lists every VM/CT with an expandable backup table per guest.

**Tech Stack:** Next.js 16 (Pages Router), React 19, Vitest, SWR, `ssh2` (existing dependency), `@headlessui/react` (existing dependency), `httpProxy` (existing PVE API transport).

**Spec:** `docs/superpowers/specs/2026-08-25-backup-lifecycle-design.md`

## Global Constraints

- Node 22, pnpm only — never npm/yarn.
- Test via `pnpm test` (Vitest, `vitest run`).
- No changes to `smartClient.js`'s existing exported functions or behavior — only a new, separate SSH client file is added.
- "Run" always means an immediate ad-hoc backup of one guest (`POST .../vzdump`), never creating/editing/triggering an existing scheduled `cluster/backup` job.
- Retention (`prune-backups`) is read-only display only — no editing UI, no write path for it.
- No restore feature, no cross-storage/cross-node backup copying.
- No extra "install-style" disclaimer/checkbox layer on Run/Delete — protected by the dashboard's existing auth only, plus the delete dialog's type-to-confirm gate.
- Delete requires the operator to retype the VM/CT's exact name before the Delete button unlocks (stricter than the widget-uninstall feature's lightweight inline confirm).
- Download must stream — never buffer a whole backup file in server memory.

---

### Task 1: PVE backup API client

**Files:**
- Create: `src/utils/proxmox/backups.js`
- Test: `src/utils/proxmox/backups.test.js`

**Interfaces:**
- Consumes: `httpProxy(url, { method, headers, body })` from `utils/proxy/http` — resolves `[status, headers, data]`, `data` a `Buffer` on success (matches `src/pages/api/proxmox/vms/index.js`'s existing usage). `createLogger` from `utils/logger`.
- Produces (consumed by Tasks 4–6):
  - `listBackupStorages(pveConfig, node)` → `Promise<Array<{ storage: string, prunePolicy: string|null }>>`
  - `listBackupsForVm(pveConfig, node, vmid)` → `Promise<Array<{ volid: string, size: number|null, ctime: number|null, notes: string|null, storage: string, prunePolicy: string|null }>>`
  - `startBackup(pveConfig, node, vmid, storage)` → `Promise<{ upid: string }>`
  - `pollBackupTask(pveConfig, node, upid)` → `Promise<{ status: string, exitstatus: string|null }>`
  - `deleteBackup(pveConfig, node, volid)` → `Promise<void>`
  - `pveConfig` shape: `{ url, token, secret }` (from `getPveConfig()`, existing).

- [ ] **Step 1: Write the failing tests**

```js
// src/utils/proxmox/backups.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

const { httpProxy, logger } = vi.hoisted(() => ({
  httpProxy: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/proxy/http", () => ({ httpProxy }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import { deleteBackup, listBackupsForVm, listBackupStorages, pollBackupTask, startBackup } from "./backups";

const pveConfig = { url: "https://10.0.0.9:8006", token: "root@pam!ysb", secret: "s3cr3t" };

function jsonResponse(status, body) {
  return [status, {}, Buffer.from(JSON.stringify(body))];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listBackupStorages", () => {
  it("returns only storages with backup content, tagged with their prune policy", async () => {
    httpProxy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { storage: "local", content: "iso,vztmpl,backup", "prune-backups": "keep-last=3" },
          { storage: "images-only", content: "images" },
          { storage: "nas-backup", content: "backup" },
        ],
      }),
    );

    const result = await listBackupStorages(pveConfig, "proxmox");

    expect(result).toEqual([
      { storage: "local", prunePolicy: "keep-last=3" },
      { storage: "nas-backup", prunePolicy: null },
    ]);
    expect(httpProxy).toHaveBeenCalledWith(
      "https://10.0.0.9:8006/api2/json/nodes/proxmox/storage",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws when the Proxmox API returns a non-200 status", async () => {
    httpProxy.mockResolvedValueOnce([500, {}, Buffer.from("")]);

    await expect(listBackupStorages(pveConfig, "proxmox")).rejects.toThrow("Proxmox API returned 500");
  });
});

describe("listBackupsForVm", () => {
  it("filters backups to the given vmid across every backup-enabled storage", async () => {
    httpProxy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            { storage: "local", content: "backup", "prune-backups": "keep-last=3" },
            { storage: "nas", content: "backup" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
              size: 123,
              ctime: 1,
              notes: null,
              vmid: 100,
            },
            {
              volid: "local:backup/vzdump-qemu-200-2026_08_24-10_00_00.vma.zst",
              size: 456,
              ctime: 2,
              notes: null,
              vmid: 200,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              volid: "nas:backup/vzdump-qemu-100-2026_08_23-10_00_00.vma.zst",
              size: 789,
              ctime: 3,
              notes: "manual",
              vmid: 100,
            },
          ],
        }),
      );

    const result = await listBackupsForVm(pveConfig, "proxmox", "100");

    expect(result).toEqual([
      {
        volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
        size: 123,
        ctime: 1,
        notes: null,
        storage: "local",
        prunePolicy: "keep-last=3",
      },
      {
        volid: "nas:backup/vzdump-qemu-100-2026_08_23-10_00_00.vma.zst",
        size: 789,
        ctime: 3,
        notes: "manual",
        storage: "nas",
        prunePolicy: null,
      },
    ]);
  });

  it("skips a storage whose content listing fails without failing the whole call", async () => {
    httpProxy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            { storage: "local", content: "backup" },
            { storage: "broken", content: "backup" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
              size: 1,
              ctime: 1,
              notes: null,
              vmid: 100,
            },
          ],
        }),
      )
      .mockResolvedValueOnce([500, {}, Buffer.from("")]);

    const result = await listBackupsForVm(pveConfig, "proxmox", "100");

    expect(result).toEqual([
      {
        volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
        size: 1,
        ctime: 1,
        notes: null,
        storage: "local",
        prunePolicy: null,
      },
    ]);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("startBackup", () => {
  it("POSTs vzdump params and returns the UPID", async () => {
    httpProxy.mockResolvedValueOnce(
      jsonResponse(200, { data: "UPID:proxmox:00001234:00005678:6501234A:vzdump:100:root@pam!ysb:" }),
    );

    const result = await startBackup(pveConfig, "proxmox", "100", "local");

    expect(result).toEqual({ upid: "UPID:proxmox:00001234:00005678:6501234A:vzdump:100:root@pam!ysb:" });
    expect(httpProxy).toHaveBeenCalledWith(
      "https://10.0.0.9:8006/api2/json/nodes/proxmox/vzdump",
      expect.objectContaining({
        method: "POST",
        body: "vmid=100&storage=local&mode=snapshot&compress=zstd",
      }),
    );
  });

  it("throws when the Proxmox API returns a non-200 status", async () => {
    httpProxy.mockResolvedValueOnce([500, {}, Buffer.from("")]);

    await expect(startBackup(pveConfig, "proxmox", "100", "local")).rejects.toThrow("Proxmox API returned 500");
  });
});

describe("pollBackupTask", () => {
  it("returns status and exitstatus", async () => {
    httpProxy.mockResolvedValueOnce(jsonResponse(200, { data: { status: "stopped", exitstatus: "OK" } }));

    const result = await pollBackupTask(pveConfig, "proxmox", "UPID:proxmox:00001234:00005678:6501234A:vzdump:100::");

    expect(result).toEqual({ status: "stopped", exitstatus: "OK" });
  });

  it("defaults exitstatus to null while a task is still running", async () => {
    httpProxy.mockResolvedValueOnce(jsonResponse(200, { data: { status: "running" } }));

    const result = await pollBackupTask(pveConfig, "proxmox", "UPID:proxmox:00001234:00005678:6501234A:vzdump:100::");

    expect(result).toEqual({ status: "running", exitstatus: null });
  });
});

describe("deleteBackup", () => {
  it("DELETEs the content path, deriving storage from the volid's prefix", async () => {
    httpProxy.mockResolvedValueOnce(jsonResponse(200, { data: null }));

    await deleteBackup(pveConfig, "proxmox", "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst");

    expect(httpProxy).toHaveBeenCalledWith(
      "https://10.0.0.9:8006/api2/json/nodes/proxmox/storage/local/content/local%3Abackup%2Fvzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("throws when the Proxmox API returns a non-200 status", async () => {
    httpProxy.mockResolvedValueOnce([500, {}, Buffer.from("")]);

    await expect(
      deleteBackup(pveConfig, "proxmox", "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst"),
    ).rejects.toThrow("Proxmox API returned 500");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/proxmox/backups.test.js`
Expected: FAIL — `Cannot find module './backups'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```js
// src/utils/proxmox/backups.js
import createLogger from "utils/logger";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxBackups");

function parseVolidStorage(volid) {
  const separatorIndex = volid.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed volid: ${volid}`);
  }
  return volid.slice(0, separatorIndex);
}

async function pveGet(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "GET", headers });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

async function pvePost(pveConfig, path, formFields) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = {
    Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body = new URLSearchParams(formFields).toString();
  const [status, , data] = await httpProxy(url, { method: "POST", headers, body });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

async function pveDelete(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "DELETE", headers });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

export async function listBackupStorages(pveConfig, node) {
  const storages = await pveGet(pveConfig, `nodes/${encodeURIComponent(node)}/storage`);
  return (storages ?? [])
    .filter((s) => typeof s.content === "string" && s.content.split(",").includes("backup"))
    .map((s) => ({ storage: s.storage, prunePolicy: s["prune-backups"] ?? null }));
}

export async function listBackupsForVm(pveConfig, node, vmid) {
  const storages = await listBackupStorages(pveConfig, node);
  const results = await Promise.allSettled(
    storages.map(async ({ storage, prunePolicy }) => {
      const content = await pveGet(
        pveConfig,
        `nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=backup`,
      );
      return (content ?? [])
        .filter((entry) => String(entry.vmid) === String(vmid))
        .map((entry) => ({
          volid: entry.volid,
          size: entry.size ?? null,
          ctime: entry.ctime ?? null,
          notes: entry.notes ?? null,
          storage,
          prunePolicy,
        }));
    }),
  );

  const backups = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      backups.push(...result.value);
    } else {
      logger.error(
        "Failed to list backup content on storage %s for node %s:",
        storages[index].storage,
        node,
        result.reason,
      );
    }
  });
  return backups;
}

export async function startBackup(pveConfig, node, vmid, storage) {
  const upid = await pvePost(pveConfig, `nodes/${encodeURIComponent(node)}/vzdump`, {
    vmid: String(vmid),
    storage,
    mode: "snapshot",
    compress: "zstd",
  });
  return { upid };
}

export async function pollBackupTask(pveConfig, node, upid) {
  const status = await pveGet(
    pveConfig,
    `nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
  );
  return { status: status.status, exitstatus: status.exitstatus ?? null };
}

export async function deleteBackup(pveConfig, node, volid) {
  const storage = parseVolidStorage(volid);
  await pveDelete(
    pveConfig,
    `nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/proxmox/backups.test.js`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/utils/proxmox/backups.js src/utils/proxmox/backups.test.js --no-warn-ignored
npx prettier --check src/utils/proxmox/backups.js src/utils/proxmox/backups.test.js
git add src/utils/proxmox/backups.js src/utils/proxmox/backups.test.js
git commit -m "feat(backups): add Proxmox backup list/run/poll/delete API client"
```

---

### Task 2: SSH backup streaming client

**Files:**
- Create: `src/utils/ssh/backupClient.js`
- Test: `src/utils/ssh/backupClient.test.js`

**Interfaces:**
- Consumes: `Client` from `ssh2` (same as `smartClient.js`), `readFileSync` from `node:fs`.
- Produces (consumed by Task 6): `streamBackupFile(sshConfig, volid)` → `Promise<{ stream: Readable, conn: Client }>` — `stream` is the live, unbuffered ssh2 exec stream (already flowing stdout); `conn` is the SSH connection, which the caller must `.end()` once done consuming/erroring. Rejects if `volid` doesn't match the expected vzdump filename shape, if the SSH connection errors, or if `exec` itself fails. `sshConfig` shape: `{ host, username, privateKeyPath, port? }` (from `getSmartConfig()`, existing).

- [ ] **Step 1: Write the failing tests**

```js
// src/utils/ssh/backupClient.test.js
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "fake-private-key"),
}));

const VALID_VOLID = "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst";

let connectBehavior = "ready"; // "ready" | "hang" | "error"
let execBehavior = "success"; // "success" | "exec-error"

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

class FakeClient extends EventEmitter {
  connect() {
    if (connectBehavior === "hang") return;
    if (connectBehavior === "error") {
      setImmediate(() => this.emit("error", new Error("connection refused")));
      return;
    }
    setImmediate(() => this.emit("ready"));
  }

  exec(command, callback) {
    this.lastCommand = command;
    if (execBehavior === "exec-error") {
      setImmediate(() => callback(new Error("exec failed")));
      return;
    }
    setImmediate(() => callback(null, new FakeStream()));
  }

  end() {}
}

vi.mock("ssh2", () => ({ Client: FakeClient }));

import { SSH_CONNECT_TIMEOUT_MS, streamBackupFile } from "./backupClient";

const sshConfig = { host: "proxmox.local", username: "root", privateKeyPath: "/fake/key" };

afterEach(() => {
  connectBehavior = "ready";
  execBehavior = "success";
  vi.useRealTimers();
});

describe("streamBackupFile", () => {
  it("resolves with the live stream and connection for a valid volid", async () => {
    const result = await streamBackupFile(sshConfig, VALID_VOLID);

    expect(result.stream).toBeInstanceOf(EventEmitter);
    expect(result.conn).toBeInstanceOf(FakeClient);
    expect(result.conn.lastCommand).toBe(`cat-backup ${VALID_VOLID}`);
  });

  it("rejects for a volid that doesn't match the expected vzdump filename shape", async () => {
    await expect(streamBackupFile(sshConfig, "local:backup/../../etc/passwd")).rejects.toThrow(
      "Refusing to stream unsafe backup path",
    );
  });

  it("rejects for a volid with no storage prefix", async () => {
    await expect(streamBackupFile(sshConfig, "not-a-volid")).rejects.toThrow("Refusing to stream unsafe backup path");
  });

  it("rejects when the SSH connection itself errors", async () => {
    connectBehavior = "error";

    await expect(streamBackupFile(sshConfig, VALID_VOLID)).rejects.toThrow("connection refused");
  });

  it("rejects when exec itself fails", async () => {
    execBehavior = "exec-error";

    await expect(streamBackupFile(sshConfig, VALID_VOLID)).rejects.toThrow("exec failed");
  });

  it("rejects if the SSH connection never becomes ready, within the configured timeout", async () => {
    vi.useFakeTimers();
    connectBehavior = "hang";

    const promise = streamBackupFile(sshConfig, VALID_VOLID);
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(SSH_CONNECT_TIMEOUT_MS);
    await assertion;
  });

  it("cleans up the connection when the SSH connection itself errors", async () => {
    connectBehavior = "error";
    const endSpy = vi.spyOn(FakeClient.prototype, "end");

    await expect(streamBackupFile(sshConfig, VALID_VOLID)).rejects.toThrow("connection refused");
    expect(endSpy).toHaveBeenCalled();

    endSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/ssh/backupClient.test.js`
Expected: FAIL — `Cannot find module './backupClient'`.

- [ ] **Step 3: Write the implementation**

```js
// src/utils/ssh/backupClient.js
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

export function streamBackupFile(sshConfig, volid) {
  if (!VOLID_PATTERN.test(volid)) {
    return Promise.reject(new Error(`Refusing to stream unsafe backup path: ${volid}`));
  }

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
        conn.exec(`cat-backup ${volid}`, (err, stream) => {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/ssh/backupClient.test.js`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/utils/ssh/backupClient.js src/utils/ssh/backupClient.test.js --no-warn-ignored
npx prettier --check src/utils/ssh/backupClient.js src/utils/ssh/backupClient.test.js
git add src/utils/ssh/backupClient.js src/utils/ssh/backupClient.test.js
git commit -m "feat(backups): add unbuffered SSH backup file streaming client"
```

---

### Task 3: Forced-command extension for backup download

**Files:**
- Modify: `deploy/proxmox-smart-helper.sh`
- Modify: `deploy/SSH_SETUP.md`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the remote-side counterpart to Task 2's `streamBackupFile`, which sends the exact command string `cat-backup <volid>` this script must recognize).
- Produces: the `cat-backup <volid>` forced-command case Task 2's `streamBackupFile` already assumes.

No automated test exists for this script today (it's exercised only by manual verification against a real Proxmox host, same as the rest of `deploy/SSH_SETUP.md`) — this task's own verification step is that manual check.

- [ ] **Step 1: Add the new case to the script**

Add this case, in the same style as the existing `pct exec ... -- ps ...` entry (loose outer prefix match, then strict validation on extracted variables via nested `case`), just before the final catch-all `*)` branch of `deploy/proxmox-smart-helper.sh`:

```sh
  "cat-backup "*)
    rest="${cmd#cat-backup }"
    storage="${rest%%:*}"
    aftercolon="${rest#*:}"
    case "$storage" in
      ''|*[!A-Za-z0-9_-]*)
        echo "refused: invalid storage id" >&2
        exit 1
        ;;
    esac
    case "$aftercolon" in
      backup/vzdump-qemu-*|backup/vzdump-lxc-*)
        ;;
      *)
        echo "refused: invalid backup path" >&2
        exit 1
        ;;
    esac
    filename="${aftercolon#backup/}"
    case "$filename" in
      vzdump-qemu-[0-9]*-[0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].vma|\
      vzdump-qemu-[0-9]*-[0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].vma.gz|\
      vzdump-qemu-[0-9]*-[0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].vma.zst|\
      vzdump-lxc-[0-9]*-[0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].tar|\
      vzdump-lxc-[0-9]*-[0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].tar.gz|\
      vzdump-lxc-[0-9]*-[0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]-[0-9][0-9]_[0-9][0-9]_[0-9][0-9].tar.zst)
        ;;
      *)
        echo "refused: invalid backup filename" >&2
        exit 1
        ;;
    esac
    path=$(pvesm path "${storage}:backup/${filename}") || {
      echo "refused: could not resolve backup path" >&2
      exit 1
    }
    case "$path" in
      /*) ;;
      *)
        echo "refused: resolved path not absolute" >&2
        exit 1
        ;;
    esac
    exec cat "$path"
    ;;
```

**Note for the implementer:** `pvesm path <storage>:<volid>` is Proxmox's own CLI for resolving a volume ID to its real filesystem path — this hasn't been run against a real Proxmox host yet as part of this plan. Task 13's live verification step is where this gets confirmed; if `pvesm path`'s actual output differs (e.g. trailing whitespace, a different exit-code convention on failure), fix this case block then, and update this plan file's code block to match reality before considering the task done.

- [ ] **Step 2: Update `deploy/SSH_SETUP.md`**

Add a new numbered note near the top (in the existing "Upgrading from an earlier version" section) so operators upgrading from before this plan know to re-copy the script:

Find this text:
```
Already set this up before and just pulled a new version of the app? Re-run
step 2 below (re-copy `deploy/proxmox-smart-helper.sh` to the Proxmox host)
whenever this file changes. The forced-command script lives on the Proxmox
host, not on the app's own host, so deploying a new version of the app does
NOT update it automatically. If you skip this, LXC process/OS-detail fetches and the Proxmox host's own
Details toggle will fail with `refused: command not permitted for this key`
until you re-copy the script.
```

Replace with:
```
Already set this up before and just pulled a new version of the app? Re-run
step 2 below (re-copy `deploy/proxmox-smart-helper.sh` to the Proxmox host)
whenever this file changes. The forced-command script lives on the Proxmox
host, not on the app's own host, so deploying a new version of the app does
NOT update it automatically. If you skip this, LXC process/OS-detail fetches and the Proxmox host's own
Details toggle will fail with `refused: command not permitted for this key`
until you re-copy the script. As of the Backup Lifecycle Management plan,
this also applies to the `/backups` page's Download button, which uses the
same key's new `cat-backup` command.
```

Also update the first line of the script's own description comment (line 1 of `deploy/proxmox-smart-helper.sh`'s allowlist summary — `lsblk`, `smartctl -j -a <device>`, `df`, `lvs`, `pvs`, a fixed host-level `ps`, or `pct exec <vmid> -- ...`) to append the new command to that list, so the file's own header stays accurate:

Find (in `deploy/SSH_SETUP.md`):
```
This key can only run `lsblk`, `smartctl -j -a <device>`, `df`, `lvs`,
`pvs`, a fixed host-level `ps` (process listing for the Proxmox host
itself), or `pct exec <vmid> -- ...` (process listing and OS-release probe
for a specific container) (each a single fixed, read-only, parameterless,
path-validated, or vmid-validated command) — nothing else — enforced
server-side by a forced command, not just by client-side discipline.
```

Replace with:
```
This key can only run `lsblk`, `smartctl -j -a <device>`, `df`, `lvs`,
`pvs`, a fixed host-level `ps` (process listing for the Proxmox host
itself), `pct exec <vmid> -- ...` (process listing and OS-release probe
for a specific container), or `cat-backup <storage>:<volid>` (streams one
backup archive's bytes, after validating the storage id and vzdump
filename shape and resolving the real path via Proxmox's own `pvesm path`)
(each a single fixed, read-only, parameterless, path-validated, or
vmid-validated command) — nothing else — enforced server-side by a forced
command, not just by client-side discipline.
```

- [ ] **Step 3: Commit**

```bash
git add deploy/proxmox-smart-helper.sh deploy/SSH_SETUP.md
git commit -m "feat(backups): add cat-backup forced command for streaming downloads"
```

(Manual verification against a real Proxmox host happens in Task 13, once the rest of the feature exists end-to-end.)

---

### Task 4: API routes — storages, list, run, status

**Files:**
- Create: `src/pages/api/proxmox/backups/storages.js`
- Create: `src/pages/api/proxmox/backups/list.js`
- Create: `src/pages/api/proxmox/backups/run.js`
- Create: `src/pages/api/proxmox/backups/status.js`
- Test: `src/__tests__/pages/api/proxmox/backups/storages.test.js`
- Test: `src/__tests__/pages/api/proxmox/backups/list.test.js`
- Test: `src/__tests__/pages/api/proxmox/backups/run.test.js`
- Test: `src/__tests__/pages/api/proxmox/backups/status.test.js`

**Interfaces:**
- Consumes: `getPveConfig` from `utils/config/proxmox` (existing), `listBackupStorages`/`listBackupsForVm`/`startBackup`/`pollBackupTask` from `utils/proxmox/backups` (Task 1), `createMockRes` from `test-utils/create-mock-res` (existing, used by `vms/index.test.js`).
- Produces (consumed by Tasks 9 and 10):
  - `GET /api/proxmox/backups/storages?node=` → `200 { storages: [...] }`
  - `GET /api/proxmox/backups/list?node=&vmid=` → `200 { backups: [...] }`
  - `POST /api/proxmox/backups/run` body `{ node, vmid, storage }` → `200 { upid }`
  - `GET /api/proxmox/backups/status?node=&upid=` → `200 { status, exitstatus }`

- [ ] **Step 1: Write the failing tests**

```js
// src/__tests__/pages/api/proxmox/backups/storages.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, listBackupStorages } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  listBackupStorages: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ listBackupStorages }));

import handler from "pages/api/proxmox/backups/storages";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 405 for non-GET methods", async () => {
  const req = { method: "POST", query: {} };
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for a missing node parameter", async () => {
  const req = { method: "GET", query: {} };
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(400);
});

it("returns 500 when Proxmox config is missing", async () => {
  getPveConfig.mockReturnValue(null);
  const req = { method: "GET", query: { node: "proxmox" } };
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
});

it("returns the storage list on success", async () => {
  listBackupStorages.mockResolvedValue([{ storage: "local", prunePolicy: "keep-last=3" }]);
  const req = { method: "GET", query: { node: "proxmox" } };
  const res = createMockRes();

  await handler(req, res);

  expect(listBackupStorages).toHaveBeenCalledWith(pveConfig, "proxmox");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ storages: [{ storage: "local", prunePolicy: "keep-last=3" }] });
});

it("returns 500 when listBackupStorages throws", async () => {
  listBackupStorages.mockRejectedValue(new Error("boom"));
  const req = { method: "GET", query: { node: "proxmox" } };
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
});
```

```js
// src/__tests__/pages/api/proxmox/backups/list.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, listBackupsForVm } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  listBackupsForVm: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ listBackupsForVm }));

import handler from "pages/api/proxmox/backups/list";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 405 for non-GET methods", async () => {
  const res = createMockRes();
  await handler({ method: "DELETE", query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for an invalid vmid", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: { node: "proxmox", vmid: "abc" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
});

it("returns the backup list on success", async () => {
  listBackupsForVm.mockResolvedValue([{ volid: "local:backup/x", size: 1, ctime: 1, notes: null, storage: "local", prunePolicy: null }]);
  const res = createMockRes();

  await handler({ method: "GET", query: { node: "proxmox", vmid: "100" } }, res);

  expect(listBackupsForVm).toHaveBeenCalledWith(pveConfig, "proxmox", "100");
  expect(res.status).toHaveBeenCalledWith(200);
});

it("returns 500 when listBackupsForVm throws", async () => {
  listBackupsForVm.mockRejectedValue(new Error("boom"));
  const res = createMockRes();
  await handler({ method: "GET", query: { node: "proxmox", vmid: "100" } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});
```

```js
// src/__tests__/pages/api/proxmox/backups/run.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, startBackup } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  startBackup: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ startBackup }));

import handler from "pages/api/proxmox/backups/run";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 405 for non-POST methods", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: {}, body: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for an invalid storage parameter", async () => {
  const res = createMockRes();
  await handler({ method: "POST", body: { node: "proxmox", vmid: "100", storage: "bad storage!" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
});

it("starts a backup and returns the upid", async () => {
  startBackup.mockResolvedValue({ upid: "UPID:proxmox:...:" });
  const res = createMockRes();

  await handler({ method: "POST", body: { node: "proxmox", vmid: "100", storage: "local" } }, res);

  expect(startBackup).toHaveBeenCalledWith(pveConfig, "proxmox", "100", "local");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ upid: "UPID:proxmox:...:" });
});

it("returns 500 when startBackup throws", async () => {
  startBackup.mockRejectedValue(new Error("boom"));
  const res = createMockRes();
  await handler({ method: "POST", body: { node: "proxmox", vmid: "100", storage: "local" } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});
```

```js
// src/__tests__/pages/api/proxmox/backups/status.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, pollBackupTask } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  pollBackupTask: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ pollBackupTask }));

import handler from "pages/api/proxmox/backups/status";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 400 for an invalid upid", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: { node: "proxmox", upid: "not-a-upid" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
});

it("returns the task status on success", async () => {
  pollBackupTask.mockResolvedValue({ status: "stopped", exitstatus: "OK" });
  const res = createMockRes();

  await handler({ method: "GET", query: { node: "proxmox", upid: "UPID:proxmox:00001234:00005678:6501234A:vzdump:100::" } }, res);

  expect(pollBackupTask).toHaveBeenCalledWith(pveConfig, "proxmox", "UPID:proxmox:00001234:00005678:6501234A:vzdump:100::");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ status: "stopped", exitstatus: "OK" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/__tests__/pages/api/proxmox/backups/`
Expected: FAIL — the four route modules don't exist yet.

- [ ] **Step 3: Write the implementations**

```js
// src/pages/api/proxmox/backups/storages.js
import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { listBackupStorages } from "utils/proxmox/backups";

const logger = createLogger("backupsStoragesService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node } = req.query;
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    const storages = await listBackupStorages(pveConfig, node);
    return res.status(200).json({ storages });
  } catch (error) {
    logger.error("Failed to list backup storages for %s:", node, error);
    return res.status(500).json({ error: "Failed to list backup storages" });
  }
}
```

```js
// src/pages/api/proxmox/backups/list.js
import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { listBackupsForVm } from "utils/proxmox/backups";

const logger = createLogger("backupsListService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_VMID = /^\d+$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, vmid } = req.query;
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof vmid !== "string" || !VALID_VMID.test(vmid)) {
    return res.status(400).json({ error: "Invalid or missing vmid parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    const backups = await listBackupsForVm(pveConfig, node, vmid);
    return res.status(200).json({ backups });
  } catch (error) {
    logger.error("Failed to list backups for %s/%s:", node, vmid, error);
    return res.status(500).json({ error: "Failed to list backups" });
  }
}
```

```js
// src/pages/api/proxmox/backups/run.js
import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { startBackup } from "utils/proxmox/backups";

const logger = createLogger("backupsRunService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_VMID = /^\d+$/;
const VALID_STORAGE = /^[A-Za-z0-9_-]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, vmid, storage } = req.body ?? {};
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof vmid !== "string" || !VALID_VMID.test(vmid)) {
    return res.status(400).json({ error: "Invalid or missing vmid parameter" });
  }
  if (typeof storage !== "string" || !VALID_STORAGE.test(storage)) {
    return res.status(400).json({ error: "Invalid or missing storage parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    const { upid } = await startBackup(pveConfig, node, vmid, storage);
    return res.status(200).json({ upid });
  } catch (error) {
    logger.error("Failed to start backup for %s/%s on %s:", node, vmid, storage, error);
    return res.status(500).json({ error: "Failed to start backup" });
  }
}
```

```js
// src/pages/api/proxmox/backups/status.js
import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { pollBackupTask } from "utils/proxmox/backups";

const logger = createLogger("backupsStatusService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_UPID = /^UPID:[\w.:-]+$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, upid } = req.query;
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof upid !== "string" || !VALID_UPID.test(upid)) {
    return res.status(400).json({ error: "Invalid or missing upid parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    const result = await pollBackupTask(pveConfig, node, upid);
    return res.status(200).json(result);
  } catch (error) {
    logger.error("Failed to poll backup task %s on %s:", upid, node, error);
    return res.status(500).json({ error: "Failed to poll backup task" });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/__tests__/pages/api/proxmox/backups/`
Expected: PASS, all tests across the four files.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/pages/api/proxmox/backups/storages.js src/pages/api/proxmox/backups/list.js src/pages/api/proxmox/backups/run.js src/pages/api/proxmox/backups/status.js src/__tests__/pages/api/proxmox/backups/*.test.js --no-warn-ignored
npx prettier --check src/pages/api/proxmox/backups/storages.js src/pages/api/proxmox/backups/list.js src/pages/api/proxmox/backups/run.js src/pages/api/proxmox/backups/status.js src/__tests__/pages/api/proxmox/backups/*.test.js
git add src/pages/api/proxmox/backups/storages.js src/pages/api/proxmox/backups/list.js src/pages/api/proxmox/backups/run.js src/pages/api/proxmox/backups/status.js src/__tests__/pages/api/proxmox/backups/
git commit -m "feat(backups): add storages/list/run/status API routes"
```

---

### Task 5: API route — delete

**Files:**
- Create: `src/pages/api/proxmox/backups/delete.js`
- Test: `src/__tests__/pages/api/proxmox/backups/delete.test.js`

**Interfaces:**
- Consumes: `getPveConfig` (existing), `deleteBackup` from `utils/proxmox/backups` (Task 1).
- Produces (consumed by Task 9): `DELETE /api/proxmox/backups/delete?node=&volid=` → `200 { success: true }`.

- [ ] **Step 1: Write the failing test**

```js
// src/__tests__/pages/api/proxmox/backups/delete.test.js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getPveConfig, deleteBackup } = vi.hoisted(() => ({
  getPveConfig: vi.fn(),
  deleteBackup: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getPveConfig }));
vi.mock("utils/proxmox/backups", () => ({ deleteBackup }));

import handler from "pages/api/proxmox/backups/delete";

const pveConfig = { url: "https://10.0.0.9:8006", token: "t", secret: "s" };
const VALID_VOLID = "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst";

beforeEach(() => {
  vi.clearAllMocks();
  getPveConfig.mockReturnValue(pveConfig);
});

it("returns 405 for non-DELETE methods", async () => {
  const res = createMockRes();
  await handler({ method: "GET", query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for a volid that doesn't match the expected shape", async () => {
  const res = createMockRes();
  await handler({ method: "DELETE", query: { node: "proxmox", volid: "not-a-volid" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(deleteBackup).not.toHaveBeenCalled();
});

it("deletes the backup and returns success", async () => {
  deleteBackup.mockResolvedValue(undefined);
  const res = createMockRes();

  await handler({ method: "DELETE", query: { node: "proxmox", volid: VALID_VOLID } }, res);

  expect(deleteBackup).toHaveBeenCalledWith(pveConfig, "proxmox", VALID_VOLID);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ success: true });
});

it("returns 500 when deleteBackup throws", async () => {
  deleteBackup.mockRejectedValue(new Error("boom"));
  const res = createMockRes();
  await handler({ method: "DELETE", query: { node: "proxmox", volid: VALID_VOLID } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/__tests__/pages/api/proxmox/backups/delete.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

```js
// src/pages/api/proxmox/backups/delete.js
import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { deleteBackup } from "utils/proxmox/backups";

const logger = createLogger("backupsDeleteService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_VOLID =
  /^[A-Za-z0-9_-]+:backup\/vzdump-(qemu|lxc)-\d+-\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.(vma(\.(gz|zst))?|tar(\.(gz|zst))?)$/;

export default async function handler(req, res) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, volid } = req.query;
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof volid !== "string" || !VALID_VOLID.test(volid)) {
    return res.status(400).json({ error: "Invalid or missing volid parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    await deleteBackup(pveConfig, node, volid);
    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error("Failed to delete backup %s on %s:", volid, node, error);
    return res.status(500).json({ error: "Failed to delete backup" });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/__tests__/pages/api/proxmox/backups/delete.test.js`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/pages/api/proxmox/backups/delete.js src/__tests__/pages/api/proxmox/backups/delete.test.js --no-warn-ignored
npx prettier --check src/pages/api/proxmox/backups/delete.js src/__tests__/pages/api/proxmox/backups/delete.test.js
git add src/pages/api/proxmox/backups/delete.js src/__tests__/pages/api/proxmox/backups/delete.test.js
git commit -m "feat(backups): add delete API route"
```

---

### Task 6: API route — download (streaming)

**Files:**
- Create: `src/pages/api/proxmox/backups/download.js`
- Test: `src/__tests__/pages/api/proxmox/backups/download.test.js`

**Interfaces:**
- Consumes: `getSmartConfig` from `utils/config/proxmox` (existing), `streamBackupFile` from `utils/ssh/backupClient` (Task 2).
- Produces (consumed by Task 9): `GET /api/proxmox/backups/download?volid=` — pipes the backup file's bytes to the response with `Content-Disposition: attachment` and `Content-Type: application/octet-stream`.

- [ ] **Step 1: Write the failing test**

```js
// src/__tests__/pages/api/proxmox/backups/download.test.js
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getSmartConfig, streamBackupFile } = vi.hoisted(() => ({
  getSmartConfig: vi.fn(),
  streamBackupFile: vi.fn(),
}));

vi.mock("utils/config/proxmox", () => ({ getSmartConfig }));
vi.mock("utils/ssh/backupClient", () => ({ streamBackupFile }));

import handler from "pages/api/proxmox/backups/download";

const sshConfig = { host: "proxmox.local", username: "root", privateKeyPath: "/fake/key" };
const VALID_VOLID = "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst";

function createMockStreamingRes() {
  const res = createMockRes();
  res.pipe = vi.fn();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSmartConfig.mockReturnValue(sshConfig);
});

it("returns 405 for non-GET methods", async () => {
  const res = createMockStreamingRes();
  await handler({ method: "POST", query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(405);
});

it("returns 400 for a volid that doesn't match the expected shape", async () => {
  const res = createMockStreamingRes();
  await handler({ method: "GET", query: { volid: "not-a-volid" } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(streamBackupFile).not.toHaveBeenCalled();
});

it("returns 500 when SMART SSH configuration is missing", async () => {
  getSmartConfig.mockReturnValue(null);
  const res = createMockStreamingRes();
  await handler({ method: "GET", query: { volid: VALID_VOLID } }, res);
  expect(res.status).toHaveBeenCalledWith(500);
});

it("sets download headers and pipes the stream on success", async () => {
  const fakeStream = new EventEmitter();
  fakeStream.pipe = vi.fn();
  const fakeConn = { end: vi.fn() };
  streamBackupFile.mockResolvedValue({ stream: fakeStream, conn: fakeConn });

  const req = { method: "GET", query: { volid: VALID_VOLID }, on: vi.fn() };
  const res = createMockStreamingRes();

  await handler(req, res);

  expect(streamBackupFile).toHaveBeenCalledWith(sshConfig, VALID_VOLID);
  expect(res.setHeader).toHaveBeenCalledWith(
    "Content-Disposition",
    'attachment; filename="vzdump-qemu-100-2026_08_24-10_00_00.vma.zst"',
  );
  expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/octet-stream");
  expect(fakeStream.pipe).toHaveBeenCalledWith(res);
});

it("returns 500 when opening the SSH stream fails", async () => {
  streamBackupFile.mockRejectedValue(new Error("connection refused"));
  const req = { method: "GET", query: { volid: VALID_VOLID }, on: vi.fn() };
  const res = createMockStreamingRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/__tests__/pages/api/proxmox/backups/download.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

```js
// src/pages/api/proxmox/backups/download.js
import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { streamBackupFile } from "utils/ssh/backupClient";

const logger = createLogger("backupsDownloadService");
const VALID_VOLID =
  /^[A-Za-z0-9_-]+:backup\/vzdump-(qemu|lxc)-\d+-\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.(vma(\.(gz|zst))?|tar(\.(gz|zst))?)$/;

// This route streams a response body manually instead of ever calling
// res.json()/res.end() synchronously - externalResolver tells Next.js not
// to warn that the API resolved without sending a response in the usual way.
export const config = {
  api: {
    externalResolver: true,
  },
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { volid } = req.query;
  if (typeof volid !== "string" || !VALID_VOLID.test(volid)) {
    return res.status(400).json({ error: "Invalid or missing volid parameter" });
  }

  const sshConfig = getSmartConfig();
  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let stream;
  let conn;
  try {
    ({ stream, conn } = await streamBackupFile(sshConfig, volid));
  } catch (error) {
    logger.error("Failed to open backup download stream for %s:", volid, error);
    return res.status(500).json({ error: "Failed to start download" });
  }

  const filename = volid.split("/").pop();
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/octet-stream");

  stream.on("error", (error) => {
    logger.error("Backup download stream failed for %s:", volid, error);
    res.end();
  });
  stream.on("close", () => {
    conn.end();
  });
  req.on("close", () => {
    conn.end();
  });

  return stream.pipe(res);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/__tests__/pages/api/proxmox/backups/download.test.js`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/pages/api/proxmox/backups/download.js src/__tests__/pages/api/proxmox/backups/download.test.js --no-warn-ignored
npx prettier --check src/pages/api/proxmox/backups/download.js src/__tests__/pages/api/proxmox/backups/download.test.js
git add src/pages/api/proxmox/backups/download.js src/__tests__/pages/api/proxmox/backups/download.test.js
git commit -m "feat(backups): add streaming download API route"
```

---

### Task 7: Frontend — delete confirm dialog

**Files:**
- Create: `src/components/backups/delete-confirm-dialog.jsx`
- Test: `src/components/backups/delete-confirm-dialog.test.jsx`

**Interfaces:**
- Consumes: `Dialog`, `DialogBackdrop`, `DialogPanel`, `DialogTitle` from `@headlessui/react` (existing dependency, same components `InstallWizardDialog.jsx` uses).
- Produces (consumed by Task 9): `<DeleteConfirmDialog open vmName onConfirm onClose />` where `onConfirm` is `() => Promise<{ ok: true } | { ok: false, error: string }>`.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/backups/delete-confirm-dialog.test.jsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DeleteConfirmDialog from "./delete-confirm-dialog";

describe("components/backups/delete-confirm-dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the Delete button disabled until the typed name matches exactly", () => {
    render(<DeleteConfirmDialog open vmName="my-vm" onConfirm={vi.fn()} onClose={vi.fn()} />);

    const deleteButton = screen.getByRole("button", { name: "Delete" });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "wrong-name" } });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my-vm" } });
    expect(deleteButton).toBeEnabled();
  });

  it("calls onConfirm and then onClose when the typed name matches and Delete is clicked", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    render(<DeleteConfirmDialog open vmName="my-vm" onConfirm={onConfirm} onClose={onClose} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my-vm" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalled();
  });

  it("shows an inline error and stays open when onConfirm fails", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: false, error: "Failed to delete backup" });
    const onClose = vi.fn();
    render(<DeleteConfirmDialog open vmName="my-vm" onConfirm={onConfirm} onClose={onClose} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my-vm" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("Failed to delete backup")).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancel closes without calling onConfirm", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<DeleteConfirmDialog open vmName="my-vm" onConfirm={onConfirm} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/backups/delete-confirm-dialog.test.jsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

```jsx
// src/components/backups/delete-confirm-dialog.jsx
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";

export default function DeleteConfirmDialog({ open, vmName, onConfirm, onClose }) {
  const [typedName, setTypedName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setTypedName("");
      setDeleting(false);
      setError(null);
    }
  }, [open]);

  const matches = typedName === vmName;

  const handleClose = () => {
    if (!deleting) onClose();
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    const result = await onConfirm();
    setDeleting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-md bg-theme-100 dark:bg-theme-800 p-4 space-y-3">
          <DialogTitle className="text-sm font-bold">Delete backup?</DialogTitle>
          <p className="text-xs">
            This permanently deletes a backup of <strong>{vmName}</strong>. Type the VM/CT name to confirm:
          </p>
          <input
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder={vmName}
            className="w-full rounded-sm border border-theme-300 dark:border-theme-700 bg-transparent px-2 py-1 text-xs"
          />
          {error && <p className="text-xs text-rose-500/80">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={handleClose} disabled={deleting} className="text-xs px-2 py-1">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!matches || deleting}
              className="text-xs px-2 py-1 text-rose-500/80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/backups/delete-confirm-dialog.test.jsx`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/components/backups/delete-confirm-dialog.jsx src/components/backups/delete-confirm-dialog.test.jsx --no-warn-ignored
npx prettier --check src/components/backups/delete-confirm-dialog.jsx src/components/backups/delete-confirm-dialog.test.jsx
git add src/components/backups/delete-confirm-dialog.jsx src/components/backups/delete-confirm-dialog.test.jsx
git commit -m "feat(backups): add type-to-confirm delete dialog"
```

---

### Task 8: Frontend — run backup dialog

**Files:**
- Create: `src/components/backups/run-backup-dialog.jsx`
- Test: `src/components/backups/run-backup-dialog.test.jsx`

**Interfaces:**
- Consumes: `Dialog`/`DialogBackdrop`/`DialogPanel`/`DialogTitle` from `@headlessui/react`; `GET /api/proxmox/backups/storages?node=` (Task 4); `POST /api/proxmox/backups/run` (Task 4); `GET /api/proxmox/backups/status?node=&upid=` (Task 4).
- Produces (consumed by Task 9): `<RunBackupDialog open node vmid onClose onDone />` — `onDone` is called once the polled task finishes with `exitstatus === "OK"`.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/backups/run-backup-dialog.test.jsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RunBackupDialog from "./run-backup-dialog";

describe("components/backups/run-backup-dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("loads storages and disables Start until one is selected", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ storages: [{ storage: "local", prunePolicy: null }] }),
    });

    render(<RunBackupDialog open node="proxmox" vmid="100" onClose={vi.fn()} onDone={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();

    await waitFor(() => expect(screen.getByRole("option", { name: "local" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } });

    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("starts a backup, polls status, and calls onDone when it completes successfully", async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ storages: [{ storage: "local", prunePolicy: null }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ upid: "UPID:proxmox:...:" }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "running", exitstatus: null }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "stopped", exitstatus: "OK" }) });

    const onDone = vi.fn();
    render(<RunBackupDialog open node="proxmox" vmid="100" onClose={vi.fn()} onDone={onDone} />);

    await waitFor(() => expect(screen.getByRole("option", { name: "local" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByText("Backup running...")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Backup completed.")).toBeInTheDocument(), { timeout: 6000 });
    expect(onDone).toHaveBeenCalled();
  });

  it("shows an inline error when starting the backup fails", async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ storages: [{ storage: "local", prunePolicy: null }] }) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Backup already running" }) });

    render(<RunBackupDialog open node="proxmox" vmid="100" onClose={vi.fn()} onDone={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("option", { name: "local" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByText("Backup already running")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/backups/run-backup-dialog.test.jsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

```jsx
// src/components/backups/run-backup-dialog.jsx
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";
import useSWR from "swr";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

const POLL_INTERVAL_MS = 2000;

export default function RunBackupDialog({ open, node, vmid, onClose, onDone }) {
  const [storage, setStorage] = useState("");
  const [upid, setUpid] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const { data: storagesData } = useSWR(
    open ? `/api/proxmox/backups/storages?node=${encodeURIComponent(node)}` : null,
    fetcher,
  );

  useEffect(() => {
    if (open) {
      setStorage("");
      setUpid(null);
      setResult(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!upid) return undefined;
    const interval = setInterval(async () => {
      const res = await fetch(
        `/api/proxmox/backups/status?node=${encodeURIComponent(node)}&upid=${encodeURIComponent(upid)}`,
      );
      const body = await res.json();
      if (body.status !== "running") {
        clearInterval(interval);
        setResult(body);
        if (body.exitstatus === "OK") onDone();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [upid, node, onDone]);

  const handleStart = async () => {
    setError(null);
    const res = await fetch("/api/proxmox/backups/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node, vmid, storage }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Failed to start backup");
      return;
    }
    setUpid(body.upid);
  };

  const handleClose = () => {
    if (!upid || result) onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-md bg-theme-100 dark:bg-theme-800 p-4 space-y-3">
          <DialogTitle className="text-sm font-bold">Back up now</DialogTitle>
          {!upid && (
            <>
              <select
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                className="w-full rounded-sm border border-theme-300 dark:border-theme-700 bg-transparent px-2 py-1 text-xs"
              >
                <option value="">Select a storage...</option>
                {(storagesData?.storages ?? []).map((s) => (
                  <option key={s.storage} value={s.storage}>
                    {s.storage}
                  </option>
                ))}
              </select>
              {error && <p className="text-xs text-rose-500/80">{error}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className="text-xs px-2 py-1">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={!storage}
                  className="text-xs px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Start
                </button>
              </div>
            </>
          )}
          {upid && !result && <p className="text-xs">Backup running...</p>}
          {result && (
            <>
              <p className="text-xs">
                {result.exitstatus === "OK" ? "Backup completed." : `Backup failed: ${result.exitstatus}`}
              </p>
              <div className="flex justify-end">
                <button type="button" onClick={onClose} className="text-xs px-2 py-1">
                  Close
                </button>
              </div>
            </>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/backups/run-backup-dialog.test.jsx`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/components/backups/run-backup-dialog.jsx src/components/backups/run-backup-dialog.test.jsx --no-warn-ignored
npx prettier --check src/components/backups/run-backup-dialog.jsx src/components/backups/run-backup-dialog.test.jsx
git add src/components/backups/run-backup-dialog.jsx src/components/backups/run-backup-dialog.test.jsx
git commit -m "feat(backups): add run-backup dialog with task-status polling"
```

---

### Task 9: Frontend — backup list

**Files:**
- Create: `src/components/backups/backup-list.jsx`
- Test: `src/components/backups/backup-list.test.jsx`

**Interfaces:**
- Consumes: `useSWR`/`mutate` from `swr` (existing dependency); `GET /api/proxmox/backups/list?node=&vmid=` (Task 4); `DELETE /api/proxmox/backups/delete?node=&volid=` (Task 5); `GET /api/proxmox/backups/download?volid=` (Task 6, plain link, not fetched via JS); `DeleteConfirmDialog` (Task 7); `RunBackupDialog` (Task 8).
- Produces (consumed by Task 10): `<BackupList node vmid vmName />`.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/backups/backup-list.test.jsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mutate };
});

import BackupList from "./backup-list";

describe("components/backups/backup-list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("shows a message when there are no backups", async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ backups: [] }) });

    render(<BackupList node="proxmox" vmid="100" vmName="my-vm" />);

    await waitFor(() => expect(screen.getByText("No backups found.")).toBeInTheDocument());
  });

  it("renders a row per backup with date, size, storage, and retention", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          backups: [
            {
              volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
              size: 1048576,
              ctime: 1756029600,
              notes: null,
              storage: "local",
              prunePolicy: "keep-last=3",
            },
          ],
        }),
    });

    render(<BackupList node="proxmox" vmid="100" vmName="my-vm" />);

    await waitFor(() => expect(screen.getByText("local")).toBeInTheDocument());
    expect(screen.getByText("1.0 MB")).toBeInTheDocument();
    expect(screen.getByText("keep-last=3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/proxmox/backups/download?volid=local%3Abackup%2Fvzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
    );
  });

  it("deletes a backup and revalidates the list", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            backups: [
              {
                volid: "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
                size: 1,
                ctime: 1,
                notes: null,
                storage: "local",
                prunePolicy: null,
              },
            ],
          }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });

    render(<BackupList node="proxmox" vmid="100" vmName="my-vm" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my-vm" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/proxmox/backups/delete?node=proxmox&volid=local%3Abackup%2Fvzdump-qemu-100-2026_08_24-10_00_00.vma.zst",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(mutate).toHaveBeenCalledWith("/api/proxmox/backups/list?node=proxmox&vmid=100");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/backups/backup-list.test.jsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

```jsx
// src/components/backups/backup-list.jsx
import { useState } from "react";
import useSWR, { mutate } from "swr";

import DeleteConfirmDialog from "./delete-confirm-dialog";
import RunBackupDialog from "./run-backup-dialog";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(ctime) {
  if (!ctime) return "-";
  return new Date(ctime * 1000).toLocaleString();
}

export default function BackupList({ node, vmid, vmName }) {
  const listKey = `/api/proxmox/backups/list?node=${encodeURIComponent(node)}&vmid=${encodeURIComponent(vmid)}`;
  const { data, error } = useSWR(listKey, fetcher);
  const [runOpen, setRunOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const handleDelete = async (volid) => {
    const res = await fetch(
      `/api/proxmox/backups/delete?node=${encodeURIComponent(node)}&volid=${encodeURIComponent(volid)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error ?? "Failed to delete backup" };
    }
    await mutate(listKey);
    return { ok: true };
  };

  if (error) {
    return <p className="text-xs text-rose-500/80">Failed to load backups.</p>;
  }

  if (!data) {
    return <p className="text-xs">Loading backups...</p>;
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setRunOpen(true)}
        className="text-xs px-2 py-1 rounded-sm bg-theme-200/50 dark:bg-theme-900/40"
      >
        Back up now
      </button>
      {data.backups.length === 0 ? (
        <p className="text-xs">No backups found.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left">
              <th>Date</th>
              <th>Size</th>
              <th>Storage</th>
              <th>Retention</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data.backups.map((b) => (
              <tr key={b.volid}>
                <td>{formatDate(b.ctime)}</td>
                <td>{formatBytes(b.size)}</td>
                <td>{b.storage}</td>
                <td>{b.prunePolicy ?? "-"}</td>
                <td className="flex gap-2">
                  <a
                    href={`/api/proxmox/backups/download?volid=${encodeURIComponent(b.volid)}`}
                    download
                    className="text-theme-500 dark:text-theme-300"
                  >
                    Download
                  </a>
                  <button type="button" onClick={() => setDeleteTarget(b.volid)} className="text-rose-500/80">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <RunBackupDialog
        open={runOpen}
        node={node}
        vmid={vmid}
        onClose={() => setRunOpen(false)}
        onDone={() => mutate(listKey)}
      />
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        vmName={vmName}
        onConfirm={() => handleDelete(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/backups/backup-list.test.jsx`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/components/backups/backup-list.jsx src/components/backups/backup-list.test.jsx --no-warn-ignored
npx prettier --check src/components/backups/backup-list.jsx src/components/backups/backup-list.test.jsx
git add src/components/backups/backup-list.jsx src/components/backups/backup-list.test.jsx
git commit -m "feat(backups): add backup list with download/delete/run-now"
```

---

### Task 10: Frontend — VM/CT list

**Files:**
- Create: `src/components/backups/vm-list.jsx`
- Test: `src/components/backups/vm-list.test.jsx`

**Interfaces:**
- Consumes: `useSWR` from `swr`; `GET /api/proxmox/vms` (existing route, returns `[{ vmid, node, type, name, status, ... }]` per `src/pages/api/proxmox/vms/index.js`); `BackupList` (Task 9).
- Produces (consumed by Task 11): `<VmList />` — no props, fetches its own guest list.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/backups/vm-list.test.jsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./backup-list", () => ({
  default: ({ node, vmid, vmName }) => <div data-testid="backup-list">{`${node}/${vmid}/${vmName}`}</div>,
}));

import VmList from "./vm-list";

describe("components/backups/vm-list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("lists every VM/CT and expands to show its backups on click", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { vmid: 100, node: "proxmox", type: "qemu", name: "example-vm", status: "running" },
          { vmid: 200, node: "proxmox", type: "lxc", name: "example-lxc", status: "running" },
        ]),
    });

    render(<VmList />);

    await waitFor(() => expect(screen.getByText("example-vm")).toBeInTheDocument());
    expect(screen.getByText("example-lxc")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-list")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("example-vm"));

    expect(screen.getByTestId("backup-list")).toHaveTextContent("proxmox/100/example-vm");
  });

  it("collapses a VM/CT's backups when clicked again", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ vmid: 100, node: "proxmox", type: "qemu", name: "example-vm", status: "running" }]),
    });

    render(<VmList />);

    await waitFor(() => expect(screen.getByText("example-vm")).toBeInTheDocument());
    fireEvent.click(screen.getByText("example-vm"));
    expect(screen.getByTestId("backup-list")).toBeInTheDocument();

    fireEvent.click(screen.getByText("example-vm"));
    expect(screen.queryByTestId("backup-list")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/backups/vm-list.test.jsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

```jsx
// src/components/backups/vm-list.jsx
import { useState } from "react";
import useSWR from "swr";

import BackupList from "./backup-list";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

export default function VmList() {
  const { data: vms, error } = useSWR("/api/proxmox/vms", fetcher);
  const [expanded, setExpanded] = useState(null);

  if (error) {
    return <p className="text-sm text-rose-500/80">Failed to load VMs/CTs.</p>;
  }

  if (!vms) {
    return <p className="text-sm">Loading...</p>;
  }

  return (
    <ul className="space-y-2">
      {vms.map((vm) => {
        const key = `${vm.node}/${vm.vmid}`;
        const isExpanded = expanded === key;
        return (
          <li key={key} className="rounded-md bg-theme-200/50 dark:bg-theme-900/20 p-2">
            <button
              type="button"
              onClick={() => setExpanded(isExpanded ? null : key)}
              className="w-full flex justify-between items-center text-sm font-bold"
            >
              <span>{vm.name}</span>
              <span className="text-xs font-normal">{vm.type}</span>
            </button>
            {isExpanded && (
              <div className="mt-2">
                <BackupList node={vm.node} vmid={String(vm.vmid)} vmName={vm.name} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/backups/vm-list.test.jsx`
Expected: PASS, all 2 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/components/backups/vm-list.jsx src/components/backups/vm-list.test.jsx --no-warn-ignored
npx prettier --check src/components/backups/vm-list.jsx src/components/backups/vm-list.test.jsx
git add src/components/backups/vm-list.jsx src/components/backups/vm-list.test.jsx
git commit -m "feat(backups): add expandable VM/CT list"
```

---

### Task 11: Frontend — `/backups` page and nav link

**Files:**
- Create: `src/pages/backups.js`
- Modify: `src/components/layout/NavHeader.jsx`
- Test: `src/components/layout/NavHeader.test.jsx` (extend existing, if present — otherwise create one covering both entries)

**Interfaces:**
- Consumes: `VmList` (Task 10).
- Produces: the `/backups` route itself; no further consumers within this plan.

- [ ] **Step 1: Check for an existing NavHeader test and write/extend the failing assertion**

Run `find src/components/layout -iname "NavHeader.test*"` first. If one exists, add this test inside its existing `describe` block; if not, create `src/components/layout/NavHeader.test.jsx` with this content:

```jsx
// src/components/layout/NavHeader.test.jsx
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import NavHeader from "./NavHeader";

describe("components/layout/NavHeader", () => {
  it("links to both the Widgets catalog and the Backups page", () => {
    render(<NavHeader />);

    expect(screen.getByRole("link", { name: /Widgets/ })).toHaveAttribute("href", "/widgets");
    expect(screen.getByRole("link", { name: /Backups/ })).toHaveAttribute("href", "/backups");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/layout/NavHeader.test.jsx`
Expected: FAIL — no link with name matching `/Backups/` exists yet.

- [ ] **Step 3: Add the nav entry and the page**

In `src/components/layout/NavHeader.jsx`, add an icon import and a new entry to `NAV_ITEMS`:

```js
import { BiExtension, BiHome, BiMenu, BiCloudUpload } from "react-icons/bi";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: BiHome },
  { href: "/widgets", label: "Widgets", icon: BiExtension },
  { href: "/backups", label: "Backups", icon: BiCloudUpload },
];
```

Create the page:

```jsx
// src/pages/backups.js
import VmList from "components/backups/vm-list";

export default function BackupsPage() {
  return (
    <div className="flex flex-col m-4 sm:m-8 sm:mt-16 mb-2">
      <h1 className="text-theme-800 dark:text-theme-300 text-xl font-medium mb-4">Backups</h1>
      <VmList />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/layout/NavHeader.test.jsx`
Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
npx eslint src/components/layout/NavHeader.jsx src/components/layout/NavHeader.test.jsx src/pages/backups.js --no-warn-ignored
npx prettier --check src/components/layout/NavHeader.jsx src/components/layout/NavHeader.test.jsx src/pages/backups.js
git add src/components/layout/NavHeader.jsx src/components/layout/NavHeader.test.jsx src/pages/backups.js
git commit -m "feat(backups): add /backups page and nav link"
```

---

### Task 12: Document required Proxmox privileges

**Files:**
- Modify: `README.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Add the privilege note**

Find this text in `README.md` (from the existing PVE API token setup instructions):

```
   This token inherits full `root@pam` privileges. Before exposing this
   dashboard publicly (e.g. via a Cloudflare Tunnel), replace it with a
   token scoped to a custom least-privilege Proxmox role — verify exact
   privilege names against current Proxmox ACL docs when doing so, rather
   than guessing them.
```

Replace with:

```
   This token inherits full `root@pam` privileges. Before exposing this
   dashboard publicly (e.g. via a Cloudflare Tunnel), replace it with a
   token scoped to a custom least-privilege Proxmox role — verify exact
   privilege names against current Proxmox ACL docs when doing so, rather
   than guessing them. If you use the `/backups` page, that role also needs
   `VM.Backup` (trigger an ad-hoc backup), `Datastore.AllocateSpace`
   (write/delete backup content), and `Datastore.Audit` (list backup
   content and storage retention settings).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(backups): note the PVE privileges the backups page needs"
```

---

### Task 13: Live verification against the real Proxmox host

**Files:** none (manual verification, no code changes).

- [ ] **Step 1: Re-copy the forced-command script**

Per `deploy/SSH_SETUP.md`'s upgrade note, copy the updated `deploy/proxmox-smart-helper.sh` to the Proxmox host and confirm it's executable (same command as initial setup, step 2 of `deploy/SSH_SETUP.md`).

- [ ] **Step 2: Verify `pvesm path` output against the real host**

SSH to the Proxmox host directly (not through the restricted key) and run `pvesm path <storage>:backup/<a real existing backup filename>` for at least one real backup. Confirm the output is a single absolute path with no trailing whitespace/newline surprises. If it differs from what Task 3's script assumes, fix the script's `path=$(pvesm path ...)` handling now and re-copy.

- [ ] **Step 3: Rebuild and redeploy the app container**

```bash
git pull
docker compose up -d --build
```

- [ ] **Step 4: Exercise the full flow on `/backups`**

- Open `/backups`, confirm every VM/CT lists, expand one.
- Click "Back up now" on a real (ideally small/test) VM/CT, pick a storage, confirm the dialog shows "Backup running..." then "Backup completed." and the new backup appears in the list without a page reload.
- Click "Download" on a real backup and confirm the file downloads correctly and its size matches what's shown in the list.
- Click "Delete" on a backup you don't need, confirm the type-to-confirm gate actually blocks deletion until the name matches, then delete it and confirm it disappears from the list without a page reload.
- Confirm the retention column shows real `prune-backups` values where configured.

- [ ] **Step 5: Update `progress.md`**

Add a "Backup lifecycle management" bullet to the "Shipped & deployed" section (matching the existing style for other shipped features), and remove its line from "Not yet implemented". Reference this plan and its spec file, same as other entries there.
