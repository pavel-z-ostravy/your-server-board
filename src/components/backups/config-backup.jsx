// Same card wrapper classes src/components/disks/group.jsx and
// src/components/services/item.jsx use, including the trailing "service-card"
// hook class, so this page reads as native dashboard UI rather than a
// separate list-y page.
const CARD_CLASS =
  "transition-all mb-2 p-3 rounded-md font-medium text-theme-700 dark:text-theme-200 border border-theme-300/30 dark:border-theme-500/20 shadow-md shadow-theme-900/20 dark:shadow-theme-900/40 bg-theme-100/30 dark:bg-white/10 relative overflow-clip service-card";

// Unlike VM/CT backups, a Proxmox config backup (a tar of /etc/pve - the
// cluster/storage/VM-config filesystem, not a VM/CT disk image) is tiny and
// cheap to generate, so there's no list/run/delete lifecycle here - just a
// fresh archive streamed on demand.
export default function ConfigBackup() {
  return (
    <div className={CARD_CLASS}>
      <div className="flex justify-between items-center">
        <div>
          <span className="text-sm font-bold">Proxmox Configuration</span>
          <p className="text-xs font-normal text-theme-500 dark:text-theme-400">
            A fresh archive of /etc/pve (cluster, storage, and VM config) - not a VM/CT backup.
          </p>
        </div>
        <a
          href="/api/proxmox/backups/config-download"
          download
          className="text-xs px-2 py-1 rounded-sm bg-theme-200/50 dark:bg-theme-900/40"
        >
          Download
        </a>
      </div>
    </div>
  );
}
