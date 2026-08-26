// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DeleteConfirmDialog from "./delete-confirm-dialog";

describe("components/backups/delete-confirm-dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the Delete button disabled until the typed name matches exactly", () => {
    render(<DeleteConfirmDialog open vmName="my-vm" onConfirm={vi.fn()} onClose={vi.fn()} />);

    const deleteButton = screen.getByRole("button", { name: "Delete" });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "wrong-name" } });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my-vm" } });
    expect(deleteButton).toBeEnabled();
  });

  it("calls onConfirm and then onClose when the typed name matches and Delete is clicked", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    render(<DeleteConfirmDialog open vmName="my-vm" onConfirm={onConfirm} onClose={onClose} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my-vm" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalled();
  });

  it("shows an inline error and stays open when onConfirm fails", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: false, error: "Failed to delete backup" });
    const onClose = vi.fn();
    render(<DeleteConfirmDialog open vmName="my-vm" onConfirm={onConfirm} onClose={onClose} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my-vm" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("Failed to delete backup")).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancel closes without calling onConfirm", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<DeleteConfirmDialog open vmName="my-vm" onConfirm={onConfirm} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
