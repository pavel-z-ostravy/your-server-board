// src/components/backups/run-backup-dialog.jsx
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";
import useSWR, { SWRConfig } from "swr";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

const POLL_INTERVAL_MS = 2000;

// Give each dialog instance its own SWR cache instead of sharing the global
// one. Without this, reusing the same storages key across multiple mounts
// (e.g. opening the dialog for the same node twice) can serve stale cached
// data instead of issuing a fresh request.
const swrCacheProvider = () => new Map();

export default function RunBackupDialog(props) {
  return (
    <SWRConfig value={{ provider: swrCacheProvider }}>
      <RunBackupDialogInner {...props} />
    </SWRConfig>
  );
}

function RunBackupDialogInner({ open, node, vmid, onClose, onDone }) {
  const [storage, setStorage] = useState("");
  const [upid, setUpid] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const { data: storagesData } = useSWR(
    open ? `/api/proxmox/backups/storages?node=${encodeURIComponent(node)}` : null,
    fetcher,
  );

  useEffect(() => {
    if (open) {
      setStorage("");
      setUpid(null);
      setResult(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!upid) return undefined;
    const interval = setInterval(async () => {
      const res = await fetch(
        `/api/proxmox/backups/status?node=${encodeURIComponent(node)}&upid=${encodeURIComponent(upid)}`,
      );
      const body = await res.json();
      if (body.status !== "running") {
        clearInterval(interval);
        setResult(body);
        if (body.exitstatus === "OK") onDone();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [upid, node, onDone]);

  const handleStart = async () => {
    setError(null);
    const res = await fetch("/api/proxmox/backups/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node, vmid, storage }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Failed to start backup");
      return;
    }
    setUpid(body.upid);
  };

  const handleClose = () => {
    if (!upid || result) onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-md bg-theme-100 dark:bg-theme-800 p-4 space-y-3">
          <DialogTitle className="text-sm font-bold">Back up now</DialogTitle>
          {!upid && (
            <>
              <select
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                className="w-full rounded-sm border border-theme-300 dark:border-theme-700 bg-transparent px-2 py-1 text-xs"
              >
                <option value="">Select a storage...</option>
                {(storagesData?.storages ?? []).map((s) => (
                  <option key={s.storage} value={s.storage}>
                    {s.storage}
                  </option>
                ))}
              </select>
              {error && <p className="text-xs text-rose-500/80">{error}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className="text-xs px-2 py-1">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={!storage}
                  className="text-xs px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Start
                </button>
              </div>
            </>
          )}
          {upid && !result && <p className="text-xs">Backup running...</p>}
          {result && (
            <>
              <p className="text-xs">
                {result.exitstatus === "OK" ? "Backup completed." : `Backup failed: ${result.exitstatus}`}
              </p>
              <div className="flex justify-end">
                <button type="button" onClick={onClose} className="text-xs px-2 py-1">
                  Close
                </button>
              </div>
            </>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
