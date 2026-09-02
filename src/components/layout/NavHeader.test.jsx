// @vitest-environment jsdom

// Stub Menu/Transition to always render open (keeps tests deterministic),
// matching the existing pattern in src/components/services/dropdown.test.jsx.
vi.mock("@headlessui/react", async () => {
  const React = await import("react");
  const { Fragment } = React;

  function Transition({ as: As = Fragment, children }) {
    if (As === Fragment) return <>{children}</>;
    return <As>{children}</As>;
  }

  function Menu({ as: As = "div", children, ...props }) {
    const content = typeof children === "function" ? children({ open: true }) : children;
    return <As {...props}>{content}</As>;
  }

  function MenuButton(props) {
    return <button type="button" {...props} />;
  }
  function MenuItems(props) {
    return <div {...props} />;
  }
  function MenuItem({ children }) {
    return <>{children}</>;
  }

  Menu.Button = MenuButton;
  Menu.Items = MenuItems;
  Menu.Item = MenuItem;

  return { Menu, Transition };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import NavHeader from "./NavHeader";

describe("components/layout/NavHeader", () => {
  it("renders a hamburger button and links to the Dashboard and Widgets pages", () => {
    render(<NavHeader />);

    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();

    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink).toBeInTheDocument();
    expect(dashboardLink).toHaveAttribute("href", "/");

    const widgetsLink = screen.getByRole("link", { name: "Widgets" });
    expect(widgetsLink).toBeInTheDocument();
    expect(widgetsLink).toHaveAttribute("href", "/widgets");
  });

  it("links to both the Widgets catalog and the Backups page", () => {
    render(<NavHeader />);

    expect(screen.getByRole("link", { name: /Widgets/ })).toHaveAttribute("href", "/widgets");
    expect(screen.getByRole("link", { name: /Backups/ })).toHaveAttribute("href", "/backups");
  });

  it("includes a Security link", () => {
    render(<NavHeader />);
    expect(screen.getByRole("link", { name: /security/i })).toHaveAttribute("href", "/security");
  });

  it("floats in the top-left corner by default, but sits in flow when inline", () => {
    const { container, rerender } = render(<NavHeader />);
    expect(container.firstChild).toHaveClass("absolute");

    rerender(<NavHeader inline />);
    expect(container.firstChild).not.toHaveClass("absolute");
    expect(container.firstChild).toHaveClass("relative");
  });
});
