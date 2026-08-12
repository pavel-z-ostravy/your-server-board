// src/components/disks/group.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import DisksGroup from "./group";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

describe("components/disks/group", () => {
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

  it("shows the per-disk error message when a disk failed to query", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            name: "sdb",
            device: "/dev/sdb",
            model: "B",
            size: "1T",
            protocol: null,
            temperature: null,
            smartPassed: null,
            reallocatedSectors: null,
            wearPercentage: null,
            mediaErrors: null,
            status: null,
            error: "SMART query failed",
          },
        ]),
    });

    renderWithSWR(<DisksGroup />);

    await waitFor(() => expect(screen.getByText("SMART query failed")).toBeInTheDocument());
  });

  it("shows a failure message when the API responds with an error status", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    renderWithSWR(<DisksGroup />);

    await waitFor(() => expect(screen.getByText("Failed to load disk data.")).toBeInTheDocument());
  });
});
