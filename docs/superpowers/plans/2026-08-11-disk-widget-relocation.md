# Disk Widget Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move disk health from the standalone `/disks` page onto the main dashboard as its own widget section, with zero backend changes — pure UI relocation.

**Architecture:** Extract the existing `DiskCard`/`Stat` components and data-fetching logic out of `src/pages/disks.jsx` into a standalone `DisksGroup` component, render it directly in `src/pages/index.jsx` alongside the existing service groups, then delete the now-unused page and its nav link. `/api/disks` (built in the Disks & SMART plan) is untouched — this plan only moves which React tree consumes it.

**Tech Stack:** Next.js 16 (Pages Router), React 19, Vitest, SWR (unchanged from the existing `/disks` page).

## Global Constraints

- Node 22, pnpm only — never npm/yarn.
- Test via `pnpm test` (Vitest, `vitest run`).
- No changes to `/api/disks`, `src/utils/disks/health.js`, or the restricted SSH client — this plan is UI-only. (Real used/total capacity is a separate follow-up plan.)
- Visual style must match existing service groups exactly — reuse the same heading class (`src/components/services/group.jsx`'s `<h2>` classes) and the same card/stat-pill classes already established for disk cards.

---

### Task 1: Extract `DisksGroup` component

**Files:**
- Create: `src/components/disks/group.jsx`
- Test: `src/components/disks/group.test.jsx`

**Interfaces:**
- Consumes: `GET /api/disks` (unchanged, existing route from the Disks & SMART plan).
- Produces: `export default function DisksGroup()` — a self-contained component (own SWR fetch, own loading/error states, own grid) that Task 2 imports and renders directly in `index.jsx`. No props required.

The current `src/pages/disks.jsx` (read it first to confirm nothing has changed since this plan was written) contains `STATUS_DOT_CLASS`, `STAT_CLASS`, `CARD_CLASS`, the `fetcher` function, the `Stat` component, and the `DiskCard` component — all of that logic moves into the new file essentially unchanged. What changes is the default-exported component: instead of a full page (with `<Head>`, a "← Dashboard" back-link, and its own `min-h-screen` wrapper), it becomes a group section with a heading matching the rest of the dashboard's groups.

- [ ] **Step 1: Write the failing test**

```javascript
// src/components/disks/group.test.jsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import DisksGroup from "./group";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

describe("components/disks/group", () => {
  it("renders a heading and a card per disk with the correct status color", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            name: "sda",
            device: "/dev/sda",
            model: "MTFDDAK256TBN-1AR1ZABHA",
            size: "238.5G",
            protocol: "ATA",
            temperature: 40,
            smartPassed: true,
            reallocatedSectors: 0,
            wearPercentage: null,
            mediaErrors: null,
            status: "ok",
            error: null,
          },
        ]),
    });

    renderWithSWR(<DisksGroup />);

    expect(screen.getByText("Disks")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("sda")).toBeInTheDocument());
    const card = screen.getByText("sda").closest('[data-testid="disk-card"]');
    expect(card).toHaveAttribute("data-status", "ok");
  });

  it("shows the per-disk error message when a disk failed to query", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            name: "sdb",
            device: "/dev/sdb",
            model: "B",
            size: "1T",
            protocol: null,
            temperature: null,
            smartPassed: null,
            reallocatedSectors: null,
            wearPercentage: null,
            mediaErrors: null,
            status: null,
            error: "SMART query failed",
          },
        ]),
    });

    renderWithSWR(<DisksGroup />);

    await waitFor(() => expect(screen.getByText("SMART query failed")).toBeInTheDocument());
  });

  it("shows a failure message when the API responds with an error status", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    renderWithSWR(<DisksGroup />);

    await waitFor(() => expect(screen.getByText("Failed to load disk data.")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/disks/group.test.jsx`
Expected: FAIL — `Cannot find module './group'`.

- [ ] **Step 3: Write the implementation**

```jsx
// src/components/disks/group.jsx
import classNames from "classnames";
import { useContext } from "react";
import useSWR from "swr";

import { SettingsContext } from "utils/contexts/settings";

const STATUS_DOT_CLASS = {
  ok: "bg-emerald-500",
  warn: "bg-orange-400",
  critical: "bg-rose-500",
  // SMART data absent/malformed (e.g. a USB enclosure that doesn't pass SMART
  // through) — deliberately neither green nor red, since we don't actually know.
  unknown: "bg-theme-400",
};

// Same stat-pill classes src/components/services/widget/block.jsx uses, so
// disk cards read as native Homepage UI. Includes block.jsx's trailing
// "service-block" hook class so custom user CSS targeting it also applies here.
const STAT_CLASS =
  "bg-theme-200/50 dark:bg-theme-900/20 rounded-sm m-1 flex-1 flex flex-col items-center justify-center text-center p-1 service-block";

// Same card wrapper classes src/components/services/item.jsx uses, including its
// trailing "service-card" hook class (custom user CSS / cardBlur target it).
const CARD_CLASS =
  "transition-all mb-2 p-3 rounded-md font-medium text-theme-700 dark:text-theme-200 shadow-md shadow-theme-900/10 dark:shadow-theme-900/20 bg-theme-100/20 dark:bg-white/5 relative overflow-clip service-card";

// Throw on non-ok responses so SWR's `error` populates correctly instead of
// resolving "successfully" with an API error body (e.g. { error: "..." } from a
// 500), which would otherwise make `disks` a non-array and crash render.
const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function Stat({ value, label }) {
  return (
    <div className={STAT_CLASS}>
      <div className="font-thin text-sm">{value === null || value === undefined ? "-" : value}</div>
      <div className="font-bold text-xs uppercase">{label}</div>
    </div>
  );
}

function DiskCard({ disk, cardClassName }) {
  if (disk.error) {
    return (
      <div className={cardClassName} data-testid="disk-card" data-status="error">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm">{disk.name}</span>
          <span className={classNames("w-2.5 h-2.5 rounded-full", STATUS_DOT_CLASS.critical)} />
        </div>
        <p className="text-rose-500/80 text-xs">{disk.error}</p>
      </div>
    );
  }

  const wearOrReallocated = disk.wearPercentage != null ? `${disk.wearPercentage}%` : (disk.reallocatedSectors ?? "-");

  return (
    <div className={cardClassName} data-testid="disk-card" data-status={disk.status}>
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
        <Stat value={disk.temperature != null ? `${disk.temperature}°C` : null} label="Temp" />
        <Stat value={disk.smartPassed == null ? null : disk.smartPassed ? "PASSED" : "FAILED"} label="SMART" />
        <Stat value={wearOrReallocated} label={disk.wearPercentage != null ? "Wear" : "Realloc"} />
      </div>
    </div>
  );
}

export default function DisksGroup() {
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
    data: disks,
    error,
    mutate,
    isValidating,
  } = useSWR("/api/disks", fetcher, {
    refreshInterval: 60000,
  });

  return (
    <div id="disks-group">
      <div className="flex items-center justify-between">
        <h2 className="flex text-theme-800 dark:text-theme-300 text-xl font-medium service-group-name">Disks</h2>
        <button type="button" onClick={() => mutate()} disabled={isValidating} className="text-sm">
          Refresh
        </button>
      </div>

      {error && <p className="text-rose-500/80">Failed to load disk data.</p>}
      {!disks && !error && <p className="text-theme-500 dark:text-theme-300 text-sm">Loading...</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">
        {Array.isArray(disks) && disks.map((disk) => <DiskCard key={disk.name} disk={disk} cardClassName={cardClassName} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/components/disks/group.test.jsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/disks/group.jsx src/components/disks/group.test.jsx
git commit -m "feat: extract DisksGroup component from the /disks page"
```

---

### Task 2: Wire `DisksGroup` into the dashboard, remove the `/disks` page

**Files:**
- Modify: `src/pages/index.jsx`
- Delete: `src/pages/disks.jsx`
- Delete: `src/__tests__/pages/disks.test.jsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: `DisksGroup` from Task 1 (`src/components/disks/group.jsx`).
- Produces: the "Disks" section now renders on `/` (the main dashboard) instead of at a separate `/disks` route. `/disks` becomes a 404.

- [ ] **Step 1: Add the import and render `DisksGroup` in `index.jsx`**

Add to the import block (alphabetically among existing `components/*` imports — check the current file for exact placement, it already imports several `components/*` modules):

```javascript
import DisksGroup from "components/disks/group";
```

Find this line (confirmed present in the current file):

```jsx
        {servicesAndBookmarksGroups}
```

Replace it with:

```jsx
        {servicesAndBookmarksGroups}

        <DisksGroup />
```

- [ ] **Step 2: Remove the old `/disks` nav link and its now-unused import**

Find this block (confirmed present in the current file, inside the `id="style"` footer row):

```jsx
          <div id="style" className="flex w-full justify-end items-center">
            <Link href="/disks" className="text-sm mr-4 text-theme-500 dark:text-theme-300">
              Disks
            </Link>
            {!settings?.color && <ColorToggle />}
```

Replace with:

```jsx
          <div id="style" className="flex w-full justify-end items-center">
            {!settings?.color && <ColorToggle />}
```

Then remove the now-unused `import Link from "next/link";` line — confirm first that nothing else in the file still uses `<Link` (as of this plan being written, the only usage is the one just removed; re-check before deleting the import in case something changed).

- [ ] **Step 3: Delete the old page and its test**

```bash
git rm src/pages/disks.jsx src/__tests__/pages/disks.test.jsx
```

- [ ] **Step 4: Update README.md**

Three places currently reference the `/disks` page as a separate route; update them to describe it as a dashboard section instead:

Line ~26-33 (Status section) — change "The `/disks` page and `/api/disks` route..." to "The Disks section on the main dashboard and `/api/disks` route...", and "Linked from the main dashboard's footer." to something reflecting it's now inline (or remove that sentence — it's no longer a link, it's the section itself).

Line ~63 (Getting Started, guest agent config note) — change "Without it, the `/disks` page shows an error instead of real data" to "Without it, the Disks section on the dashboard shows an error instead of real data".

Line ~86 (comparison table) — change "✅ live (`/disks` page + `/api/disks`)" to "✅ live (dashboard section + `/api/disks`)".

Read the current file first to get exact surrounding context and line numbers before editing — they may have shifted slightly since this plan was written.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: PASS, no regressions. The old `src/__tests__/pages/disks.test.jsx` is gone (deleted in Step 3) so its 3 tests won't appear in the count; `src/components/disks/group.test.jsx`'s 3 tests (Task 1) replace them.

Run: `pnpm lint`
Expected: clean (confirms the `next/link` import removal didn't leave anything dangling, and nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add src/pages/index.jsx README.md
git commit -m "feat: move disk widget onto the main dashboard, remove the /disks page"
```

---

### Task 3: Live verification

**Files:** none (verification only)

- [ ] **Step 1: Deploy to the real host**

```bash
ssh lxc200 'cd /opt/stacks/your-server-board && git pull origin dev && docker compose up -d --build'
```

- [ ] **Step 2: Verify the dashboard**

```bash
curl -s http://10.0.1.104:3050/ | grep -o 'Disks' | head -1
curl -s -o /dev/null -w "%{http_code}\n" http://10.0.1.104:3050/disks
```

Expected: the first command finds "Disks" (the new section heading is present in the server-rendered HTML shell, though the actual disk data renders client-side after hydration — this just confirms the section exists on the page). The second command returns `404` (the old page is gone).

Open `http://10.0.1.104:3050/` in a browser if available. Expected: a "Disks" section appears on the main dashboard below the existing service groups, showing real `sda`/`sdc` cards with the same data the standalone page used to show.

- [ ] **Step 3: Confirm nothing else broke**

Confirm the existing Proxmox VE widget and any other dashboard content still render normally — this task only adds a new section and removes a route, it shouldn't affect anything else.
