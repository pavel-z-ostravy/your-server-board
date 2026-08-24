// @vitest-environment jsdom

import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "test-utils/render-with-providers";

const { useWidgetAPI } = vi.hoisted(() => ({ useWidgetAPI: vi.fn() }));
vi.mock("utils/proxy/use-widget-api", () => ({ default: useWidgetAPI }));

import Component from "./component";

describe("widgets/nextdns/component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders waiting status while loading", () => {
    useWidgetAPI.mockReturnValue({ data: undefined, error: undefined });

    renderWithProviders(<Component service={{ widget: { type: "nextdns" } }} />, { settings: { hideErrors: false } });

    expect(screen.getByText("widget.status")).toBeInTheDocument();
    expect(screen.getByText("nextdns.wait")).toBeInTheDocument();
  });

  it("renders no-devices status when data array is empty", () => {
    useWidgetAPI.mockReturnValue({ data: { data: [] }, error: undefined });

    renderWithProviders(<Component service={{ widget: { type: "nextdns" } }} />, { settings: { hideErrors: false } });

    expect(screen.getByText("nextdns.no_devices")).toBeInTheDocument();
  });

  it("renders a block per device status with query counts", () => {
    useWidgetAPI.mockReturnValue({
      data: {
        data: [
          { status: "nextdns.active", queries: 10 },
          { status: "nextdns.offline", queries: 2 },
        ],
      },
      error: undefined,
    });

    renderWithProviders(<Component service={{ widget: { type: "nextdns", profile: "abc123" } }} />, {
      settings: { hideErrors: false },
    });

    expect(useWidgetAPI).toHaveBeenCalledWith({ type: "nextdns", profile: "abc123" }, "analytics/status");
    expect(screen.getByText("nextdns.active")).toBeInTheDocument();
    expect(screen.getByText("nextdns.offline")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByText("2a07:a8c0::ab:c123")).toBeInTheDocument();
    expect(screen.getByText("2a07:a8c1::ab:c123")).toBeInTheDocument();
  });

  it("fetches the devices endpoint and renders a block per device when view is 'devices'", () => {
    useWidgetAPI.mockReturnValue({
      data: {
        data: [
          { id: "abc123", name: "Living Room TV", queries: 42 },
          { id: "__UNIDENTIFIED__", queries: 5 },
        ],
      },
      error: undefined,
    });

    renderWithProviders(<Component service={{ widget: { type: "nextdns", view: "devices", profile: "abc123" } }} />, {
      settings: { hideErrors: false },
    });

    expect(useWidgetAPI).toHaveBeenCalledWith(
      { type: "nextdns", view: "devices", profile: "abc123" },
      "analytics/devices",
    );
    expect(screen.getByText("Living Room TV")).toBeInTheDocument();
    expect(screen.getByText("__UNIDENTIFIED__")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("47")).toBeInTheDocument();
  });

  it("shows the waiting state for the devices view too, before data arrives", () => {
    useWidgetAPI.mockReturnValue({ data: undefined, error: undefined });

    renderWithProviders(<Component service={{ widget: { type: "nextdns", view: "devices" } }} />, {
      settings: { hideErrors: false },
    });

    expect(screen.getByText("nextdns.wait")).toBeInTheDocument();
  });
});
