// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ConfigBackup from "./config-backup";

describe("components/backups/config-backup", () => {
  it("renders a heading and a download link pointing at the config-download route", () => {
    render(<ConfigBackup />);

    expect(screen.getByText("Proxmox Configuration")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", "/api/proxmox/backups/config-download");
    expect(link).toHaveAttribute("download");
  });
});
