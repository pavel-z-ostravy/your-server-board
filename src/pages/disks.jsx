// src/pages/disks.jsx
import classNames from "classnames";
import Head from "next/head";
import Link from "next/link";
import useSWR from "swr";

const STATUS_DOT_CLASS = {
  ok: "bg-emerald-500",
  warn: "bg-orange-400",
  critical: "bg-rose-500",
};

// Same stat-pill classes src/components/services/widget/block.jsx uses, so
// disk cards read as native Homepage UI rather than a bolted-on page.
const STAT_CLASS =
  "bg-theme-200/50 dark:bg-theme-900/20 rounded-sm m-1 flex-1 flex flex-col items-center justify-center text-center p-1";

// Same card wrapper classes src/components/services/item.jsx uses.
const CARD_CLASS =
  "transition-all mb-2 p-3 rounded-md font-medium text-theme-700 dark:text-theme-200 shadow-md shadow-theme-900/10 dark:shadow-theme-900/20 bg-theme-100/20 dark:bg-white/5 relative overflow-clip";

function Stat({ value, label }) {
  return (
    <div className={STAT_CLASS}>
      <div className="font-thin text-sm">{value === null || value === undefined ? "-" : value}</div>
      <div className="font-bold text-xs uppercase">{label}</div>
    </div>
  );
}

function DiskCard({ disk }) {
  if (disk.error) {
    return (
      <div className={CARD_CLASS} data-testid="disk-card" data-status="error">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm">{disk.name}</span>
          <span className={classNames("w-2.5 h-2.5 rounded-full", STATUS_DOT_CLASS.critical)} />
        </div>
        <p className="text-rose-500/80 text-xs">{disk.error}</p>
      </div>
    );
  }

  const wearOrReallocated =
    disk.wearPercentage !== null ? `${disk.wearPercentage}%` : (disk.reallocatedSectors ?? "-");

  return (
    <div className={CARD_CLASS} data-testid="disk-card" data-status={disk.status}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-sm">{disk.name}</span>
          <p className="text-theme-500 dark:text-theme-300 text-xs font-light">
            {disk.model} &middot; {disk.size}
          </p>
        </div>
        <span className={classNames("w-2.5 h-2.5 rounded-full", STATUS_DOT_CLASS[disk.status])} />
      </div>
      <div className="flex flex-row">
        <Stat value={disk.temperature !== null ? `${disk.temperature}°C` : null} label="Temp" />
        <Stat value={disk.smartPassed === null ? null : disk.smartPassed ? "PASSED" : "FAILED"} label="SMART" />
        <Stat value={wearOrReallocated} label={disk.wearPercentage !== null ? "Wear" : "Realloc"} />
      </div>
    </div>
  );
}

export default function DisksPage() {
  // Explicit fetcher (matches the global default in src/pages/_app.jsx) rather than
  // relying solely on the ancestor SWRConfig: the ancestor config only reaches this
  // hook when this page is actually rendered inside _app.jsx's SWRConfig provider,
  // which isolated unit tests for this page do not render. Behavior is identical
  // in the running app either way.
  const { data: disks, error } = useSWR("/api/disks", (url) => fetch(url).then((r) => r.json()), {
    refreshInterval: 60000,
  });

  return (
    <>
      <Head>
        <title>Disks &amp; SMART</title>
      </Head>
      <div className="container relative m-auto flex flex-col justify-start z-10 min-h-screen p-4">
        <div className="flex items-center justify-between mb-4">
          <Link href="/" className="text-sm text-theme-500 dark:text-theme-300">
            &larr; Dashboard
          </Link>
          <button type="button" onClick={() => window.location.reload()} className="text-sm">
            Refresh
          </button>
        </div>

        {error && <p className="text-rose-500/80">Failed to load disk data.</p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {(disks ?? []).map((disk) => (
            <DiskCard key={disk.name} disk={disk} />
          ))}
        </div>
      </div>
    </>
  );
}
