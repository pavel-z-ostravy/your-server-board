// @vitest-environment jsdom

// Stub prism-react-renderer's Highlight to render the raw code as plain
// text - real tokenization is Prism's own well-tested behavior, not this
// app's; a deterministic stub avoids brittle assertions on token markup.
vi.mock("prism-react-renderer", () => ({
  Highlight: ({ code, children }) =>
    children({
      style: {},
      tokens: code.split("\n").map((line) => [{ content: line }]),
      getLineProps: () => ({}),
      getTokenProps: ({ token }) => ({ children: token.content }),
    }),
  themes: { nightOwl: {}, github: {} },
}));

vi.mock("components/widgets/InstallWizardDialog", () => ({
  default: ({ entry, open, onClose }) =>
    open ? (
      <div>
        <p>
          Install dialog: {entry.title} ({entry.category})
        </p>
        <button type="button" onClick={onClose}>
          Close dialog
        </button>
      </div>
    ) : null,
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WidgetsPage from "pages/widgets";
import { ColorProvider } from "utils/contexts/color";
import { ThemeProvider } from "utils/contexts/theme";

// WidgetsPage renders SyncThemeColor, which reads ThemeContext/ColorContext -
// both are undefined unless wrapped in their real providers, same as the
// actual app tree in _app.jsx wraps every page.
function renderWithSWR(ui) {
  return render(
    <ColorProvider>
      <ThemeProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>
      </ThemeProvider>
    </ColorProvider>,
  );
}

const catalogResponse = {
  services: [
    {
      slug: "plex",
      title: "Plex",
      description: "Plex Widget Configuration",
      yamlExample: "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere",
    },
    {
      slug: "sonarr",
      title: "Sonarr",
      description: "Sonarr Widget Configuration",
      yamlExample: "widget:\n  type: sonarr\n  url: http://sonarr.host.or.ip:8989\n  key: apikeyhere",
    },
  ],
  info: [
    {
      slug: "datetime",
      title: "Date & Time",
      description: "Date & Time Widget Configuration",
      yamlExample: null,
    },
  ],
};

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });

  // jsdom doesn't implement matchMedia by default; ThemeProvider needs it.
  window.matchMedia =
    window.matchMedia || vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

describe("pages/widgets", () => {
  it("renders both categories from the catalog response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);

    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());
    expect(screen.getByText("Sonarr")).toBeInTheDocument();
    expect(screen.getByText("Date & Time")).toBeInTheDocument();
  });

  it("filters both categories by the search query", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("Search widgets..."), { target: { value: "plex" } });

    await waitFor(() => expect(screen.queryByText("Sonarr")).not.toBeInTheDocument());
    expect(screen.getByText("Plex")).toBeInTheDocument();
  });

  it("expands a widget row to show its YAML example and copies it to the clipboard", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

    expect(screen.queryByText("Copy")).not.toBeInTheDocument();

    screen.getByText("Plex").click();

    await waitFor(() => expect(screen.getByText("Copy")).toBeInTheDocument());
    expect(screen.getByText(/type: plex/)).toBeInTheDocument();

    screen.getByText("Copy").click();

    await waitFor(() => expect(screen.getByText("Copied!")).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(catalogResponse.services[0].yamlExample);
  });

  it('shows an "Install..." button next to Copy and opens the install dialog with the entry', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

    screen.getByText("Plex").click();
    await waitFor(() => expect(screen.getByText("Install...")).toBeInTheDocument());

    screen.getByText("Install...").click();
    await waitFor(() => expect(screen.getByText("Install dialog: Plex (service)")).toBeInTheDocument());
  });

  it("does not show an Install button for a widget with no YAML example", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Date & Time")).toBeInTheDocument());

    screen.getByText("Date & Time").click();
    await waitFor(() => expect(screen.getByText("No example available.")).toBeInTheDocument());
    expect(screen.queryByText("Install...")).not.toBeInTheDocument();
  });

  it('shows an "Installed on:" list with a trash icon for a service widget, and calls uninstall on confirm', async () => {
    global.fetch = vi.fn((url) => {
      if (url === "/api/widgets-catalog") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(catalogResponse) });
      }
      if (url === "/api/widgets-catalog/installed") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ services: { plex: ["My Plex"] }, info: {} }),
        });
      }
      if (url === "/api/widgets-catalog/uninstall") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, backupFile: "x" }) });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

    screen.getByText("Plex").click();
    await waitFor(() => expect(screen.getByText("Installed on:")).toBeInTheDocument());
    expect(screen.getByText("My Plex")).toBeInTheDocument();

    const installedCallsBefore = global.fetch.mock.calls.filter(
      ([url]) => url === "/api/widgets-catalog/installed",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "Remove My Plex" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove?" }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/widgets-catalog/uninstall",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ category: "service", serviceName: "My Plex" }),
        }),
      ),
    );

    await waitFor(() => {
      const installedCallsAfter = global.fetch.mock.calls.filter(
        ([url]) => url === "/api/widgets-catalog/installed",
      ).length;
      expect(installedCallsAfter).toBeGreaterThan(installedCallsBefore);
    });
  });

  it('shows an "Installed on:" list for an info widget and includes the fingerprint when removing it', async () => {
    global.fetch = vi.fn((url) => {
      if (url === "/api/widgets-catalog") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(catalogResponse) });
      }
      if (url === "/api/widgets-catalog/installed") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ services: {}, info: { datetime: [{ index: 0, fingerprint: "abc123" }] } }),
        });
      }
      if (url === "/api/widgets-catalog/uninstall") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, backupFile: "x" }) });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Date & Time")).toBeInTheDocument());

    screen.getByText("Date & Time").click();
    await waitFor(() => expect(screen.getByText("Installed on:")).toBeInTheDocument());
    expect(screen.getByText("Instance #1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Instance #1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove?" }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/widgets-catalog/uninstall",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ category: "info", slug: "datetime", index: 0, fingerprint: "abc123" }),
        }),
      ),
    );
  });

  it('does not show an "Installed on:" section when nothing is installed', async () => {
    global.fetch = vi.fn((url) => {
      if (url === "/api/widgets-catalog") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(catalogResponse) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ services: {}, info: {} }) });
    });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

    screen.getByText("Plex").click();
    await waitFor(() => expect(screen.getByText("Copy")).toBeInTheDocument());
    expect(screen.queryByText("Installed on:")).not.toBeInTheDocument();
  });

  it("shows a no-example message for a widget with no YAML block, and no Copy button", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Date & Time")).toBeInTheDocument());

    screen.getByText("Date & Time").click();

    await waitFor(() => expect(screen.getByText("No example available.")).toBeInTheDocument());
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
  });

  it("shows a failure message when the catalog fetch fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    renderWithSWR(<WidgetsPage />);

    await waitFor(() => expect(screen.getByText("Failed to load widget catalog.")).toBeInTheDocument());
  });
});
