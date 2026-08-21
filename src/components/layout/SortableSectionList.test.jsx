// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { capturedOnDragEnd } = vi.hoisted(() => ({ capturedOnDragEnd: { current: null } }));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd }) => {
    capturedOnDragEnd.current = onDragEnd;
    return children;
  },
  PointerSensor: class {},
  KeyboardSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }) => children,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: "vertical",
  sortableKeyboardCoordinates: vi.fn(),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

import SortableSectionList from "./SortableSectionList";

describe("SortableSectionList", () => {
  it("renders sections in the given order", () => {
    const sections = [
      { id: "disks", element: <div data-testid="disks">Disks</div> },
      { id: "services", element: <div data-testid="services">Services</div> },
    ];

    render(<SortableSectionList sections={sections} onReorder={vi.fn()} />);

    const rendered = screen.getAllByTestId(/disks|services/);
    expect(rendered.map((el) => el.dataset.testid)).toEqual(["disks", "services"]);
  });

  it("calls onReorder with the new id order after a drag ends over a different section", () => {
    const sections = [
      { id: "disks", element: <div>Disks</div> },
      { id: "services", element: <div>Services</div> },
      { id: "bookmarks", element: <div>Bookmarks</div> },
    ];
    const onReorder = vi.fn();

    render(<SortableSectionList sections={sections} onReorder={onReorder} />);
    capturedOnDragEnd.current({ active: { id: "disks" }, over: { id: "bookmarks" } });

    expect(onReorder).toHaveBeenCalledWith(["services", "bookmarks", "disks"]);
  });

  it("does not call onReorder for a no-op drag (dropped on itself or outside any droppable)", () => {
    const sections = [
      { id: "disks", element: <div>Disks</div> },
      { id: "services", element: <div>Services</div> },
    ];
    const onReorder = vi.fn();

    render(<SortableSectionList sections={sections} onReorder={onReorder} />);
    capturedOnDragEnd.current({ active: { id: "disks" }, over: { id: "disks" } });
    capturedOnDragEnd.current({ active: { id: "disks" }, over: null });

    expect(onReorder).not.toHaveBeenCalled();
  });
});
