import { useState } from "react";
import useSWR from "swr";

import BackupList from "./backup-list";

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

export default function VmList() {
  const { data: vms, error } = useSWR("/api/proxmox/vms", fetcher);
  const [expanded, setExpanded] = useState(null);

  if (error) {
    return <p className="text-sm text-rose-500/80">Failed to load VMs/CTs.</p>;
  }

  if (!vms) {
    return <p className="text-sm">Loading...</p>;
  }

  return (
    <ul>
      {vms.map((vm) => {
        const key = `${vm.node}/${vm.vmid}`;
        const isExpanded = expanded === key;
        return (
          <li key={key} className={CARD_CLASS}>
            <button
              type="button"
              onClick={() => setExpanded(isExpanded ? null : key)}
              className="w-full flex justify-between items-center text-sm font-bold"
            >
              <span>{vm.name}</span>
              <span className="text-xs font-normal uppercase text-theme-500 dark:text-theme-400">{vm.type}</span>
            </button>
            {isExpanded && (
              <div className="mt-3">
                <BackupList node={vm.node} vmid={String(vm.vmid)} vmName={vm.name} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
