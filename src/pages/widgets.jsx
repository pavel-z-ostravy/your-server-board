import { Highlight, themes } from "prism-react-renderer";
import { useContext, useMemo, useRef, useState } from "react";
import useSWR from "swr";

import InstallWizardDialog from "components/widgets/InstallWizardDialog";
import { ThemeContext } from "utils/contexts/theme";

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

function WidgetRow({ entry, category }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const preRef = useRef(null);
  const themeContext = useContext(ThemeContext);
  const dialogEntry = useMemo(() => ({ ...entry, category }), [entry, category]);

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
    <li className="border-b border-theme-300/30 dark:border-theme-500/10 py-2">
      <button type="button" onClick={() => setExpanded((prev) => !prev)} className="w-full text-left">
        <span className="text-sm font-medium">{entry.title}</span>
        <p className="text-theme-500 dark:text-theme-300 text-xs font-light">{entry.description}</p>
      </button>
      {expanded && (
        <div className="mt-2 text-xs">
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
                <WidgetRow key={entry.slug} entry={entry} category="service" />
              ))}
          </ul>

          <h2 className="text-sm font-medium mt-4">Info Widgets</h2>
          <ul>
            {data.info
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow key={entry.slug} entry={entry} category="info" />
              ))}
          </ul>
        </>
      )}
    </div>
  );
}
