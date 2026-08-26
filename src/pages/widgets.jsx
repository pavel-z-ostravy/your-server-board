import { Highlight, themes } from "prism-react-renderer";
import { useContext, useMemo, useRef, useState } from "react";
import { BiTrash } from "react-icons/bi";
import useSWR from "swr";

import InstallWizardDialog from "components/widgets/InstallWizardDialog";
import { ThemeContext } from "utils/contexts/theme";

// Same card wrapper classes src/components/disks/group.jsx and
// src/components/services/item.jsx use, including the trailing "service-card"
// hook class, so this page reads as native dashboard UI rather than a
// separate list-y page.
const CARD_CLASS =
  "transition-all mb-2 p-3 rounded-md font-medium text-theme-700 dark:text-theme-200 shadow-md shadow-theme-900/10 dark:shadow-theme-900/20 bg-theme-100/20 dark:bg-white/5 relative overflow-clip service-card";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function matchesQuery(entry, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return entry.title.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
}

function InstalledInstanceRow({ label, onRemove }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(null);

  const handleRemove = async () => {
    setRemoving(true);
    setError(null);
    const result = await onRemove();
    setRemoving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setConfirming(false);
  };

  const handleCancel = () => {
    setConfirming(false);
    setError(null);
  };

  return (
    <li className="flex items-center justify-between gap-2 py-0.5 text-xs">
      <span>{label}</span>
      {confirming ? (
        <span className="flex items-center gap-2">
          {error && <span className="text-rose-500/80">{error}</span>}
          <button type="button" onClick={handleRemove} disabled={removing} className="text-rose-500/80">
            {removing ? "Removing..." : "Remove?"}
          </button>
          <button type="button" onClick={handleCancel} disabled={removing}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} aria-label={`Remove ${label}`}>
          <BiTrash size={14} />
        </button>
      )}
    </li>
  );
}

function WidgetRow({ entry, category, installed, mutateInstalled }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const preRef = useRef(null);
  const themeContext = useContext(ThemeContext);
  const dialogEntry = useMemo(() => ({ ...entry, category }), [entry, category]);

  const installedServiceNames = category === "service" ? (installed?.services?.[entry.slug] ?? []) : [];
  const installedInfoInstances = category === "info" ? (installed?.info?.[entry.slug] ?? []) : [];
  const hasInstalled = installedServiceNames.length > 0 || installedInfoInstances.length > 0;

  const removeInstance = async (body) => {
    try {
      const res = await fetch("/api/widgets-catalog/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const resBody = await res.json().catch(() => ({}));
        return { ok: false, error: resBody.error ?? "Failed to remove widget" };
      }
      await mutateInstalled();
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error - failed to remove widget" };
    }
  };

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(entry.yamlExample);
      } else if (preRef.current) {
        const range = document.createRange();
        range.selectNodeContents(preRef.current);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <li className={CARD_CLASS}>
      <button type="button" onClick={() => setExpanded((prev) => !prev)} className="w-full text-left">
        <span className="text-sm font-medium">{entry.title}</span>
        <p className="text-theme-500 dark:text-theme-300 text-xs font-light">{entry.description}</p>
      </button>
      {expanded && (
        <div className="mt-2 text-xs">
          {hasInstalled && (
            <div className="mb-2">
              <p className="font-medium mb-1">Installed on:</p>
              <ul>
                {installedServiceNames.map((name) => (
                  <InstalledInstanceRow
                    key={name}
                    label={name}
                    onRemove={() => removeInstance({ category: "service", serviceName: name })}
                  />
                ))}
                {installedInfoInstances.map(({ index, fingerprint }, i) => (
                  <InstalledInstanceRow
                    key={index}
                    label={`Instance #${i + 1}`}
                    onRemove={() => removeInstance({ category: "info", slug: entry.slug, index, fingerprint })}
                  />
                ))}
              </ul>
            </div>
          )}
          {entry.yamlExample ? (
            <>
              <Highlight
                theme={themeContext?.theme === "light" ? themes.github : themes.nightOwl}
                code={entry.yamlExample}
                language="yaml"
              >
                {({ style, tokens, getLineProps, getTokenProps }) => (
                  <pre ref={preRef} style={style} className="rounded-md p-3 overflow-x-auto text-xs">
                    {tokens.map((line, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <div key={i} {...getLineProps({ line })}>
                        {line.map((token, key) => (
                          // eslint-disable-next-line react/no-array-index-key
                          <span key={key} {...getTokenProps({ token })} />
                        ))}
                      </div>
                    ))}
                  </pre>
                )}
              </Highlight>
              <div className="flex gap-3 mt-2">
                <button type="button" onClick={handleCopy} className="text-xs text-theme-500 dark:text-theme-300">
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => setInstallOpen(true)}
                  className="text-xs text-theme-500 dark:text-theme-300"
                >
                  Install...
                </button>
              </div>
              <InstallWizardDialog entry={dialogEntry} open={installOpen} onClose={() => setInstallOpen(false)} />
            </>
          ) : (
            <p className="text-theme-500 dark:text-theme-300">No example available.</p>
          )}
        </div>
      )}
    </li>
  );
}

export default function WidgetsPage() {
  const { data, error } = useSWR("/api/widgets-catalog", fetcher);
  const { data: installed, mutate: mutateInstalled } = useSWR("/api/widgets-catalog/installed", fetcher);
  const [query, setQuery] = useState("");

  return (
    <div className="flex flex-col m-4 sm:m-8 sm:mt-16 mb-2">
      <h1 className="text-theme-800 dark:text-theme-300 text-xl font-medium mb-4">Widgets</h1>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search widgets..."
        className="mb-4 px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
      />

      {error && <p className="text-rose-500/80">Failed to load widget catalog.</p>}
      {!data && !error && <p className="text-theme-500 dark:text-theme-300 text-sm">Loading...</p>}

      {data && (
        <>
          <h2 className="text-sm font-medium mt-2">Service Widgets</h2>
          <ul>
            {data.services
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow
                  key={entry.slug}
                  entry={entry}
                  category="service"
                  installed={installed}
                  mutateInstalled={mutateInstalled}
                />
              ))}
          </ul>

          <h2 className="text-sm font-medium mt-4">Info Widgets</h2>
          <ul>
            {data.info
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow
                  key={entry.slug}
                  entry={entry}
                  category="info"
                  installed={installed}
                  mutateInstalled={mutateInstalled}
                />
              ))}
          </ul>
        </>
      )}
    </div>
  );
}
