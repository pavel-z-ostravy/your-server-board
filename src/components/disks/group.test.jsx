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
            status: "ok",
            error: null,
          },
        ]),
    });

    renderWithSWR(<DisksGroup />);

    expect(screen.getByText("Disks")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("sda")).toBeInTheDocument());
    const card = screen.getByText("sda").closest('[data-testid="disk-card"]');
    expect(card).toHaveAttribute("data-status", "ok");
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
