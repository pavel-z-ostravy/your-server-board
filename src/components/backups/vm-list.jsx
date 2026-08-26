import { useState } from "react";
import useSWR from "swr";

import BackupList from "./backup-list";

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
    <ul className="space-y-2">
      {vms.map((vm) => {
        const key = `${vm.node}/${vm.vmid}`;
        const isExpanded = expanded === key;
        return (
          <li key={key} className="rounded-md bg-theme-200/50 dark:bg-theme-900/20 p-2">
            <button
              type="button"
              onClick={() => setExpanded(isExpanded ? null : key)}
              className="w-full flex justify-between items-center text-sm font-bold"
            >
              <span>{vm.name}</span>
              <span className="text-xs font-normal">{vm.type}</span>
            </button>
            {isExpanded && (
              <div className="mt-2">
                <BackupList node={vm.node} vmid={String(vm.vmid)} vmName={vm.name} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
