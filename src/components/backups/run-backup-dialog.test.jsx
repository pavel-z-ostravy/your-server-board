// src/components/backups/run-backup-dialog.test.jsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RunBackupDialog from "./run-backup-dialog";

// Each test reuses the same node/vmid, so without a per-test SWR cache the
// storages fetch from one test's SWR cache would bleed into the next (SWR's
// default cache is a module-level singleton). Isolate it here per SWR's own
// documented pattern for resetting the cache between test cases:
// https://swr.vercel.app/docs/advanced/cache#reset-cache-between-test-cases
const renderDialog = (props) =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <RunBackupDialog {...props} />
    </SWRConfig>,
  );

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

    renderDialog({ open: true, node: "proxmox", vmid: "100", onClose: vi.fn(), onDone: vi.fn() });

    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();

    await waitFor(() => expect(screen.getByRole("option", { name: "local" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } });

    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("starts a backup, polls status, and calls onDone when it completes successfully", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ storages: [{ storage: "local", prunePolicy: null }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ upid: "UPID:proxmox:...:" }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "running", exitstatus: null }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "stopped", exitstatus: "OK" }) });

    const onDone = vi.fn();
    renderDialog({ open: true, node: "proxmox", vmid: "100", onClose: vi.fn(), onDone });

    await waitFor(() => expect(screen.getByRole("option", { name: "local" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByText("Backup running...")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Backup completed.")).toBeInTheDocument(), { timeout: 6000 });
    expect(onDone).toHaveBeenCalled();
  });

  it("does not restart polling after completion even if onDone's identity changes", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ storages: [{ storage: "local", prunePolicy: null }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ upid: "UPID:proxmox:00001234:00005678:6501234A:vzdump:100:root@pam!ysb:" }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "stopped", exitstatus: "OK" }) });

    const onClose = vi.fn();
    const { rerender } = renderDialog({ open: true, node: "proxmox", vmid: "100", onClose, onDone: vi.fn() });

    await waitFor(() => expect(screen.getByRole("option", { name: "local" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByText("Backup completed.")).toBeInTheDocument(), { timeout: 6000 });

    const callsAfterCompletion = global.fetch.mock.calls.length;

    // Simulate the parent re-rendering with a brand new onDone identity (as
    // BackupList does after mutate() runs) - this used to restart the poll
    // interval because onDone was in the effect's dependency array with no
    // guard on `result` already being set.
    rerender(
      <SWRConfig value={{ provider: () => new Map() }}>
        <RunBackupDialog open node="proxmox" vmid="100" onClose={onClose} onDone={() => {}} />
      </SWRConfig>,
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(global.fetch.mock.calls.length).toBe(callsAfterCompletion);
  }, 10000);

  it("keeps polling through a non-2xx or errored status response instead of treating it as finished", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ storages: [{ storage: "local", prunePolicy: null }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ upid: "UPID:proxmox:00001234:00005678:6501234A:vzdump:100:root@pam!ysb:" }),
      })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Unauthorized" }) })
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "stopped", exitstatus: "OK" }) });

    const onDone = vi.fn();
    renderDialog({ open: true, node: "proxmox", vmid: "100", onClose: vi.fn(), onDone });

    await waitFor(() => expect(screen.getByRole("option", { name: "local" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByText("Backup running...")).toBeInTheDocument());
    // A non-ok response and a rejected fetch should both be skipped rather
    // than shown as "Backup failed: undefined" - polling should continue
    // until a real terminal status arrives.
    await waitFor(() => expect(screen.getByText("Backup completed.")).toBeInTheDocument(), { timeout: 10000 });
    expect(onDone).toHaveBeenCalled();
  }, 15000);

  it("shows an inline error when starting the backup fails", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ storages: [{ storage: "local", prunePolicy: null }] }),
      })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "Backup already running" }) });

    renderDialog({ open: true, node: "proxmox", vmid: "100", onClose: vi.fn(), onDone: vi.fn() });

    await waitFor(() => expect(screen.getByRole("option", { name: "local" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByText("Backup already running")).toBeInTheDocument());
  });
});
