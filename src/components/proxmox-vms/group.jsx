import classNames from "classnames";
import prettyBytes from "pretty-bytes";
import { useContext, useState } from "react";
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

// Header block above the VM/LXC card grid, showing the Proxmox host's own
// status - the "parent" row for the "children" grid below it. `status` and
// `error` come from an independent SWR call in ProxmoxVmsGroup, so a
// host-status failure never blocks the VM grid from rendering.
function NodeStatusHeader({ status, error }) {
  if (error) {
    return <p className="text-rose-500/80 text-sm mb-2">Failed to load Proxmox host status.</p>;
  }
  if (!status) {
    return <p className="text-theme-500 dark:text-theme-300 text-sm mb-2">Loading host status...</p>;
  }

  const cpuValue = status.cpuUsedCores == null ? null : `${status.cpuUsedCores.toFixed(2)} / ${status.cpuTotalCores}`;
  const memValue = formatCapacity(status.memUsedBytes, status.memTotalBytes);
  const diskValue = formatCapacity(status.diskUsedBytes, status.diskTotalBytes);
  const loadAvgText = Array.isArray(status.loadAvg) ? status.loadAvg.map((n) => n.toFixed(2)).join(" / ") : "-";

  return (
    <div
      className="mb-2 pb-2 border-b border-theme-300/30 dark:border-theme-500/10"
      data-testid="node-status-header"
      data-status={status.status}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium">Proxmox Host</span>
        <div className="flex items-center gap-2">
          {status.status === "online" && status.uptimeSeconds != null && (
            <span className="text-theme-500 dark:text-theme-300 text-xs font-light">
              {formatUptime(status.uptimeSeconds)}
            </span>
          )}
          <span
            className={classNames(
              "w-2.5 h-2.5 rounded-full",
              STATUS_DOT_CLASS[status.status === "online" ? "running" : "stopped"],
            )}
          />
        </div>
      </div>
      <div className="flex flex-row">
        <Stat value={cpuValue} label="CPU" />
        <Stat value={memValue} label="RAM" />
        <Stat value={diskValue} label="Disk" />
      </div>
      <p className="text-theme-500 dark:text-theme-300 text-xs font-light mt-2">
        {status.pveVersion ? `PVE ${status.pveVersion}` : "-"} &middot; load {loadAvgText}
      </p>
    </div>
  );
}

function VmCard({ vm, cardClassName }) {
  const cpuValue = `${vm.cpuUsedCores.toFixed(2)} / ${vm.cpuTotalCores}`;
  const memValue = formatCapacity(vm.memUsedBytes, vm.memTotalBytes);
  const diskValue = formatCapacity(vm.diskUsedBytes, vm.diskTotalBytes);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);

  // Fetch-on-first-expand: the detail request only fires the first time the
  // card is opened. Subsequent toggles (close/reopen) reuse the cached
  // `detail` state rather than re-hitting the API. A failed fetch (non-ok
  // response or a rejected promise, e.g. network failure) leaves `detail`
  // null and sets `detailError` instead — the guard above then allows a
  // retry on the next close/reopen, since only a *successful* fetch should
  // ever be permanently cached.
  const toggleDetail = async () => {
    if (detailOpen) {
      setDetailOpen(false);
      return;
    }
    setDetailOpen(true);
    if (detail || detailLoading) return;
    setDetailLoading(true);
    setDetailError(false);
    try {
      const res = await fetch(`/api/proxmox/vm-detail?type=${vm.type}&node=${vm.node}&vmid=${vm.vmid}`);
      if (res.ok) {
        setDetail(await res.json());
      } else {
        setDetailError(true);
      }
    } catch {
      setDetailError(true);
    } finally {
      setDetailLoading(false);
    }
  };

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
      <button type="button" onClick={toggleDetail} className="text-xs text-theme-500 dark:text-theme-300 mt-2">
        Details
      </button>
      {detailOpen && (
        <div className="mt-2 text-xs">
          {detailLoading && <p className="text-theme-500 dark:text-theme-300">Loading...</p>}
          {detailError && <p className="text-rose-500/80">Failed to load details.</p>}
          {detail && (
            <>
              {detail.processes.length > 0 ? (
                <ul>
                  {detail.processes.map((p) => (
                    <li key={p.pid}>
                      <span>{p.command}</span> — {p.cpuPercent}% CPU
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-theme-500 dark:text-theme-300">No process data available.</p>
              )}
              <p className="text-theme-500 dark:text-theme-300 mt-1">
                Last update: {detail.lastUpdate ? new Date(detail.lastUpdate).toLocaleDateString() : "N/A"}
              </p>
            </>
          )}
        </div>
      )}
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

  // Independent SWR call from the VM list above - a host-status failure must
  // never blank out the VM grid, and vice versa (see NodeStatusHeader).
  const {
    data: hostStatus,
    error: hostError,
    mutate: mutateHost,
    isValidating: hostValidating,
  } = useSWR("/api/proxmox/host", fetcher, {
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
          onClick={() => {
            mutate();
            mutateHost();
          }}
          disabled={isValidating || hostValidating}
          className="text-sm text-theme-500 dark:text-theme-300 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      <NodeStatusHeader status={hostStatus} error={hostError} />

      {error && <p className="text-rose-500/80">Failed to load VM/LXC data.</p>}
      {!vms && !error && <p className="text-theme-500 dark:text-theme-300 text-sm">Loading...</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {Array.isArray(vms) && vms.map((vm) => <VmCard key={vm.vmid} vm={vm} cardClassName={cardClassName} />)}
      </div>
    </div>
  );
}
