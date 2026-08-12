# Disk Capacity (used/total via df+lvs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real used/total capacity (not just SMART wear) to each disk card in the Disks dashboard section, computed from live `df` and LVM thin-pool data on the real Proxmox host.

**Architecture:** Extend the existing restricted SSH key (the same one `smartClient.js` already uses for `lsblk`/`smartctl`) with three new **fixed, parameterless** forced-command entries — `df`, `lvs`, `pvs` — added to `deploy/proxmox-smart-helper.sh`. A new pure function (`src/utils/disks/capacity.js`) walks each physical disk's existing `lsblk` child tree to correlate which `df` mountpoints and which LVM volume group belong to that specific disk, sums real filesystem usage with thin-pool `data_percent`, and returns one `{ usedBytes, totalBytes }` per disk. `/api/disks` merges this into the existing per-disk response shape; the dashboard's `DiskCard` renders it as a fourth stat pill using `pretty-bytes` (already a project dependency, unused until now).

**Tech Stack:** Next.js 16 (Pages Router), React 19, Vitest, `ssh2` (existing dependency, same connection module as SMART), `pretty-bytes` (existing dependency, first use).

## Global Constraints

- Node 22, pnpm only — never npm/yarn.
- Test via `pnpm test` (Vitest, `vitest run`).
- **Every new SSH allowlist command in `deploy/proxmox-smart-helper.sh` MUST be a fixed, parameterless, exact-string `case` match** — no client-supplied parameter is ever substituted into a command template for `df`/`lvs`/`pvs`. This is a stricter, more secure design than the original design spec's proposal (which sketched a parameterized `df <mountpoints...>`/`lvs ... <vg>` — see "Deviation from Design Spec" below for why this plan does not do that). Filtering to "which disk does this belong to" happens entirely client-side, on data the server already always returns in full.
- Do not modify the existing `lsblk`/`smartctl` case branches in `deploy/proxmox-smart-helper.sh`, or the existing `getSmartData`/`listBlockDevices`/`DEVICE_PATTERN` logic in `src/utils/ssh/smartClient.js` — this plan is additive only to that file.
- Do not modify `src/utils/disks/health.js` or `computeDiskHealth` — SMART health logic is a separate concern from capacity and stays untouched.
- Capacity data is an enrichment, not core functionality: if the new SSH calls fail (including the specific case where the app has been redeployed but the updated `proxmox-smart-helper.sh` hasn't yet been re-copied to the Proxmox host — a real, likely-to-happen-at-least-once operational sequencing issue, not a hypothetical), `/api/disks` must still return 200 with existing SMART data intact and `usedBytes`/`totalBytes: null` on every disk — never a 500 for the whole route.
- Swap logical volumes are deliberately excluded from the used/total aggregation (`lvs` reports no `data_percent` for linear/non-thin LVs like swap and root, so there is no "how full" figure to report for them; swap also isn't "data" in the sense this feature communicates). Document this exclusion inline in `capacity.js`, don't silently drop it without a comment.
- UI: reuse the existing `Stat`/`STAT_CLASS` pattern in `src/components/disks/group.jsx` — no new visual language, no new component classes.

## Deviation from Design Spec

`docs/superpowers/specs/2026-08-11-vm-lxc-disk-widgets-design.md`'s "New allowlist entries" section sketched `df -B1 --output=target,used,size <mountpoints...>` and `lvs ... <vg>` as parameterized commands, with the parameter validated server-side before substitution (the same pattern as `smartctl`'s device-path argument). Live investigation while planning this task found a simpler and strictly more secure alternative: `df`, `lvs`, and `pvs` all support a mode with **zero arguments** that reports on every local mount / every LV / every PV unconditionally, and the existing `lsblk` fetch already gives the client everything it needs to filter that full report down to "what belongs to this disk" — so no parameter, and therefore no parameter-validation logic, is needed at all. This plan uses that simpler shape: three new fixed-string `case` branches in `proxmox-smart-helper.sh`, identical in kind to the existing `lsblk` branch (not the parameterized `smartctl` branch). Flagging this explicitly because it is a deliberate, security-motivated departure from what the approved design spec described, even though the net capability delivered is the same.

## Real Data Verified During Planning

Checked directly against the real Proxmox host (`ssh proxmox`) before writing this plan:

- `df -B1 --output=source,target,fstype,used,size` (no filters) on the real host returns one line per mount, including pseudo-filesystems (`tmpfs`, `devtmpfs`, `efivarfs`, `fuse` for `/etc/pve`) alongside the real ones (`/dev/mapper/pve-root` → `/`, `/dev/sda2` → `/boot/efi`, `/dev/mapper/sdc_crypt` → `/mnt/storage`). Attempting to filter pseudo-filesystems out server-side via `df -x` flags is unreliable — `efivarfs` and `fuse` mounts survived several `-x` exclusions in testing. This plan does not try: the client already knows (from `lsblk`) exactly which mountpoints are real per-disk filesystems, so filtering by correlating `df`'s `target` column against that known set is both simpler and more robust than tuning `df` flags.
- `lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size` on the real host returns (whitespace-separated, leading spaces):
  ```
    data          pve twi-aotz-- 63.09  151640866816
    root          pve -wi-ao----         91662319616
    swap          pve -wi-ao----          8589934592
    vm-100-disk-0 pve Vwi-aotz-- 54.91   34359738368
  ```
  Confirmed: `lv_attr`'s first character is `t` for a thin pool (`data`), `V` for a thin volume living inside one (`vm-100-disk-0`), and `-` for an ordinary linear LV (`root`, `swap`). Confirmed: non-thin LVs have **no `data_percent` token at all** in the output (not an empty string — the field is simply absent, so a line splits into 4 whitespace-separated tokens instead of 5). Parsing must handle both lengths.
- `pvs --noheadings -o pv_name,vg_name` returns `  /dev/sda3  pve` — confirms the physical volume device name is exactly `/dev/<partition-name>` as it appears under the disk's `lsblk` children, so correlating "which VG is on this disk" needs no dm-name string parsing (which would otherwise require reversing `pve-data-tpool` back into VG `pve` / LV `data`, an unnecessarily fragile approach this plan avoids entirely).
- Real `lsblk -J -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE` tree for `sda` confirms the shape `capacity.js` walks: `sda` → `sda1` (unmounted, no fs) / `sda2` (`/boot/efi`) / `sda3` (`LVM2_member`, no direct mountpoint) → `pve-root` (`/`), `pve-swap` (`[SWAP]`), `pve-data_tmeta`/`pve-data_tdata` (both unmounted, both fan out to the same nested `pve-data-tpool` → `pve-data` + `pve-vm--*--disk--*` — the thin pool's internal bookkeeping volumes and thin volumes; irrelevant to this plan's aggregation, which only needs the pool's own `data_percent` from `lvs`, not this nested tree).
- Computed by hand from the above for sanity: `sda`'s aggregate would be `usedBytes ≈ 25,923,919,872 (df: / + /boot/efi) + 95,670,222,874 (63.09% of the 151,640,866,816-byte thin pool) ≈ 121.6 GB` out of `totalBytes ≈ 90,699,829,248 (df) + 151,640,866,816 (pool) ≈ 242.3 GB`. This total is intentionally smaller than `sda`'s raw reported size (238.5 GiB ≈ 256.1 GB) by roughly the 8.6 GB `swap` LV plus the ~1 MB unmounted `sda1` — expected and documented, not a bug (see Global Constraints' swap-exclusion note).

## File Structure

- Modify: `deploy/proxmox-smart-helper.sh` — add 3 fixed-string `case` branches (`df`, `lvs`, `pvs`).
- Modify: `deploy/SSH_SETUP.md` — the "This key can only run `lsblk` or `smartctl`" line becomes inaccurate the moment Task 1 ships; update it in the same task.
- Modify: `src/utils/ssh/smartClient.js` — add `getDiskUsage`, `getLvmReport`, `getPvMapping`, each a thin wrapper around the existing `execCommand` plus a small tabular-output parser. No changes to any existing export.
- Modify: `src/utils/ssh/smartClient.test.js` — add coverage for the three new functions, following the existing `FakeClient` pattern.
- Create: `src/utils/disks/capacity.js` — pure function `computeDiskCapacity(disk, { dfRows, lvsRows, pvsRows })`.
- Create: `src/utils/disks/capacity.test.js`.
- Modify: `src/pages/api/disks/index.js` — fetch the three new datasets alongside the existing `lsblk` call, compute capacity per disk, merge into each entry, degrade to `null` on failure.
- Modify: `src/__tests__/pages/api/disks/index.test.js` — cover the merge and the graceful-degradation path.
- Modify: `src/components/disks/group.jsx` — render a fourth `Stat` ("Capacity") using `pretty-bytes`.
- Modify: `src/components/disks/group.test.jsx` — cover the new stat; also restore the second (`warn`-status) disk fixture the old `/disks` page test had, which the Disk Widget Relocation plan's final review flagged as lost coverage worth cheaply recovering while this file is already being touched.

---

### Task 1: Extend the SSH allowlist and client

**Files:**
- Modify: `deploy/proxmox-smart-helper.sh`
- Modify: `deploy/SSH_SETUP.md`
- Modify: `src/utils/ssh/smartClient.js`
- Modify: `src/utils/ssh/smartClient.test.js`

**Interfaces:**
- Consumes: the existing `execCommand(sshConfig, command, timeoutMs)` helper already defined in `smartClient.js` — do not duplicate it.
- Produces:
  - `export async function getDiskUsage(sshConfig)` → resolves to an array of `{ source, target, fstype, usedBytes, sizeBytes }`.
  - `export async function getLvmReport(sshConfig)` → resolves to an array of `{ lvName, vgName, lvAttr, dataPercent, lvSizeBytes }` where `dataPercent` is `null` for non-thin LVs.
  - `export async function getPvMapping(sshConfig)` → resolves to an array of `{ pvName, vgName }`.
  - All three throw on non-zero exit code, matching `listBlockDevices`'s existing convention (`Command exited with code ${code}: ${stderr}`).

The current `deploy/proxmox-smart-helper.sh` (read it first to confirm nothing has changed since this plan was written):

```sh
#!/bin/sh
# deploy/proxmox-smart-helper.sh
#
# Installed at /usr/local/bin/your-server-board-smart-helper.sh on the Proxmox
# host and bound to a dedicated SSH key via a forced `command=` entry in
# authorized_keys. That key can NEVER run anything except the two exact
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
  *)
    echo "refused: command not permitted for this key" >&2
    exit 1
    ;;
esac
```

- [ ] **Step 1: Add the three new fixed-command branches to `proxmox-smart-helper.sh`**

Insert these three `case` arms directly above the existing `*)` catch-all (order doesn't matter among fixed-string matches, but keep them grouped together and above the catch-all):

```sh
  "df -B1 --output=source,target,fstype,used,size")
    exec df -B1 --output=source,target,fstype,used,size
    ;;
  "lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size")
    exec lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size
    ;;
  "pvs --noheadings -o pv_name,vg_name")
    exec pvs --noheadings -o pv_name,vg_name
    ;;
```

Each is an exact-string match with no wildcard and no captured variable — there is nothing to validate because there is nothing the client controls. This is the same shape as the existing `lsblk` branch, not the parameterized `smartctl` branch.

- [ ] **Step 2: Update `deploy/SSH_SETUP.md`'s capability description**

Read the current file first (it may have shifted since this plan was written). Find the line:

```markdown
This key can only run `lsblk` or `smartctl -j -a <device>` — nothing else —
enforced server-side by a forced command, not just by client-side discipline.
```

Replace with:

```markdown
This key can only run `lsblk`, `smartctl -j -a <device>`, `df`, `lvs`, or
`pvs` (each a single fixed, read-only, parameterless or path-validated
command) — nothing else — enforced server-side by a forced command, not
just by client-side discipline.
```

- [ ] **Step 3: Write the failing tests for the three new client functions**

Read `src/utils/ssh/smartClient.test.js` first to confirm its current exact structure (the `FakeClient`/`FakeStream` classes, the `connectBehavior`/`lsblkBehavior`/`smartBehavior` module-level knobs, and the `afterEach` reset) — add to it rather than rewriting it. Add these command constants near the existing `LSBLK_COMMAND`/`SMARTCTL_SDA_COMMAND`:

```javascript
const DF_COMMAND = "df -B1 --output=source,target,fstype,used,size";
const LVS_COMMAND = "lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size";
const PVS_COMMAND = "pvs --noheadings -o pv_name,vg_name";
```

Add a new mutable behavior knob alongside the existing three:

```javascript
let capacityBehavior = "success"; // "success" | "nonzero" | "empty"
```

Add to `FakeClient.exec`'s command dispatch (inside the existing `setImmediate` callback, as new `if` blocks before the final "unexpected command" fallback):

```javascript
      if (command === DF_COMMAND) {
        if (capacityBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("df: failure\n"));
          stream.emit("close", 1);
        } else if (capacityBehavior === "empty") {
          stream.emit("data", Buffer.from("Filesystem Mounted on Type Used 1B-blocks\n"));
          stream.emit("close", 0);
        } else {
          stream.emit(
            "data",
            Buffer.from(
              "Filesystem            Mounted on   Type Used         1B-blocks\n" +
                "/dev/mapper/pve-root  /            ext4 25914707968  89628205056\n" +
                "/dev/sda2             /boot/efi    vfat 9211904      1071624192\n",
            ),
          );
          stream.emit("close", 0);
        }
        return;
      }

      if (command === LVS_COMMAND) {
        if (capacityBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("lvs: failure\n"));
          stream.emit("close", 1);
        } else if (capacityBehavior === "empty") {
          stream.emit("data", Buffer.from(""));
          stream.emit("close", 0);
        } else {
          stream.emit(
            "data",
            Buffer.from(
              "  data pve twi-aotz-- 63.09 151640866816\n" + "  root pve -wi-ao---- 91662319616\n",
            ),
          );
          stream.emit("close", 0);
        }
        return;
      }

      if (command === PVS_COMMAND) {
        if (capacityBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("pvs: failure\n"));
          stream.emit("close", 1);
        } else if (capacityBehavior === "empty") {
          stream.emit("data", Buffer.from(""));
          stream.emit("close", 0);
        } else {
          stream.emit("data", Buffer.from("  /dev/sda3 pve\n"));
          stream.emit("close", 0);
        }
        return;
      }
```

Add `capacityBehavior = "success";` to the existing `afterEach` reset block alongside the other three behavior resets.

Add the import for the new functions to the existing dynamic import line:

```javascript
const { getSmartData, listBlockDevices, getDiskUsage, getLvmReport, getPvMapping, SSH_COMMAND_TIMEOUT_MS } =
  await import("./smartClient");
```

Add these new test cases inside the existing `describe("smartClient", ...)` block:

```javascript
  it("fetches disk usage via the exact df command", async () => {
    const result = await getDiskUsage(sshConfig);
    expect(result).toEqual([
      { source: "/dev/mapper/pve-root", target: "/", fstype: "ext4", usedBytes: 25914707968, sizeBytes: 89628205056 },
      { source: "/dev/sda2", target: "/boot/efi", fstype: "vfat", usedBytes: 9211904, sizeBytes: 1071624192 },
    ]);
  });

  it("returns an empty array when df has nothing to report beyond the header", async () => {
    capacityBehavior = "empty";
    const result = await getDiskUsage(sshConfig);
    expect(result).toEqual([]);
  });

  it("rejects getDiskUsage when df exits non-zero", async () => {
    capacityBehavior = "nonzero";
    await expect(getDiskUsage(sshConfig)).rejects.toThrow(/exited with code 1/);
  });

  it("fetches the LVM report via the exact lvs command, with dataPercent null for non-thin LVs", async () => {
    const result = await getLvmReport(sshConfig);
    expect(result).toEqual([
      { lvName: "data", vgName: "pve", lvAttr: "twi-aotz--", dataPercent: 63.09, lvSizeBytes: 151640866816 },
      { lvName: "root", vgName: "pve", lvAttr: "-wi-ao----", dataPercent: null, lvSizeBytes: 91662319616 },
    ]);
  });

  it("returns an empty array when lvs has no output (no LVM on this host)", async () => {
    capacityBehavior = "empty";
    const result = await getLvmReport(sshConfig);
    expect(result).toEqual([]);
  });

  it("rejects getLvmReport when lvs exits non-zero", async () => {
    capacityBehavior = "nonzero";
    await expect(getLvmReport(sshConfig)).rejects.toThrow(/exited with code 1/);
  });

  it("fetches the PV-to-VG mapping via the exact pvs command", async () => {
    const result = await getPvMapping(sshConfig);
    expect(result).toEqual([{ pvName: "/dev/sda3", vgName: "pve" }]);
  });

  it("returns an empty array when pvs has no output (no LVM on this host)", async () => {
    capacityBehavior = "empty";
    const result = await getPvMapping(sshConfig);
    expect(result).toEqual([]);
  });

  it("rejects getPvMapping when pvs exits non-zero", async () => {
    capacityBehavior = "nonzero";
    await expect(getPvMapping(sshConfig)).rejects.toThrow(/exited with code 1/);
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm test src/utils/ssh/smartClient.test.js`
Expected: FAIL — `getDiskUsage`/`getLvmReport`/`getPvMapping` are not exported yet.

- [ ] **Step 5: Implement the three functions in `smartClient.js`**

Add to `src/utils/ssh/smartClient.js`, after the existing `getSmartData` export (append, don't reorder existing code):

```javascript
export async function getDiskUsage(sshConfig) {
  const { stdout, stderr, code } = await execCommand(
    sshConfig,
    "df -B1 --output=source,target,fstype,used,size",
  );
  if (code !== 0) {
    throw new Error(`Command exited with code ${code}: ${stderr}`);
  }
  // First line is the column header ("Filesystem  Mounted on  Type  Used
  // 1B-blocks"); every line after it is one whitespace-separated row. This
  // assumes no mountpoint contains a space, which holds for every mountpoint
  // this app expects to see (system partitions, LVM/LUKS-mapped storage) —
  // acceptable for a homelab dashboard, not general-purpose df parsing.
  const lines = stdout.trim().split("\n").slice(1);
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [source, target, fstype, used, size] = line.trim().split(/\s+/);
      return { source, target, fstype, usedBytes: Number(used), sizeBytes: Number(size) };
    });
}

export async function getLvmReport(sshConfig) {
  const { stdout, stderr, code } = await execCommand(
    sshConfig,
    "lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size",
  );
  if (code !== 0) {
    throw new Error(`Command exited with code ${code}: ${stderr}`);
  }
  // --noheadings means every non-blank line is a row. Non-thin LVs (plain
  // linear volumes like root/swap) have no data_percent to report at all —
  // lvs omits the token rather than printing an empty one — so a row is
  // either 5 whitespace-separated tokens (thin pool or thin volume) or 4
  // (everything else); dataPercent is null in the 4-token case.
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tokens = line.split(/\s+/);
      if (tokens.length === 5) {
        const [lvName, vgName, lvAttr, dataPercent, lvSize] = tokens;
        return { lvName, vgName, lvAttr, dataPercent: Number(dataPercent), lvSizeBytes: Number(lvSize) };
      }
      const [lvName, vgName, lvAttr, lvSize] = tokens;
      return { lvName, vgName, lvAttr, dataPercent: null, lvSizeBytes: Number(lvSize) };
    });
}

export async function getPvMapping(sshConfig) {
  const { stdout, stderr, code } = await execCommand(sshConfig, "pvs --noheadings -o pv_name,vg_name");
  if (code !== 0) {
    throw new Error(`Command exited with code ${code}: ${stderr}`);
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pvName, vgName] = line.split(/\s+/);
      return { pvName, vgName };
    });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/utils/ssh/smartClient.test.js`
Expected: PASS (all existing tests plus the 9 new ones).

- [ ] **Step 7: Commit**

```bash
git add deploy/proxmox-smart-helper.sh deploy/SSH_SETUP.md src/utils/ssh/smartClient.js src/utils/ssh/smartClient.test.js
git commit -m "feat: add df/lvs/pvs to the restricted SSH allowlist and client"
```

---

### Task 2: Pure disk-capacity aggregation function

**Files:**
- Create: `src/utils/disks/capacity.js`
- Test: `src/utils/disks/capacity.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 directly (pure function, takes already-parsed data) — but its input shapes must exactly match Task 1's return shapes: `dfRows: Array<{ source, target, fstype, usedBytes, sizeBytes }>`, `lvsRows: Array<{ lvName, vgName, lvAttr, dataPercent, lvSizeBytes }>`, `pvsRows: Array<{ pvName, vgName }>`. Also consumes one disk entry from the existing `lsblk -J` tree shape already used elsewhere in this codebase (`{ name, type, mountpoint, children: [...] }`, recursively nested).
- Produces: `export function computeDiskCapacity(disk, { dfRows, lvsRows, pvsRows })` → `{ usedBytes: number, totalBytes: number } | null`. `null` means "nothing found for this disk" (no mounted filesystem, no LVM) — Task 3 must render this as the existing "-" placeholder, not throw or crash.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/utils/disks/capacity.test.js
import { describe, expect, it } from "vitest";

import { computeDiskCapacity } from "./capacity";

describe("computeDiskCapacity", () => {
  it("aggregates a simple disk with one directly-mounted filesystem and no LVM", () => {
    const disk = {
      name: "sdc",
      type: "disk",
      mountpoint: null,
      children: [{ name: "sdc_crypt", type: "crypt", mountpoint: "/mnt/storage" }],
    };
    const dfRows = [
      { source: "/dev/mapper/sdc_crypt", target: "/mnt/storage", fstype: "ext4", usedBytes: 400000000000, sizeBytes: 2000000000000 },
      // Unrelated mountpoint on a different disk — must be ignored.
      { source: "/dev/sda2", target: "/boot/efi", fstype: "vfat", usedBytes: 10000000, sizeBytes: 1000000000 },
    ];

    const result = computeDiskCapacity(disk, { dfRows, lvsRows: [], pvsRows: [] });

    expect(result).toEqual({ usedBytes: 400000000000, totalBytes: 2000000000000 });
  });

  it("aggregates an LVM disk by combining df on its direct mounts with its thin pool's data_percent", () => {
    const disk = {
      name: "sda",
      type: "disk",
      mountpoint: null,
      children: [
        { name: "sda1", type: "part", mountpoint: null },
        { name: "sda2", type: "part", mountpoint: "/boot/efi" },
        {
          name: "sda3",
          type: "part",
          mountpoint: null,
          children: [
            { name: "pve-root", type: "lvm", mountpoint: "/" },
            { name: "pve-swap", type: "lvm", mountpoint: "[SWAP]" },
          ],
        },
      ],
    };
    const dfRows = [
      { source: "/dev/sda2", target: "/boot/efi", fstype: "vfat", usedBytes: 10000000, sizeBytes: 1000000000 },
      { source: "/dev/mapper/pve-root", target: "/", fstype: "ext4", usedBytes: 25000000000, sizeBytes: 90000000000 },
      // Unrelated mountpoint on a different disk — must be ignored.
      { source: "/dev/mapper/sdc_crypt", target: "/mnt/storage", fstype: "ext4", usedBytes: 1, sizeBytes: 2 },
    ];
    const pvsRows = [{ pvName: "/dev/sda3", vgName: "pve" }];
    const lvsRows = [
      { lvName: "data", vgName: "pve", lvAttr: "twi-aotz--", dataPercent: 50, lvSizeBytes: 100000000000 },
      // Non-pool LVs in the same VG must NOT be added on top of the pool figure.
      { lvName: "root", vgName: "pve", lvAttr: "-wi-ao----", dataPercent: null, lvSizeBytes: 90000000000 },
      { lvName: "swap", vgName: "pve", lvAttr: "-wi-ao----", dataPercent: null, lvSizeBytes: 8000000000 },
      // A thin pool in an unrelated VG must be ignored.
      { lvName: "otherdata", vgName: "othervg", lvAttr: "twi-aotz--", dataPercent: 90, lvSizeBytes: 500000000000 },
    ];

    const result = computeDiskCapacity(disk, { dfRows, lvsRows, pvsRows });

    // dfUsed = 10_000_000 + 25_000_000_000 = 25_010_000_000
    // dfSize = 1_000_000_000 + 90_000_000_000 = 91_000_000_000
    // thinUsed = 50% of 100_000_000_000 = 50_000_000_000
    // thinSize = 100_000_000_000
    expect(result).toEqual({ usedBytes: 75010000000, totalBytes: 191000000000 });
  });

  it("excludes [SWAP] mountpoints from the aggregation even if df somehow reported one", () => {
    const disk = {
      name: "sda",
      type: "disk",
      mountpoint: null,
      children: [{ name: "sda1", type: "lvm", mountpoint: "[SWAP]" }],
    };
    const dfRows = [{ source: "/dev/mapper/pve-swap", target: "[SWAP]", fstype: "swap", usedBytes: 999, sizeBytes: 999 }];

    const result = computeDiskCapacity(disk, { dfRows, lvsRows: [], pvsRows: [] });

    expect(result).toBeNull();
  });

  it("returns null when the disk has no mounted filesystem and no LVM", () => {
    const disk = { name: "sdz", type: "disk", mountpoint: null, children: [] };

    const result = computeDiskCapacity(disk, { dfRows: [], lvsRows: [], pvsRows: [] });

    expect(result).toBeNull();
  });

  it("returns null when the disk has children but none of them are mounted or LVM PVs", () => {
    const disk = {
      name: "sdz",
      type: "disk",
      mountpoint: null,
      children: [{ name: "sdz1", type: "part", mountpoint: null }],
    };

    const result = computeDiskCapacity(disk, { dfRows: [], lvsRows: [], pvsRows: [] });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utils/disks/capacity.test.js`
Expected: FAIL — `Cannot find module './capacity'`.

- [ ] **Step 3: Write the implementation**

```javascript
// src/utils/disks/capacity.js

// Recursively collects every real (non-swap) mountpoint under a lsblk device
// node, at any depth. "[SWAP]" is lsblk's literal mountpoint value for an
// active swap volume — swap is deliberately excluded from capacity reporting
// (see Global Constraints in the plan this file was built from: lvs reports
// no data_percent for it, and it isn't "data" in the sense this feature
// communicates).
function collectMountpoints(node, acc) {
  if (node.mountpoint && node.mountpoint !== "[SWAP]") {
    acc.push(node.mountpoint);
  }
  for (const child of node.children ?? []) {
    collectMountpoints(child, acc);
  }
}

// Recursively collects the names of every partition-level node under a
// lsblk device node. Only partitions (lsblk type "part") can be LVM
// physical volumes — pvs reports PVs as "/dev/<partition-name>", so this is
// the full set of candidate device names to check against the PV mapping.
function collectPartitionNames(node, acc) {
  if (node.type === "part") {
    acc.push(node.name);
  }
  for (const child of node.children ?? []) {
    collectPartitionNames(child, acc);
  }
}

export function computeDiskCapacity(disk, { dfRows, lvsRows, pvsRows }) {
  const mountpoints = [];
  collectMountpoints(disk, mountpoints);

  const partitionNames = [];
  collectPartitionNames(disk, partitionNames);

  const vgNames = new Set(
    pvsRows
      .filter((pv) => partitionNames.includes(pv.pvName.replace(/^\/dev\//, "")))
      .map((pv) => pv.vgName),
  );

  const relevantDf = dfRows.filter((row) => mountpoints.includes(row.target));
  const dfUsed = relevantDf.reduce((sum, row) => sum + row.usedBytes, 0);
  const dfSize = relevantDf.reduce((sum, row) => sum + row.sizeBytes, 0);

  // Only the thin pool's own row carries the aggregate data_percent for
  // everything provisioned inside it — summing the pool's sibling thin
  // volumes (vm-*-disk-*, lv_attr starting with "V") on top would double-count.
  const thinPools = lvsRows.filter((lv) => vgNames.has(lv.vgName) && lv.lvAttr?.[0] === "t");
  const thinUsed = thinPools.reduce((sum, lv) => sum + Math.round((lv.dataPercent / 100) * lv.lvSizeBytes), 0);
  const thinSize = thinPools.reduce((sum, lv) => sum + lv.lvSizeBytes, 0);

  const usedBytes = dfUsed + thinUsed;
  const totalBytes = dfSize + thinSize;

  if (totalBytes === 0) {
    return null;
  }

  return { usedBytes, totalBytes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utils/disks/capacity.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/disks/capacity.js src/utils/disks/capacity.test.js
git commit -m "feat: add pure disk-capacity aggregation function"
```

---

### Task 3: Surface capacity in the API and the dashboard UI

**Files:**
- Modify: `src/pages/api/disks/index.js`
- Modify: `src/__tests__/pages/api/disks/index.test.js`
- Modify: `src/components/disks/group.jsx`
- Modify: `src/components/disks/group.test.jsx`

**Interfaces:**
- Consumes: `getDiskUsage`, `getLvmReport`, `getPvMapping` from `src/utils/ssh/smartClient.js` (Task 1); `computeDiskCapacity` from `src/utils/disks/capacity.js` (Task 2).
- Produces: each object in `/api/disks`'s response array gains two new fields: `usedBytes: number | null`, `totalBytes: number | null`. `DisksGroup`'s `DiskCard` renders a fourth `Stat` from them.

The current `src/pages/api/disks/index.js` (read it first to confirm nothing has changed since this plan was written):

```javascript
import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { computeDiskHealth } from "utils/disks/health";
import { getSmartData, listBlockDevices } from "utils/ssh/smartClient";

const logger = createLogger("disksApi");

const QUERYABLE_DEVICE_NAME = /^(sd[a-z]|nvme\d+n\d+)$/;

const EMPTY_HEALTH = {
  protocol: null,
  temperature: null,
  smartPassed: null,
  reallocatedSectors: null,
  wearPercentage: null,
  mediaErrors: null,
};

async function buildDiskEntry(sshConfig, device) {
  const base = { name: device.name, device: `/dev/${device.name}`, model: device.model, size: device.size };

  try {
    const smartData = await getSmartData(sshConfig, base.device);
    const health = computeDiskHealth(smartData);
    return {
      ...base,
      protocol: smartData?.device?.protocol ?? null,
      temperature: health.temperature,
      smartPassed: health.smartPassed,
      reallocatedSectors: health.reallocatedSectors,
      wearPercentage: health.wearPercentage,
      mediaErrors: health.mediaErrors,
      status: health.status,
      error: null,
    };
  } catch (error) {
    logger.error("SMART query failed for %s:", base.device, error);
    return {
      ...base,
      ...EMPTY_HEALTH,
      status: null,
      error: "SMART query failed",
    };
  }
}

export default async function handler(req, res) {
  const sshConfig = getSmartConfig();

  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let blockDevices;
  try {
    ({ blockdevices: blockDevices } = await listBlockDevices(sshConfig));
  } catch (error) {
    logger.error("Failed to enumerate block devices:", error);
    return res.status(500).json({ error: "Failed to enumerate block devices" });
  }

  const physicalDisks = (blockDevices ?? [])
    .filter((device) => device.type === "disk")
    .filter((device) => QUERYABLE_DEVICE_NAME.test(device.name));
  const entries = await Promise.all(physicalDisks.map((device) => buildDiskEntry(sshConfig, device)));

  return res.status(200).json(entries);
}
```

- [ ] **Step 1: Write the failing API route tests**

Read `src/__tests__/pages/api/disks/index.test.js` first to confirm its current exact structure. Add to the `vi.hoisted`/`vi.mock` blocks:

```javascript
const { getSmartConfig, listBlockDevices, getSmartData, getDiskUsage, getLvmReport, getPvMapping, logger } =
  vi.hoisted(() => ({
    getSmartConfig: vi.fn(),
    listBlockDevices: vi.fn(),
    getSmartData: vi.fn(),
    getDiskUsage: vi.fn(),
    getLvmReport: vi.fn(),
    getPvMapping: vi.fn(),
    logger: { error: vi.fn() },
  }));

vi.mock("utils/ssh/smartClient", () => ({
  listBlockDevices,
  getSmartData,
  getDiskUsage,
  getLvmReport,
  getPvMapping,
}));
```

(This replaces the existing narrower `vi.hoisted`/`vi.mock("utils/ssh/smartClient", ...)` blocks — keep `getSmartConfig`'s own mock and the `utils/config/proxmox`/`utils/logger` mocks as they are today.)

In every existing test, add default resolved values for the three new mocks so pre-existing tests keep passing unchanged in behavior (add this line inside the existing `beforeEach`, after `vi.clearAllMocks()`):

```javascript
    getDiskUsage.mockResolvedValue([]);
    getLvmReport.mockResolvedValue([]);
    getPvMapping.mockResolvedValue([]);
```

With those defaults, the two existing tests that assert an exact `res.body` (`"filters lsblk output..."` and the error-path tests) need `usedBytes: null, totalBytes: null` added to their expected objects — `computeDiskCapacity` returns `null` for a disk with no matching df/lvs/pvs data, which this task's route code must render as `usedBytes: null, totalBytes: null` (see Step 3).

Add these new test cases inside the existing `describe("pages/api/disks", ...)` block:

```javascript
  it("merges real capacity data into each disk entry", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    listBlockDevices.mockResolvedValue({
      blockdevices: [
        {
          name: "sdc",
          size: "1.9T",
          type: "disk",
          model: "Vi3000",
          children: [{ name: "sdc_crypt", type: "crypt", mountpoint: "/mnt/storage" }],
        },
      ],
    });
    getSmartData.mockResolvedValue(ataSmart);
    getDiskUsage.mockResolvedValue([
      { source: "/dev/mapper/sdc_crypt", target: "/mnt/storage", fstype: "ext4", usedBytes: 400000000000, sizeBytes: 2000000000000 },
    ]);
    getLvmReport.mockResolvedValue([]);
    getPvMapping.mockResolvedValue([]);

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body[0]).toMatchObject({ name: "sdc", usedBytes: 400000000000, totalBytes: 2000000000000 });
  });

  it("returns usedBytes/totalBytes null for every disk, without failing the request, when the capacity SSH calls fail", async () => {
    getSmartConfig.mockReturnValue(sshConfig);
    listBlockDevices.mockResolvedValue({
      blockdevices: [{ name: "sda", size: "238.5G", type: "disk", model: "A" }],
    });
    getSmartData.mockResolvedValue(ataSmart);
    // Simulates the real operational sequencing risk this plan calls out: the
    // app was redeployed with the new client code, but proxmox-smart-helper.sh
    // on the host hasn't been re-copied yet, so the host refuses the new commands.
    getDiskUsage.mockRejectedValue(new Error("refused: command not permitted for this key"));
    getLvmReport.mockRejectedValue(new Error("refused: command not permitted for this key"));
    getPvMapping.mockRejectedValue(new Error("refused: command not permitted for this key"));

    const req = { query: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body[0]).toMatchObject({ name: "sda", status: "ok", usedBytes: null, totalBytes: null });
    // The capacity failure must not contaminate the unrelated SMART error message,
    // and must not leak raw SSH error detail into the public response.
    expect(JSON.stringify(res.body)).not.toContain("refused:");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/__tests__/pages/api/disks/index.test.js`
Expected: FAIL — `usedBytes`/`totalBytes` are `undefined` in the actual response, mocks for the three new functions are unused.

- [ ] **Step 3: Update `src/pages/api/disks/index.js`**

```javascript
import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { computeDiskCapacity } from "utils/disks/capacity";
import { computeDiskHealth } from "utils/disks/health";
import { getDiskUsage, getLvmReport, getPvMapping, getSmartData, listBlockDevices } from "utils/ssh/smartClient";

const logger = createLogger("disksApi");

const QUERYABLE_DEVICE_NAME = /^(sd[a-z]|nvme\d+n\d+)$/;

const EMPTY_HEALTH = {
  protocol: null,
  temperature: null,
  smartPassed: null,
  reallocatedSectors: null,
  wearPercentage: null,
  mediaErrors: null,
};

async function buildDiskEntry(sshConfig, device, capacityData) {
  const base = { name: device.name, device: `/dev/${device.name}`, model: device.model, size: device.size };
  const capacity = capacityData ? computeDiskCapacity(device, capacityData) : null;
  const capacityFields = { usedBytes: capacity?.usedBytes ?? null, totalBytes: capacity?.totalBytes ?? null };

  try {
    const smartData = await getSmartData(sshConfig, base.device);
    const health = computeDiskHealth(smartData);
    return {
      ...base,
      ...capacityFields,
      protocol: smartData?.device?.protocol ?? null,
      temperature: health.temperature,
      smartPassed: health.smartPassed,
      reallocatedSectors: health.reallocatedSectors,
      wearPercentage: health.wearPercentage,
      mediaErrors: health.mediaErrors,
      status: health.status,
      error: null,
    };
  } catch (error) {
    logger.error("SMART query failed for %s:", base.device, error);
    return {
      ...base,
      ...capacityFields,
      ...EMPTY_HEALTH,
      status: null,
      error: "SMART query failed",
    };
  }
}

// Capacity is an enrichment (see the plan's Global Constraints): if any of
// the three new SSH calls fail — including the real deploy-ordering scenario
// where the app ships before the updated proxmox-smart-helper.sh has been
// re-copied to the host — every disk still returns its existing SMART data
// with usedBytes/totalBytes: null, never a 500 for the whole route.
async function fetchCapacityData(sshConfig) {
  try {
    const [dfRows, lvsRows, pvsRows] = await Promise.all([
      getDiskUsage(sshConfig),
      getLvmReport(sshConfig),
      getPvMapping(sshConfig),
    ]);
    return { dfRows, lvsRows, pvsRows };
  } catch (error) {
    logger.error("Failed to fetch disk capacity data:", error);
    return null;
  }
}

export default async function handler(req, res) {
  const sshConfig = getSmartConfig();

  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let blockDevices;
  try {
    ({ blockdevices: blockDevices } = await listBlockDevices(sshConfig));
  } catch (error) {
    logger.error("Failed to enumerate block devices:", error);
    return res.status(500).json({ error: "Failed to enumerate block devices" });
  }

  const capacityData = await fetchCapacityData(sshConfig);

  const physicalDisks = (blockDevices ?? [])
    .filter((device) => device.type === "disk")
    .filter((device) => QUERYABLE_DEVICE_NAME.test(device.name));
  const entries = await Promise.all(physicalDisks.map((device) => buildDiskEntry(sshConfig, device, capacityData)));

  return res.status(200).json(entries);
}
```

- [ ] **Step 4: Run the API route tests to verify they pass**

Run: `pnpm test src/__tests__/pages/api/disks/index.test.js`
Expected: PASS (all existing tests, with the `usedBytes: null, totalBytes: null` additions from Step 1, plus the 2 new tests).

- [ ] **Step 5: Write the failing component test additions**

Read `src/components/disks/group.test.jsx` first to confirm its current exact structure. Update the first test's mocked disk fixture to include `usedBytes: 25914707968, totalBytes: 89628205056` (real-shaped numbers, matching the plan's verified `df` figures for `/`), and add an assertion for the new stat. Also add back a second disk in that same test with `warn` status, recovering the coverage the pre-relocation `/disks` page test had (per this plan's File Structure note) — the simplest way to do both in one place is to replace the whole first test:

```javascript
  it("renders a heading and a card per disk with the correct status color", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            name: "sda",
            device: "/dev/sda",
            model: "MTFDDAK256TBN-1AR1ZABHA",
            size: "238.5G",
            protocol: "ATA",
            temperature: 40,
            smartPassed: true,
            reallocatedSectors: 0,
            wearPercentage: null,
            mediaErrors: null,
            usedBytes: 25914707968,
            totalBytes: 89628205056,
            status: "ok",
            error: null,
          },
          {
            name: "sdc",
            device: "/dev/sdc",
            model: "Vi3000",
            size: "1.9T",
            protocol: "NVMe",
            temperature: 91,
            smartPassed: true,
            reallocatedSectors: null,
            wearPercentage: 12,
            mediaErrors: 0,
            usedBytes: null,
            totalBytes: null,
            status: "warn",
            error: null,
          },
        ]),
    });

    renderWithSWR(<DisksGroup />);

    expect(screen.getByText("Disks")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("sda")).toBeInTheDocument());
    const sdaCard = screen.getByText("sda").closest('[data-testid="disk-card"]');
    expect(sdaCard).toHaveAttribute("data-status", "ok");
    expect(sdaCard).toHaveTextContent("25.9 GB / 89.6 GB");

    const sdcCard = screen.getByText("sdc").closest('[data-testid="disk-card"]');
    expect(sdcCard).toHaveAttribute("data-status", "warn");
    expect(sdcCard).toHaveTextContent("-");
  });
```

(`25.9 GB / 89.6 GB` is `pretty-bytes@7.1.1`'s actual, verified default formatting for `25914707968` / `89628205056` — confirmed directly via `node --input-type=module -e "import prettyBytes from 'pretty-bytes'; console.log(prettyBytes(25914707968))"` while writing this plan, not guessed. The `sdc` card asserting `"-"` confirms the existing `Stat` component's null-placeholder behavior is reused as-is for a disk where capacity is unavailable, rather than this task inventing a new empty state.)

- [ ] **Step 6: Run the component test to verify it fails**

Run: `pnpm test src/components/disks/group.test.jsx`
Expected: FAIL — the new stat isn't rendered yet, so `toHaveTextContent("25.9 GB / 89.6 GB")` fails with no matching element/text.

- [ ] **Step 7: Update `src/components/disks/group.jsx`**

Add the import (alphabetically among existing imports):

```javascript
import prettyBytes from "pretty-bytes";
```

Add a capacity formatting helper near the top of the file, alongside the existing module-level constants:

```javascript
function formatCapacity(usedBytes, totalBytes) {
  if (usedBytes == null || totalBytes == null) return null;
  return `${prettyBytes(usedBytes)} / ${prettyBytes(totalBytes)}`;
}
```

In `DiskCard`, add a fourth `Stat` to the existing `<div className="flex flex-row">` (after the existing three):

```jsx
      <div className="flex flex-row">
        <Stat value={disk.temperature != null ? `${disk.temperature}°C` : null} label="Temp" />
        <Stat value={disk.smartPassed == null ? null : disk.smartPassed ? "PASSED" : "FAILED"} label="SMART" />
        <Stat value={wearOrReallocated} label={disk.wearPercentage != null ? "Wear" : "Realloc"} />
        <Stat value={formatCapacity(disk.usedBytes, disk.totalBytes)} label="Capacity" />
      </div>
```

- [ ] **Step 8: Run the component test to verify it passes**

Run: `pnpm test src/components/disks/group.test.jsx`
Expected: PASS (both cases in the updated first test, plus the two unmodified existing tests).

- [ ] **Step 9: Run the full test suite and lint**

Run: `pnpm test`
Expected: PASS, no regressions.

Run: `pnpm lint`
Expected: clean.

Run: `npx prettier --check src/pages/api/disks/index.js src/components/disks/group.jsx src/utils/disks/capacity.js src/utils/ssh/smartClient.js`
Expected: all pass (the Disk Widget Relocation plan's final review found a Prettier violation that `pnpm lint` alone didn't catch — check explicitly here rather than relying on `pnpm lint` again).

- [ ] **Step 10: Commit**

```bash
git add src/pages/api/disks/index.js src/__tests__/pages/api/disks/index.test.js src/components/disks/group.jsx src/components/disks/group.test.jsx
git commit -m "feat: surface real disk capacity in the API and dashboard"
```

---

### Task 4: Live verification

**Files:** none (verification only)

- [ ] **Step 1: Re-copy the updated forced-command script to the Proxmox host**

```bash
scp deploy/proxmox-smart-helper.sh proxmox:/usr/local/bin/your-server-board-smart-helper.sh
ssh proxmox 'chmod 755 /usr/local/bin/your-server-board-smart-helper.sh'
```

- [ ] **Step 2: Verify each new command directly over the restricted key**

Using the same private key path the app itself uses (`config/ssh/id_smart` by default — confirm the actual path from `config/proxmox.yaml`'s `smart:` block before running):

```bash
ssh -i config/ssh/id_smart -o BatchMode=yes proxmox "df -B1 --output=source,target,fstype,used,size"
ssh -i config/ssh/id_smart -o BatchMode=yes proxmox "lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size"
ssh -i config/ssh/id_smart -o BatchMode=yes proxmox "pvs --noheadings -o pv_name,vg_name"
```

Expected: each returns real data matching the shapes captured in this plan's "Real Data Verified" section (exact numbers will differ slightly from planning time — that's expected, disk usage changes). Also confirm the key still refuses anything else:

```bash
ssh -i config/ssh/id_smart -o BatchMode=yes proxmox "rm -rf /"
```

Expected: `refused: command not permitted for this key` on stderr, non-zero exit — the new branches must not have loosened the catch-all.

- [ ] **Step 3: Deploy the app**

```bash
git push origin dev
ssh lxc200 'cd /opt/stacks/your-server-board && git pull origin dev && docker compose up -d --build'
```

- [ ] **Step 4: Verify the dashboard**

```bash
curl -s http://10.0.1.104:3050/api/disks | head -c 2000
```

Expected: the JSON response includes non-null `usedBytes`/`totalBytes` for `sda` and `sdc`, roughly matching this plan's hand-computed sanity check (`sda` around 121–122 GB used of ~242 GB; `sdc` should closely track its `df` figures directly since it has no LVM involved).

Open `http://10.0.1.104:3050/` in a browser if available. Expected: each disk card in the Disks section shows a fourth "Capacity" stat pill with real used/total figures, laid out without visibly overflowing or wrapping awkwardly next to the existing three stats (Temp/SMART/Wear) — if it looks visually cramped, note it for a quick follow-up, this plan doesn't block on pixel-perfect four-stat layout.

- [ ] **Step 5: Confirm nothing else broke**

Confirm SMART status/temperature/wear figures on both disk cards are still correct (unchanged from before this plan), and that the rest of the dashboard (VM/LXC widget, other groups) still renders normally.
