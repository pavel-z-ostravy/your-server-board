// src/components/proxmox-vms/group.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import ProxmoxVmsGroup from "./group";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

describe("components/proxmox-vms/group", () => {
  it("renders a heading and a card per VM/LXC with real data", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 100,
            node: "proxmox",
            type: "qemu",
            name: "homeassistant",
            status: "running",
            cpuUsedCores: 0.0625912395730508,
            cpuTotalCores: 1,
            memUsedBytes: 3088969728,
            memTotalBytes: 3221225472,
            diskUsedBytes: null,
            diskTotalBytes: 34359738368,
            uptimeSeconds: 92576,
            macAddress: "BC:24:11:85:3A:8F",
            ipAddress: "10.0.1.22",
            osName: "Home Assistant OS 18.2",
          },
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "lxc-homelab",
            status: "stopped",
            cpuUsedCores: 0,
            cpuTotalCores: 4,
            memUsedBytes: 0,
            memTotalBytes: 12582912000,
            diskUsedBytes: 61370929152,
            diskTotalBytes: 84358758400,
            uptimeSeconds: 0,
            macAddress: null,
            ipAddress: null,
            osName: null,
          },
        ]),
    });

    renderWithSWR(<ProxmoxVmsGroup />);

    expect(screen.getByText("Virtual Machines")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("homeassistant")).toBeInTheDocument());

    const vmCard = screen.getByText("homeassistant").closest('[data-testid="vm-card"]');
    expect(vmCard).toHaveAttribute("data-status", "running");
    expect(vmCard).toHaveTextContent("Home Assistant OS 18.2");
    expect(vmCard).toHaveTextContent("10.0.1.22");
    expect(vmCard).toHaveTextContent("1d 1h"); // formatUptime(92576)
    expect(vmCard).toHaveTextContent("3.09 GB / 3.22 GB"); // pretty-bytes on mem
    // QEMU has no real per-guest disk usage (diskUsedBytes: null), but the
    // allocated size (diskTotalBytes / maxdisk) is available and should be
    // shown instead of a bare "-".
    expect(vmCard).toHaveTextContent("34.4 GB (allocated)"); // pretty-bytes on maxdisk (34359738368)

    const lxcCard = screen.getByText("lxc-homelab").closest('[data-testid="vm-card"]');
    expect(lxcCard).toHaveAttribute("data-status", "stopped");
    // No MAC/IP/OS available for this entry — reuses the existing Stat "-" placeholder.
    expect(lxcCard).toHaveTextContent("-");
  });

  it("shows a failure message when the API responds with an error status", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    renderWithSWR(<ProxmoxVmsGroup />);

    await waitFor(() => expect(screen.getByText("Failed to load VM/LXC data.")).toBeInTheDocument());
  });

  it("lazily fetches and shows process/update detail only after the Details toggle is clicked", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "lxc-homelab",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "BC:24:11:AE:7C:89",
            ipAddress: "10.0.1.104",
            osName: "debian",
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
    global.fetch = vi.fn((url) =>
      url.includes("vm-detail") ? Promise.resolve(detailResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("lxc-homelab")).toBeInTheDocument());

    // Before expanding: no detail fetch, no process data visible.
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("vm-detail"));
    expect(screen.queryByText("redis-server")).not.toBeInTheDocument();

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("redis-server")).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/proxmox/vm-detail?type=lxc&node=proxmox&vmid=200"),
    );
    expect(screen.getByText(/Last update: N\/A/)).toBeInTheDocument();
  });

  it("shows an explicit empty-state message when the detail fetch succeeds with zero processes", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "lxc-homelab",
            status: "stopped",
            cpuUsedCores: 0,
            cpuTotalCores: 4,
            memUsedBytes: 0,
            memTotalBytes: 2,
            diskUsedBytes: 0,
            diskTotalBytes: 2,
            uptimeSeconds: 0,
            macAddress: "BC:24:11:AE:7C:89",
            ipAddress: "10.0.1.104",
            osName: "debian",
          },
        ]),
    };
    const detailResponse = {
      ok: true,
      json: () => Promise.resolve({ processes: [], osReleaseName: null, lastUpdate: null }),
    };
    global.fetch = vi.fn((url) =>
      url.includes("vm-detail") ? Promise.resolve(detailResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("lxc-homelab")).toBeInTheDocument());

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("No process data available.")).toBeInTheDocument());
    expect(screen.queryByText(/redis-server/)).not.toBeInTheDocument();
    expect(screen.queryByText("Failed to load details.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("shows a failure message when the detail fetch responds with a non-ok status", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "lxc-homelab",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "BC:24:11:AE:7C:89",
            ipAddress: "10.0.1.104",
            osName: "debian",
          },
        ]),
    };
    const detailResponse = { ok: false, json: () => Promise.resolve({ error: "boom" }) };
    global.fetch = vi.fn((url) =>
      url.includes("vm-detail") ? Promise.resolve(detailResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("lxc-homelab")).toBeInTheDocument());

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("Failed to load details.")).toBeInTheDocument());
    expect(screen.queryByText("redis-server")).not.toBeInTheDocument();
  });
});
