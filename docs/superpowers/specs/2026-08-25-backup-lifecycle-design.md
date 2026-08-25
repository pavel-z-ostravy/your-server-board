# Backup Lifecycle Management — Design

**Date:** 2026-08-25
**Status:** Approved for planning

## Problem

`progress.md` has tracked "Backup lifecycle management for Proxmox VMs/CTs (list/run/download/delete, retention)" as a follow-up since Foundation. Nothing exists for it yet: every Proxmox integration built so far (VM/CT stats, host detail, SMART) only ever reads from the Proxmox API or a read-only restricted-SSH channel. This is the first feature that needs to mutate real state on the Proxmox host (trigger a backup job, delete a backup file) and the first that needs to move a large file (a backup archive can be many GB) through the dashboard.

## Goals

- A dedicated `/backups` page (same "own page, not a dashboard widget" pattern as `/disks` and `/widgets`) listing every VM/CT and, per guest, its existing backups: date, size, storage, and that storage's configured retention (`prune-backups`).
- **List** — enumerate every storage on the guest's node with `backup` content enabled, and every backup file on each that belongs to that `vmid`.
- **Run** — trigger an ad-hoc backup of a chosen VM/CT to a chosen storage right now (not tied to an existing scheduled vzdump job), with progress shown via task polling.
- **Delete** — remove a specific backup file, gated by a type-to-confirm dialog (retype the VM/CT name) — stricter than the lightweight inline confirm the widget-uninstall feature uses, because losing a backup is a more serious mistake than losing a widget's config.
- **Download** — stream a backup file's raw bytes to the browser without buffering the whole file in server memory.
- All four actions protected by nothing beyond the dashboard's existing auth (see the widget-install hardening work) — no extra install-style disclaimer/checkbox layer.

## Non-goals

- **No job-schedule management.** "Run" always means an immediate ad-hoc backup of one guest to a chosen storage, not creating/editing/triggering an existing `cluster/backup` vzdump job. Viewing/editing scheduled jobs is a separate future piece if ever wanted.
- **No retention editing.** Retention (`prune-backups`) is shown as read-only information per storage. Changing it stays a Proxmox-UI task.
- **No restore.** Only list/run/download/delete. Restoring a VM/CT from a backup is a separate, much higher-blast-radius feature (arguably more of a "quick VM/CT actions" plan concern) and isn't in scope here.
- **No cross-storage or cross-node backup copying.** A backup lives on the storage it was made on; this feature doesn't move backups between storages.
- **No changes to `smartClient.js`'s existing exported functions or their behavior** — only a new, separate streaming helper is added alongside them.

## Architecture

### PVE API write client: `src/utils/proxmox/backups.js` (new, pure functions)

`src/pages/api/proxmox/vms/index.js` already has a `pveGet(pveConfig, path)` helper (GET-only, buffers the JSON body via `httpProxy`). This plan adds sibling `pvePost`/`pveDelete` helpers next to it (or promotes all three into a small shared module during implementation planning — exact home decided then) using the same `httpProxy` call `agentExec.js` already makes for its own POST to the guest-agent exec endpoint, just with `method: "POST"`/`"DELETE"` and no new dependency.

```js
// Returns [{ storage, prunePolicy }] for every storage on `node` with
// "backup" in its content types (GET /nodes/{node}/storage).
export async function listBackupStorages(pveConfig, node) { ... }

// Returns [{ volid, size, ctime, notes, storage }] for every backup file
// belonging to `vmid` across every storage from listBackupStorages(), each
// entry tagged with that storage's prunePolicy. A single storage failing
// (offline, permission error) must not fail the whole call - matches the
// existing Promise.allSettled pattern in vms/index.js's enrichLxc/enrichQemu.
export async function listBackupsForVm(pveConfig, node, vmid) { ... }

// POST /nodes/{node}/vzdump { vmid, storage, mode: "snapshot", compress: "zstd" }
// Returns the task's UPID string.
export async function startBackup(pveConfig, node, vmid, storage) { ... }

// GET /nodes/{node}/tasks/{upid}/status - one poll, caller re-invokes until
// status !== "running".
export async function pollBackupTask(pveConfig, node, upid) { ... }

// DELETE /nodes/{node}/storage/{storage}/content/{volid}
export async function deleteBackup(pveConfig, node, storage, volid) { ... }
```

### SSH streaming client: `src/utils/ssh/backupClient.js` (new)

Proxmox's REST API has no endpoint that returns a backup file's raw bytes (confirmed directly with Proxmox staff on their support forum — the API can trigger backups but not download them; real downloads go through SFTP/SCP or reading the file directly on the host). `smartClient.js`'s `execCommand` fully buffers stdout into a string with a 15s timeout, which is right for short command output but wrong for a multi-GB file. This plan adds one new function, not a change to the existing one:

```js
// Runs the new forced command over a fresh SSH connection and resolves with
// the live ssh2 stream itself (not buffered) so the API route can pipe it
// straight into the HTTP response as bytes arrive. No fixed short timeout -
// the connection stays open for as long as the client keeps reading: it
// closes when the stream ends, errors, or the HTTP client disconnects
// (aborted download), whichever comes first.
export function streamBackupFile(sshConfig, node, storage, volid) { ... }
```

### Forced-command extension: `deploy/proxmox-smart-helper.sh`

One new whitelisted subcommand added to the existing forced-command script (same script, same key, same `deploy/SSH_SETUP.md` re-copy step already documented for upgrades) — something like `cat-backup <storage> <volid>`. The script resolves `<storage>`/`<volid>` to an actual filesystem path itself (via `pvesm path <storage>:<volid>` or equivalent, not by trusting a client-supplied path string directly) and validates the resolved path stays under that storage's own directory before `cat`-ing it — the same "parameterized, path-validated, single fixed shape" discipline `deploy/SSH_SETUP.md` already documents for `smartctl -j -a <device>`. No general file-read capability is added.

### New API routes: `src/pages/api/proxmox/backups/`

- `GET /list?node=&vmid=` → `listBackupsForVm`, same node/vmid validation regexes `vm-detail/index.js` already uses.
- `POST /run { node, vmid, storage }` → `startBackup`, returns `{ upid }`.
- `GET /status/[upid]?node=` → `pollBackupTask`, returns `{ status, exitstatus }`.
- `DELETE /[volid]?node=&storage=` → `deleteBackup`.
- `GET /download/[volid]?node=&storage=` → validates params, calls `streamBackupFile`, pipes the returned stream into `res` with `Content-Disposition: attachment` and (when the file size is already known from the earlier list call) `Content-Length`. A failure before any bytes are sent returns a JSON error; a failure mid-stream ends the response and logs server-side (the client just sees a truncated download).

### Frontend

- `src/pages/backups.js` — new page, linked from the hamburger menu next to `/widgets`.
- `src/components/backups/vm-list.jsx` — reuses the existing `GET /api/proxmox/vms` route for the guest list; each entry expands into:
- `src/components/backups/backup-list.jsx` — table of backups (date/size/storage/retention) with Download (plain `<a href="/api/proxmox/backups/download/...">`, no JS fetch/blob buffering) and Delete per row, plus a "Back up now" action.
- `src/components/backups/run-backup-dialog.jsx` — storage picker, then polls `/status/[upid]` (~2s interval, no new polling library) until done, shows the result inline.
- `src/components/backups/delete-confirm-dialog.jsx` — the guest's name must be retyped exactly before the Delete button unlocks.

### Required Proxmox privileges

The project's own README already flags that the configured PVE API token has full `root@pam` privileges and recommends scoping it down before exposing the dashboard publicly. This plan documents the minimum privileges this feature actually needs, for anyone building that scoped role: `VM.Backup` (trigger vzdump), `Datastore.AllocateSpace` and `Datastore.Audit` (list/delete storage content). Documented alongside the existing token-scoping note in the README/`deploy/SSH_SETUP.md` — not enforced by the app itself.

## Error Handling

- Every PVE call follows the existing `pveGet`-style contract: non-2xx status throws, caught by the route handler and turned into a `500 { error }` (or the specific validation `400`s for bad params, matching `vm-detail/index.js`).
- `listBackupsForVm` uses `Promise.allSettled` across storages so one broken/offline storage doesn't blank the whole guest's backup list.
- `startBackup` failures (e.g. another backup already running for that guest) surface inline in `run-backup-dialog.jsx`, not as a global toast — the user is mid-action and needs the message next to the button they just pressed.
- Download errors before streaming starts are a normal JSON error; errors after streaming starts can't change the HTTP status anymore (headers already sent) — logged server-side, and the browser shows an incomplete-download failure the normal way.

## Testing

- `src/utils/proxmox/backups.js` — unit tests mocking `httpProxy` (same pattern as `vms/index.test.js`): list/run/poll/delete happy paths, one-storage-fails-others-succeed for list, non-2xx and `exitstatus !== "OK"` failure paths.
- `src/utils/ssh/backupClient.js` — unit tests mocking `ssh2`'s `Client` (same pattern as `smartClient.test.js`): confirms the stream is returned unbuffered, connection/exec error paths, and that storage/volid values are passed through as separate command arguments (not concatenated into a shell string).
- New API routes under `src/__tests__/pages/api/proxmox/backups/` — param validation (reusing the existing node/vmid/volid regex patterns), status codes, download route's response headers.
- Frontend component tests for `vm-list`/`backup-list`/`run-backup-dialog`/`delete-confirm-dialog`, including the delete dialog's button staying disabled until the retyped name matches exactly.
- Manual, live-infra verification against the real Proxmox host before calling this plan done (same expectation Disks & SMART set): list real backups, run one real ad-hoc backup to completion, download it, delete it.

## Open Items for Implementation Planning

- Exact shared location for `pveGet`/`pvePost`/`pveDelete` — promote out of `vms/index.js` into a shared module now, or keep the duplication a little longer and factor it later (there's already a noted "some internal loop duplication" rough edge elsewhere in this codebase from a prior plan; worth deciding consistently).
- Exact forced-command script argument shape for `cat-backup` and how it resolves `<storage>:<volid>` to a real path (`pvesm path` output format needs confirming against a real host during implementation, not assumed here).
- Whether `Content-Length` is reliably knowable up front for the download response (depends on whether the list call's reported `size` field is trustworthy/current at download time) or should be omitted.
