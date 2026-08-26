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
      json: () =>
        Promise.resolve([{ vmid: 100, node: "proxmox", type: "qemu", name: "example-vm", status: "running" }]),
    });

    render(<VmList />);

    await waitFor(() => expect(screen.getByText("example-vm")).toBeInTheDocument());
    fireEvent.click(screen.getByText("example-vm"));
    expect(screen.getByTestId("backup-list")).toBeInTheDocument();

    fireEvent.click(screen.getByText("example-vm"));
    expect(screen.queryByTestId("backup-list")).not.toBeInTheDocument();
  });
});
