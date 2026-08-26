// src/components/backups/backup-list.test.jsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mutate };
});

import BackupList from "./backup-list";

// Each test reuses the same node/vmid, so without a per-test SWR cache the
// list fetch from one test's SWR cache would bleed into the next (SWR's
// default cache is a module-level singleton). Isolate it here per SWR's own
// documented pattern for resetting the cache between test cases:
// https://swr.vercel.app/docs/advanced/cache#reset-cache-between-test-cases
const renderList = (props) =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <BackupList {...props} />
    </SWRConfig>,
  );

describe("components/backups/backup-list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("shows a message when there are no backups", async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ backups: [] }) });

    renderList({ node: "proxmox", vmid: "100", vmName: "my-vm" });

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

    renderList({ node: "proxmox", vmid: "100", vmName: "my-vm" });

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

    renderList({ node: "proxmox", vmid: "100", vmName: "my-vm" });

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
