// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", () => ({ mutate }));

import WidgetRemoveButton from "./widget-remove-button";

describe("components/services/widget-remove-button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("shows a trash icon that flips to Remove?/Cancel on click", () => {
    render(<WidgetRemoveButton serviceName="Plex" />);

    expect(screen.getByRole("button", { name: "Remove widget" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove?" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));

    expect(screen.getByRole("button", { name: "Remove?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("cancel returns to the icon button without calling the API", () => {
    render(<WidgetRemoveButton serviceName="Plex" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Remove widget" })).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("confirming calls the uninstall route with the service name and revalidates /api/services", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, backupFile: "x" }) });

    render(<WidgetRemoveButton serviceName="Plex" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove?" }));

    await waitFor(() => expect(mutate).toHaveBeenCalledWith("/api/services"));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/widgets-catalog/uninstall",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ category: "service", serviceName: "Plex" }),
      }),
    );
  });

  it("shows the server's error message inline and stays in confirm mode when the request fails", async () => {
    global.fetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    render(<WidgetRemoveButton serviceName="Plex" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove?" }));

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove?" })).toBeInTheDocument();
  });

  it("clears the error when Cancel is clicked, so re-opening confirm doesn't show a stale message", async () => {
    global.fetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    render(<WidgetRemoveButton serviceName="Plex" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove?" }));
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));

    expect(screen.queryByText("boom")).not.toBeInTheDocument();
  });
});
