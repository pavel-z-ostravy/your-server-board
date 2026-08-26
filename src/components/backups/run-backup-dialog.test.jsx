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
