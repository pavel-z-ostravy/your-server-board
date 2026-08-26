// src/components/backups/backup-list.jsx
import { useState } from "react";
import useSWR, { mutate } from "swr";

import DeleteConfirmDialog from "./delete-confirm-dialog";
import RunBackupDialog from "./run-backup-dialog";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(ctime) {
  if (!ctime) return "-";
  return new Date(ctime * 1000).toLocaleString();
}

export default function BackupList({ node, vmid, vmName }) {
  const listKey = `/api/proxmox/backups/list?node=${encodeURIComponent(node)}&vmid=${encodeURIComponent(vmid)}`;
  const { data, error } = useSWR(listKey, fetcher);
  const [runOpen, setRunOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const handleDelete = async (volid) => {
    const res = await fetch(
      `/api/proxmox/backups/delete?node=${encodeURIComponent(node)}&volid=${encodeURIComponent(volid)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error ?? "Failed to delete backup" };
    }
    await mutate(listKey);
    return { ok: true };
  };

  if (error) {
    return <p className="text-xs text-rose-500/80">Failed to load backups.</p>;
  }

  if (!data) {
    return <p className="text-xs">Loading backups...</p>;
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setRunOpen(true)}
        className="text-xs px-2 py-1 rounded-sm bg-theme-200/50 dark:bg-theme-900/40"
      >
        Back up now
      </button>
      {data.backups.length === 0 ? (
        <p className="text-xs">No backups found.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left">
              <th>Date</th>
              <th>Size</th>
              <th>Storage</th>
              <th>Retention</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data.backups.map((b) => (
              <tr key={b.volid}>
                <td>{formatDate(b.ctime)}</td>
                <td>{formatBytes(b.size)}</td>
                <td>{b.storage}</td>
                <td>{b.prunePolicy ?? "-"}</td>
                <td className="flex gap-2">
                  <a
                    href={`/api/proxmox/backups/download?volid=${encodeURIComponent(b.volid)}`}
                    download
                    className="text-theme-500 dark:text-theme-300"
                  >
                    Download
                  </a>
                  <button type="button" onClick={() => setDeleteTarget(b.volid)} className="text-rose-500/80">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <RunBackupDialog
        open={runOpen}
        node={node}
        vmid={vmid}
        onClose={() => setRunOpen(false)}
        onDone={() => mutate(listKey)}
      />
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        vmName={vmName}
        onConfirm={() => handleDelete(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
