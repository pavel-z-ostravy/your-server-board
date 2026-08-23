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

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
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
