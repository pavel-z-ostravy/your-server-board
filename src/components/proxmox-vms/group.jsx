import classNames from "classnames";
import prettyBytes from "pretty-bytes";
import { useContext } from "react";
import useSWR from "swr";

import { SettingsContext } from "utils/contexts/settings";
import { formatUptime } from "utils/proxmox/uptime";

const STATUS_DOT_CLASS = {
  running: "bg-emerald-500",
  paused: "bg-orange-400",
  stopped: "bg-theme-400",
};

// Same stat-pill classes src/components/services/widget/block.jsx uses, so
// VM/LXC cards read as native Homepage UI. Includes block.jsx's trailing
// "service-block" hook class so custom user CSS targeting it also applies here.
const STAT_CLASS =
  "bg-theme-200/50 dark:bg-theme-900/20 rounded-sm m-1 flex-1 flex flex-col items-center justify-center text-center p-1 service-block";

// Same card wrapper classes src/components/services/item.jsx uses, including its
// trailing "service-card" hook class (custom user CSS / cardBlur target it).
const CARD_CLASS =
  "transition-all mb-2 p-3 rounded-md font-medium text-theme-700 dark:text-theme-200 shadow-md shadow-theme-900/10 dark:shadow-theme-900/20 bg-theme-100/20 dark:bg-white/5 relative overflow-clip service-card";

// Throw on non-ok responses so SWR's `error` populates correctly instead of
// resolving "successfully" with an API error body (e.g. { error: "..." } from a
// 500), which would otherwise make `vms` a non-array and crash render.
const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function formatCapacity(usedBytes, totalBytes) {
  if (usedBytes == null) {
    // QEMU VMs don't have real per-guest disk usage available (out of scope
    // for this feature), but the route still returns the allocated size
    // (maxdisk) for every VM. Show that instead of discarding it as "-".
    return totalBytes == null ? null : `${prettyBytes(totalBytes)} (allocated)`;
  }
  if (totalBytes == null) return null;
  return `${prettyBytes(usedBytes)} / ${prettyBytes(totalBytes)}`;
}

function Stat({ value, label }) {
  return (
    <div className={STAT_CLASS}>
      <div className="font-thin text-sm">{value === null || value === undefined ? "-" : value}</div>
      <div className="font-bold text-xs uppercase">{label}</div>
    </div>
  );
}

function VmCard({ vm, cardClassName }) {
  const cpuValue = `${vm.cpuUsedCores.toFixed(2)} / ${vm.cpuTotalCores}`;
  const memValue = formatCapacity(vm.memUsedBytes, vm.memTotalBytes);
  const diskValue = formatCapacity(vm.diskUsedBytes, vm.diskTotalBytes);

  return (
    <div className={cardClassName} data-testid="vm-card" data-status={vm.status}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-sm">{vm.name}</span>
          <p className="text-theme-500 dark:text-theme-300 text-xs font-light">
            {vm.type.toUpperCase()} &middot; {formatUptime(vm.uptimeSeconds)}
          </p>
        </div>
        <span
          className={classNames("w-2.5 h-2.5 rounded-full", STATUS_DOT_CLASS[vm.status] ?? STATUS_DOT_CLASS.stopped)}
        />
      </div>
      <div className="flex flex-row">
        <Stat value={cpuValue} label="CPU" />
        <Stat value={memValue} label="RAM" />
        <Stat value={diskValue} label="Disk" />
      </div>
      <p className="text-theme-500 dark:text-theme-300 text-xs font-light mt-2">
        {vm.ipAddress ?? "-"} &middot; {vm.macAddress ?? "-"} &middot; {vm.osName ?? "-"}
      </p>
    </div>
  );
}

export default function ProxmoxVmsGroup() {
  // SettingsContext has no default value, so useContext returns undefined when
  // this renders outside _app.jsx's SettingsProvider (e.g. isolated unit
  // tests) — guard rather than destructure directly off the context result.
  const settingsContext = useContext(SettingsContext);
  const settings = settingsContext?.settings ?? {};

  // Same cardBlur handling src/components/services/item.jsx applies to its card
  // wrapper, so these cards respect the user's cardBlur setting too.
  const cardClassName = classNames(
    settings.cardBlur !== undefined && `backdrop-blur${settings.cardBlur.length ? "-" : ""}${settings.cardBlur}`,
    CARD_CLASS,
  );

  // Explicit fetcher (matches the global default in src/pages/_app.jsx) rather than
  // relying solely on the ancestor SWRConfig: the ancestor config only reaches this
  // hook when this component is actually rendered inside _app.jsx's SWRConfig
  // provider, which isolated unit tests do not render. Behavior is identical in
  // the running app either way.
  const {
    data: vms,
    error,
    mutate,
    isValidating,
  } = useSWR("/api/proxmox/vms", fetcher, {
    refreshInterval: 60000,
  });

  return (
    <div id="proxmox-vms-group" className="flex flex-col m-4 sm:m-8 sm:mt-4 mb-2">
      <div className="flex items-center justify-between">
        <h2 className="flex text-theme-800 dark:text-theme-300 text-xl font-medium service-group-name">
          Virtual Machines
        </h2>
        <button
          type="button"
          onClick={() => mutate()}
          disabled={isValidating}
          className="text-sm text-theme-500 dark:text-theme-300 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-rose-500/80">Failed to load VM/LXC data.</p>}
      {!vms && !error && <p className="text-theme-500 dark:text-theme-300 text-sm">Loading...</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {Array.isArray(vms) && vms.map((vm) => <VmCard key={vm.vmid} vm={vm} cardClassName={cardClassName} />)}
      </div>
    </div>
  );
}
