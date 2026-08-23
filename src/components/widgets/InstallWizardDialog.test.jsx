// @vitest-environment jsdom

// Stub Dialog/DialogBackdrop/DialogPanel/DialogTitle to always render
// children when open (keeps tests deterministic), matching the existing
// pattern in dropdown.test.jsx / NavHeader.test.jsx for @headlessui/react.
vi.mock("@headlessui/react", async () => {
  const React = await import("react");

  function Dialog({ open, children, ...props }) {
    if (!open) return null;
    return <div {...props}>{children}</div>;
  }
  function DialogBackdrop(props) {
    return <div {...props} />;
  }
  function DialogPanel(props) {
    return <div {...props} />;
  }
  function DialogTitle(props) {
    return React.createElement("h2", props);
  }

  return { Dialog, DialogBackdrop, DialogPanel, DialogTitle };
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InstallWizardDialog from "./InstallWizardDialog";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

const SERVICE_ENTRY = {
  slug: "plex",
  title: "Plex",
  description: "Plex Widget Configuration",
  category: "service",
  yamlExample: "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere",
};

const INFO_ENTRY = {
  slug: "datetime",
  title: "Date & Time",
  description: "Date & Time Widget Configuration",
  category: "info",
  yamlExample: "- datetime:\n    text_size: xl",
};

function mockFetchSequence(handlers) {
  global.fetch = vi.fn((url, options) => {
    const match = handlers.find((h) => h.match(url, options));
    if (!match) throw new Error(`Unexpected fetch call: ${url}`);
    return Promise.resolve({ ok: match.ok !== false, json: () => Promise.resolve(match.body) });
  });
}

describe("components/widgets/InstallWizardDialog", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ groups: [], services: [] }) });
  });

  it("info widget: skips the target step and shows the YAML preview directly", async () => {
    renderWithSWR(<InstallWizardDialog entry={INFO_ENTRY} open onClose={vi.fn()} />);

    expect(await screen.findByLabelText("YAML preview")).toHaveValue(INFO_ENTRY.yamlExample);
    expect(screen.queryByText("Attach to an existing service")).not.toBeInTheDocument();
  });

  it("service widget: attach flow requires selecting a service before continuing", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: ["Media"], services: ["Sonarr"] } },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: "Sonarr" } });
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByLabelText("YAML preview")).toHaveValue(SERVICE_ENTRY.yamlExample);
  });

  it("service widget: new-service flow requires name, group, and href before continuing", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: ["Media"], services: ["Sonarr"] } },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Add as a new service")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Add as a new service"));

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Service name"), { target: { value: "Radarr" } });
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: "Media" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "http://radarr.local/" } });

    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });

  it("keeps Install disabled until the risk checkbox is checked, then submits and shows the backup filename", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: [], services: ["Sonarr"] } },
      {
        match: (url, options) => url === "/api/widgets-catalog/install" && options?.method === "POST",
        body: { success: true, backupFile: "services.yaml.bak.2026-08-23T00-00-00-000Z" },
      },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: "Sonarr" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByLabelText("YAML preview");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("button", { name: "Install" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I understand the risk/));
    expect(screen.getByRole("button", { name: "Install" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(screen.getByText(/Installed\. Backup saved as services\.yaml\.bak/)).toBeInTheDocument(),
    );
  });

  it("shows the server's error message inline on a failed install, without closing the dialog", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: [], services: ["Sonarr"] } },
      {
        match: (url, options) => url === "/api/widgets-catalog/install" && options?.method === "POST",
        ok: false,
        body: { error: "Service 'Sonarr' not found" },
      },
    ]);

    const onClose = vi.fn();
    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={onClose} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: "Sonarr" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText("YAML preview");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByLabelText(/I understand the risk/));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(screen.getByText("Service 'Sonarr' not found")).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clears a stale install error when navigating back from confirm and returning without resubmitting", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: [], services: ["Sonarr"] } },
      {
        match: (url, options) => url === "/api/widgets-catalog/install" && options?.method === "POST",
        ok: false,
        body: { error: "Service 'Sonarr' not found" },
      },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: "Sonarr" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText("YAML preview");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByLabelText(/I understand the risk/));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(screen.getByText("Service 'Sonarr' not found")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByLabelText("YAML preview");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByRole("button", { name: "Install" });
    expect(screen.queryByText("Service 'Sonarr' not found")).not.toBeInTheDocument();
  });
});
