// @vitest-environment jsdom

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PageHeader from "./PageHeader";

describe("components/layout/PageHeader", () => {
  it("renders the title as the page heading", () => {
    render(<PageHeader title="Backups" />);
    expect(screen.getByRole("heading", { level: 1, name: "Backups" })).toBeInTheDocument();
  });

  it("renders the hamburger nav button inline, before the heading", () => {
    render(<PageHeader title="Widgets" />);

    const button = screen.getByRole("button", { name: "Open menu" });
    const heading = screen.getByRole("heading", { level: 1, name: "Widgets" });

    expect(button).toBeInTheDocument();
    // Button comes before the heading in DOM order (so it sits to its left).
    expect(button.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
