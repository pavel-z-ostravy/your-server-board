// src/__tests__/pages/disks.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import DisksPage from "pages/disks";

function renderWithSWR(ui) {
  // disable SWR's dedupe/cache between tests so each test's mocked fetch is used fresh
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

describe("pages/disks", () => {
  it("renders a card per disk with the correct status color", async () => {
    global.fetch = vi.fn().mockResolvedValue({
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
          {
            name: "sdc",
            device: "/dev/sdc",
            model: "Vi3000",
            size: "1.9T",
            protocol: "NVMe",
            temperature: 91,
            smartPassed: true,
            reallocatedSectors: null,
            wearPercentage: 10,
            mediaErrors: 0,
            status: "warn",
            error: null,
          },
        ]),
    });

    renderWithSWR(<DisksPage />);

    await waitFor(() => expect(screen.getByText("sda")).toBeInTheDocument());
    expect(screen.getByText("sdc")).toBeInTheDocument();
    expect(screen.getByText("40°C")).toBeInTheDocument();
    expect(screen.getByText("91°C")).toBeInTheDocument();

    const okCard = screen.getByText("sda").closest('[data-testid="disk-card"]');
    const warnCard = screen.getByText("sdc").closest('[data-testid="disk-card"]');
    expect(okCard).toHaveAttribute("data-status", "ok");
    expect(warnCard).toHaveAttribute("data-status", "warn");
  });

  it("shows the per-disk error message when a disk failed to query", async () => {
    global.fetch = vi.fn().mockResolvedValue({
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
            error: "boom",
          },
        ]),
    });

    renderWithSWR(<DisksPage />);

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });
});
