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

// Selecting an existing service in "attach" mode always triggers a lookup of
// that service's current widget config - tests that don't care about the
// prefill behavior itself still need to satisfy that fetch, and wait for it
// to resolve before Next stops being disabled.
function noExistingWidgetHandler(serviceName) {
  return { match: (url) => url === `/api/widgets-catalog/services/${serviceName}`, body: { yamlSnippet: null } };
}

async function selectServiceAndContinue(serviceName) {
  await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: serviceName } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
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

  it("shows the widget's catalog description under the title, on both the target and preview steps", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ groups: [], services: ["Sonarr"] }) });

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    expect(await screen.findByText(SERVICE_ENTRY.description)).toBeInTheDocument();

    await selectServiceAndContinue("Sonarr");

    await screen.findByLabelText("YAML preview");
    expect(screen.getByText(SERVICE_ENTRY.description)).toBeInTheDocument();
  });

  it("service widget: attach flow requires selecting a service before continuing", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: ["Media"], services: ["Sonarr"] } },
      noExistingWidgetHandler("Sonarr"),
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await selectServiceAndContinue("Sonarr");
    expect(await screen.findByLabelText("YAML preview")).toHaveValue(SERVICE_ENTRY.yamlExample);
  });

  it("service widget: attach flow disables Next while the existing-widget lookup is in flight", async () => {
    let resolveLookup;
    global.fetch = vi.fn((url) => {
      if (url === "/api/widgets-catalog/services") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: ["Media"], services: ["Sonarr"] }) });
      }
      if (url === "/api/widgets-catalog/services/Sonarr") {
        return new Promise((resolve) => {
          resolveLookup = () => resolve({ ok: true, json: () => Promise.resolve({ yamlSnippet: null }) });
        });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: "Sonarr" } });

    await waitFor(() => expect(resolveLookup).toBeDefined());
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    resolveLookup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled());
  });

  it("service widget: attach flow prefills the preview with the service's existing widget config, not the doc example", async () => {
    const existingYaml = "widget:\n  type: plex\n  url: http://plex.local:32400\n  key: therealkey";
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: ["Media"], services: ["Sonarr"] } },
      { match: (url) => url === "/api/widgets-catalog/services/Sonarr", body: { yamlSnippet: existingYaml } },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await selectServiceAndContinue("Sonarr");

    expect(await screen.findByLabelText("YAML preview")).toHaveValue(existingYaml);
    expect(screen.getByText(/already has a widget configured/)).toBeInTheDocument();
  });

  it("service widget: attach flow keeps user edits when going back to target and forward again without changing the service", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: ["Media"], services: ["Sonarr"] } },
      noExistingWidgetHandler("Sonarr"),
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await selectServiceAndContinue("Sonarr");
    const textarea = await screen.findByLabelText("YAML preview");
    fireEvent.change(textarea, { target: { value: "widget:\n  type: plex\n  key: edited-by-user" } });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByLabelText("Existing service")).toHaveValue("Sonarr"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByLabelText("YAML preview")).toHaveValue("widget:\n  type: plex\n  key: edited-by-user");
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
      noExistingWidgetHandler("Sonarr"),
      {
        match: (url, options) => url === "/api/widgets-catalog/install" && options?.method === "POST",
        body: { success: true, backupFile: "services.yaml.bak.2026-08-23T00-00-00-000Z" },
      },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await selectServiceAndContinue("Sonarr");

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
      noExistingWidgetHandler("Sonarr"),
      {
        match: (url, options) => url === "/api/widgets-catalog/install" && options?.method === "POST",
        ok: false,
        body: { error: "Service 'Sonarr' not found" },
      },
    ]);

    const onClose = vi.fn();
    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={onClose} />);

    await selectServiceAndContinue("Sonarr");
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
      noExistingWidgetHandler("Sonarr"),
      {
        match: (url, options) => url === "/api/widgets-catalog/install" && options?.method === "POST",
        ok: false,
        body: { error: "Service 'Sonarr' not found" },
      },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await selectServiceAndContinue("Sonarr");
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

  it("does not reset user-edited YAML when a new-but-equal entry object is passed while open", async () => {
    const { rerender } = renderWithSWR(<InstallWizardDialog entry={INFO_ENTRY} open onClose={vi.fn()} />);

    const textarea = await screen.findByLabelText("YAML preview");
    fireEvent.change(textarea, { target: { value: "- datetime:\n    text_size: xxl # user edit" } });
    expect(textarea).toHaveValue("- datetime:\n    text_size: xxl # user edit");

    // Same slug/content, but a brand-new object identity - simulates a parent
    // re-render (e.g. WidgetRow's copied/theme state changing) that recreates
    // the entry object literal.
    const sameEntryNewIdentity = { ...INFO_ENTRY };
    expect(sameEntryNewIdentity).not.toBe(INFO_ENTRY);

    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <InstallWizardDialog entry={sameEntryNewIdentity} open onClose={vi.fn()} />
      </SWRConfig>,
    );

    expect(screen.getByLabelText("YAML preview")).toHaveValue("- datetime:\n    text_size: xxl # user edit");
  });
});
