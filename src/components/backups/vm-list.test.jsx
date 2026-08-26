// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./backup-list", () => ({
  default: ({ node, vmid, vmName }) => <div data-testid="backup-list">{`${node}/${vmid}/${vmName}`}</div>,
}));

import VmList from "./vm-list";

// Each test hits the same `/api/proxmox/vms` SWR key, so without a per-test
// SWR cache the second test would render the first test's cached data
// instead of its own mock (SWR's default cache is a module-level singleton).
// Isolate it here per SWR's own documented pattern for resetting the cache
// between test cases: https://swr.vercel.app/docs/advanced/cache#reset-cache-between-test-cases
const renderVmList = () =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <VmList />
    </SWRConfig>,
  );

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

    renderVmList();

    await waitFor(() => expect(screen.getByText("example-vm")).toBeInTheDocument());
    expect(screen.getByText("example-lxc")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-list")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("example-vm"));

    expect(screen.getByTestId("backup-list")).toHaveTextContent("proxmox/100/example-vm");
  });

  it("collapses a VM/CT's backups when clicked again", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([{ vmid: 100, node: "proxmox", type: "qemu", name: "example-vm", status: "running" }]),
    });

    renderVmList();

    await waitFor(() => expect(screen.getByText("example-vm")).toBeInTheDocument());
    // Confirms this test is genuinely rendering its own single-VM mock, not
    // leftover cached data from the previous test's two-VM response.
    expect(screen.queryByText("example-lxc")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("example-vm"));
    expect(screen.getByTestId("backup-list")).toBeInTheDocument();

    fireEvent.click(screen.getByText("example-vm"));
    expect(screen.queryByTestId("backup-list")).not.toBeInTheDocument();
  });
});
