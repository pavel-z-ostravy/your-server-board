// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button", "aria-roledescription": "sortable" },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

import SortableSection from "./SortableSection";

describe("SortableSection", () => {
  it("renders its children unchanged", () => {
    render(
      <SortableSection id="disks">
        <div data-testid="content">Disks content</div>
      </SortableSection>,
    );

    expect(screen.getByTestId("content")).toHaveTextContent("Disks content");
  });

  it("puts the drag attributes/listeners only on the handle, not on the section content", () => {
    render(
      <SortableSection id="disks">
        <button type="button" data-testid="inner-button">
          Refresh
        </button>
      </SortableSection>,
    );

    const handle = screen.getByRole("button", { name: "Drag to reorder this section" });
    expect(handle).toHaveAttribute("aria-roledescription", "sortable");

    expect(screen.getByTestId("inner-button")).not.toHaveAttribute("aria-roledescription");
  });
});
