import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";
import useSWR from "swr";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function initialState(entry) {
  return {
    step: entry?.category === "service" ? "target" : "preview",
    targetMode: "attach",
    attachServiceName: "",
    newServiceName: "",
    newGroupName: "",
    newGroupCustom: "",
    newHref: "",
    newDescription: "",
    yamlText: entry?.yamlExample ?? "",
    acknowledged: false,
    submitting: false,
    result: null,
  };
}

export default function InstallWizardDialog({ entry, open, onClose }) {
  const [state, setState] = useState(() => initialState(entry));

  useEffect(() => {
    if (open) setState(initialState(entry));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry?.slug]);

  const { data: servicesData } = useSWR(
    open && entry?.category === "service" ? "/api/widgets-catalog/services" : null,
    fetcher,
  );

  const update = (patch) => setState((prev) => ({ ...prev, ...patch }));
  const handleClose = () => {
    if (!state.submitting) onClose();
  };

  const groupName = state.newGroupName === "__new__" ? state.newGroupCustom : state.newGroupName;

  const buildBody = () => {
    if (entry.category === "info") {
      return { category: "info", yamlSnippet: state.yamlText };
    }
    if (state.targetMode === "attach") {
      return {
        category: "service",
        mode: "attach",
        serviceName: state.attachServiceName,
        yamlSnippet: state.yamlText,
      };
    }
    return {
      category: "service",
      mode: "new",
      serviceName: state.newServiceName,
      groupName,
      href: state.newHref,
      description: state.newDescription,
      yamlSnippet: state.yamlText,
    };
  };

  const handleInstall = async () => {
    update({ submitting: true });
    try {
      const res = await fetch("/api/widgets-catalog/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const body = await res.json();
      if (!res.ok) {
        update({ submitting: false, result: { error: body.error ?? "Install failed" } });
        return;
      }
      update({ submitting: false, step: "result", result: { success: true, backupFile: body.backupFile } });
    } catch {
      update({ submitting: false, result: { error: "Network error - install failed" } });
    }
  };

  if (!entry) return null;

  const targetNextDisabled =
    state.targetMode === "attach" ? !state.attachServiceName : !state.newServiceName || !groupName || !state.newHref;

  return (
    <Dialog open={open} onClose={handleClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-md bg-theme-100 dark:bg-theme-800 p-6 text-theme-700 dark:text-theme-200">
          <DialogTitle className="text-lg font-medium mb-1">Install {entry.title}</DialogTitle>
          {entry.description && <p className="text-sm text-theme-500 dark:text-theme-300 mb-4">{entry.description}</p>}

          {state.step === "target" && (
            <div>
              <label className="flex items-center gap-2 mb-2">
                <input
                  type="radio"
                  name="targetMode"
                  checked={state.targetMode === "attach"}
                  onChange={() => update({ targetMode: "attach" })}
                />
                Attach to an existing service
              </label>
              <label className="flex items-center gap-2 mb-2">
                <input
                  type="radio"
                  name="targetMode"
                  checked={state.targetMode === "new"}
                  onChange={() => update({ targetMode: "new" })}
                />
                Add as a new service
              </label>

              {state.targetMode === "attach" && (
                <select
                  aria-label="Existing service"
                  value={state.attachServiceName}
                  onChange={(e) => update({ attachServiceName: e.target.value })}
                  className="w-full mt-2 px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                >
                  <option value="">Select a service...</option>
                  {(servicesData?.services ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}

              {state.targetMode === "new" && (
                <div className="flex flex-col gap-2 mt-2">
                  <input
                    aria-label="Service name"
                    placeholder="Service name"
                    value={state.newServiceName}
                    onChange={(e) => update({ newServiceName: e.target.value })}
                    className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                  />
                  <select
                    aria-label="Group"
                    value={state.newGroupName}
                    onChange={(e) => update({ newGroupName: e.target.value })}
                    className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                  >
                    <option value="">Select a group...</option>
                    {(servicesData?.groups ?? []).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                    <option value="__new__">+ New group</option>
                  </select>
                  {state.newGroupName === "__new__" && (
                    <input
                      aria-label="New group name"
                      placeholder="New group name"
                      value={state.newGroupCustom}
                      onChange={(e) => update({ newGroupCustom: e.target.value })}
                      className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                    />
                  )}
                  <input
                    aria-label="URL"
                    placeholder="http://..."
                    value={state.newHref}
                    onChange={(e) => update({ newHref: e.target.value })}
                    className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                  />
                  <input
                    aria-label="Description"
                    placeholder="Description (optional)"
                    value={state.newDescription}
                    onChange={(e) => update({ newDescription: e.target.value })}
                    className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 mt-4">
                <button type="button" onClick={handleClose} className="text-sm px-3 py-1.5">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => update({ step: "preview" })}
                  disabled={targetNextDisabled}
                  className="text-sm px-3 py-1.5 rounded-md bg-theme-300/70 dark:bg-theme-900/70 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {state.step === "preview" && (
            <div>
              <p className="text-sm mb-2">Review and edit the YAML before installing:</p>
              <textarea
                aria-label="YAML preview"
                value={state.yamlText}
                onChange={(e) => update({ yamlText: e.target.value })}
                rows={8}
                className="w-full font-mono text-xs p-3 rounded-md bg-theme-200/50 dark:bg-theme-900/20"
              />
              <div className="flex justify-end gap-2 mt-4">
                {entry.category === "service" && (
                  <button
                    type="button"
                    onClick={() => update({ step: "target" })}
                    className="text-sm px-3 py-1.5 mr-auto"
                  >
                    Back
                  </button>
                )}
                <button type="button" onClick={handleClose} className="text-sm px-3 py-1.5">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => update({ step: "confirm" })}
                  disabled={!state.yamlText.trim()}
                  className="text-sm px-3 py-1.5 rounded-md bg-theme-300/70 dark:bg-theme-900/70 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {state.step === "confirm" && (
            <div>
              <p className="text-sm mb-3">
                This will write directly to your <code>services.yaml</code>/<code>widgets.yaml</code> config file on the
                server. A backup copy is created automatically before any change, but Homepage&apos;s behavior after
                this change is your responsibility.
              </p>
              <label className="flex items-center gap-2 text-sm mb-4">
                <input
                  type="checkbox"
                  checked={state.acknowledged}
                  onChange={(e) => update({ acknowledged: e.target.checked })}
                />
                I understand the risk and want to proceed.
              </label>
              {state.result?.error && <p className="text-rose-500/80 text-sm mb-3">{state.result.error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => update({ step: "preview", result: null })}
                  className="text-sm px-3 py-1.5 mr-auto"
                >
                  Back
                </button>
                <button type="button" onClick={handleClose} className="text-sm px-3 py-1.5">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleInstall}
                  disabled={!state.acknowledged || state.submitting}
                  className="text-sm px-3 py-1.5 rounded-md bg-theme-300/70 dark:bg-theme-900/70 disabled:opacity-50"
                >
                  {state.submitting ? "Installing..." : "Install"}
                </button>
              </div>
            </div>
          )}

          {state.step === "result" && state.result?.success && (
            <div>
              <p className="text-sm mb-4">Installed. Backup saved as {state.result.backupFile}.</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleClose}
                  className="text-sm px-3 py-1.5 rounded-md bg-theme-300/70 dark:bg-theme-900/70"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
