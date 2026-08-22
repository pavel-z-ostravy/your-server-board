// src/components/proxmox-vms/group.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import ProxmoxVmsGroup from "./group";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

const onlineHostResponse = {
  ok: true,
  json: () =>
    Promise.resolve({
      status: "online",
      cpuUsedCores: 3.2,
      cpuTotalCores: 8,
      memUsedBytes: 4210000000,
      memTotalBytes: 8590000000,
      diskUsedBytes: 21300000000,
      diskTotalBytes: 64700000000,
      uptimeSeconds: 93784,
      pveVersion: "9.1.1",
      loadAvg: [0.55, 0.61, 0.58],
    }),
};

const offlineHostResponse = {
  ok: true,
  json: () =>
    Promise.resolve({
      status: "offline",
      cpuUsedCores: null,
      cpuTotalCores: null,
      memUsedBytes: null,
      memTotalBytes: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
      uptimeSeconds: null,
      pveVersion: null,
      loadAvg: null,
    }),
};

const errorHostResponse = { ok: false, json: () => Promise.resolve({ error: "boom" }) };

describe("components/proxmox-vms/group", () => {
  it("renders a heading and a card per VM/LXC with real data", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 100,
            node: "proxmox",
            type: "qemu",
            name: "example-vm",
            status: "running",
            cpuUsedCores: 0.0625912395730508,
            cpuTotalCores: 1,
            memUsedBytes: 3088969728,
            memTotalBytes: 3221225472,
            diskUsedBytes: null,
            diskTotalBytes: 34359738368,
            uptimeSeconds: 92576,
            macAddress: "AA:BB:CC:11:22:33",
            ipAddress: "10.0.0.22",
            osName: "Home Assistant OS 18.2",
          },
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
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
    };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(onlineHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    expect(screen.getByText("Proxmox")).toBeInTheDocument();
    expect(screen.getByText("Virtual Machines")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("example-vm")).toBeInTheDocument());

    const vmCard = screen.getByText("example-vm").closest('[data-testid="vm-card"]');
    expect(vmCard).toHaveAttribute("data-status", "running");
    expect(vmCard).toHaveTextContent("Home Assistant OS 18.2");
    expect(vmCard).toHaveTextContent("10.0.0.22");
    expect(vmCard).toHaveTextContent("1d 1h"); // formatUptime(92576)
    expect(vmCard).toHaveTextContent("3.09 GB / 3.22 GB"); // pretty-bytes on mem
    expect(vmCard).toHaveTextContent("34.4 GB (allocated)"); // pretty-bytes on maxdisk (34359738368)

    const lxcCard = screen.getByText("example-lxc").closest('[data-testid="vm-card"]');
    expect(lxcCard).toHaveAttribute("data-status", "stopped");
    expect(lxcCard).toHaveTextContent("-");
  });

  it("renders the Proxmox host status header above the VM grid", async () => {
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(onlineHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    const header = await screen.findByTestId("node-status-header");
    expect(header).toHaveAttribute("data-status", "online");
    expect(header).toHaveTextContent("3.20 / 8"); // CPU
    expect(header).toHaveTextContent("4.21 GB / 8.59 GB"); // RAM
    expect(header).toHaveTextContent("21.3 GB / 64.7 GB"); // Disk
    expect(header).toHaveTextContent("PVE 9.1.1");
    expect(header).toHaveTextContent("load 0.55 / 0.61 / 0.58");
  });

  it("gracefully handles loadAvg with null values (NaN round-trip from JSON) without crashing", async () => {
    const hostResponseWithNullLoadAvg = {
      ok: true,
      json: () =>
        Promise.resolve({
          status: "online",
          cpuUsedCores: 3.2,
          cpuTotalCores: 8,
          memUsedBytes: 4210000000,
          memTotalBytes: 8590000000,
          diskUsedBytes: 21300000000,
          diskTotalBytes: 64700000000,
          uptimeSeconds: 93784,
          pveVersion: "9.1.1",
          loadAvg: [1.06, null, 0.83],
        }),
    };
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(hostResponseWithNullLoadAvg) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    const header = await screen.findByTestId("node-status-header");
    expect(header).toHaveAttribute("data-status", "online");
    expect(header).toHaveTextContent("load 1.06 / - / 0.83");
  });

  it("shows a degraded offline state for the host status header without hiding the VM grid", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(offlineHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    const header = await screen.findByTestId("node-status-header");
    expect(header).toHaveAttribute("data-status", "offline");
    // Host is offline, but the VM grid below it still renders normally.
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());
  });

  it("shows a failure message for the host status header when its fetch fails, without affecting the VM grid", async () => {
    const listResponse = {
      ok: true,
      json: () =>
        Promise.resolve([
          {
            vmid: 200,
            node: "proxmox",
            type: "lxc",
            name: "example-lxc",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(errorHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    await waitFor(() => expect(screen.getByText("Failed to load Proxmox host status.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());
  });

  it("shows a failure message when the VM list API responds with an error status, independent of host status", async () => {
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host")
        ? Promise.resolve(onlineHostResponse)
        : Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "boom" }) }),
    );

    renderWithSWR(<ProxmoxVmsGroup />);

    await waitFor(() => expect(screen.getByText("Failed to load VM/LXC data.")).toBeInTheDocument());
    // VM list failed, but the host status header still renders successfully.
    const header = await screen.findByTestId("node-status-header");
    expect(header).toHaveAttribute("data-status", "online");
  });

  it("clicking Refresh re-fetches both the VM list and the host status", async () => {
    const listResponse = { ok: true, json: () => Promise.resolve([]) };
    global.fetch = vi.fn((url) =>
      url.includes("/api/proxmox/host") ? Promise.resolve(onlineHostResponse) : Promise.resolve(listResponse),
    );

    renderWithSWR(<ProxmoxVmsGroup />);
    await screen.findByTestId("node-status-header");

    const callsBeforeRefresh = global.fetch.mock.calls.length;
    screen.getByText("Refresh").click();

    await waitFor(() => expect(global.fetch.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
    const urlsAfterRefresh = global.fetch.mock.calls.slice(callsBeforeRefresh).map((call) => call[0]);
    expect(urlsAfterRefresh.some((url) => url.includes("/api/proxmox/vms"))).toBe(true);
    expect(urlsAfterRefresh.some((url) => url.includes("/api/proxmox/host"))).toBe(true);
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
            name: "example-lxc",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
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
    global.fetch = vi.fn((url) => {
      if (url.includes("vm-detail")) return Promise.resolve(detailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());

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
            name: "example-lxc",
            status: "stopped",
            cpuUsedCores: 0,
            cpuTotalCores: 4,
            memUsedBytes: 0,
            memTotalBytes: 2,
            diskUsedBytes: 0,
            diskTotalBytes: 2,
            uptimeSeconds: 0,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    const detailResponse = {
      ok: true,
      json: () => Promise.resolve({ processes: [], osReleaseName: null, lastUpdate: null }),
    };
    global.fetch = vi.fn((url) => {
      if (url.includes("vm-detail")) return Promise.resolve(detailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());

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
            name: "example-lxc",
            status: "running",
            cpuUsedCores: 1,
            cpuTotalCores: 4,
            memUsedBytes: 1,
            memTotalBytes: 2,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
            uptimeSeconds: 100,
            macAddress: "AA:BB:CC:44:55:66",
            ipAddress: "10.0.0.104",
            osName: "debian",
          },
        ]),
    };
    const detailResponse = { ok: false, json: () => Promise.resolve({ error: "boom" }) };
    global.fetch = vi.fn((url) => {
      if (url.includes("vm-detail")) return Promise.resolve(detailResponse);
      if (url.includes("/api/proxmox/host")) return Promise.resolve(onlineHostResponse);
      return Promise.resolve(listResponse);
    });

    renderWithSWR(<ProxmoxVmsGroup />);
    await waitFor(() => expect(screen.getByText("example-lxc")).toBeInTheDocument());

    screen.getByText("Details").click();

    await waitFor(() => expect(screen.getByText("Failed to load details.")).toBeInTheDocument());
    expect(screen.queryByText("redis-server")).not.toBeInTheDocument();
  });
});
