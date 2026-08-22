# Drag-and-Drop Dashboard Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user mouse-drag whole dashboard sections (native service/bookmark groups, Virtual Machines, Disks) into a new order that persists server-side and applies on every device.

**Architecture:** A new pure module (`src/utils/config/layoutOrder.js`) owns the known section ids, the merge logic (saved order → drop stale ids → append new ids), and the reorder algorithm — all independently unit-tested with zero UI or network involved. A new `/api/layout-order` route (GET/POST, no auth per the approved design) persists the order to a dedicated `config/layout-order.yaml` file (not `settings.yaml` — `js-yaml` doesn't round-trip comments, and this keeps hand-edited config untouched). Two new presentational components (`SortableSection`, `SortableSectionList`) wrap `@dnd-kit` and are otherwise dumb — they take an ordered `{id, element}[]` and call `onReorder(newIds)`. `src/pages/index.jsx` is restructured so its five existing render blocks (today: three conditional divs sharing one JSX fragment, plus two always-rendered custom components) become five independent, individually addressable sections that a single new `sectionOrder` state drives.

**Tech Stack:** Next.js 16 (pages router) + React 19, SWR, `js-yaml`, Vitest + Testing Library, new dependency `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`.

## Global Constraints

- **Section granularity is five fixed blocks, not per-group.** The five draggable ids, in their current hardcoded render order, are: `layout-groups` (native groups already ordered via `settings.layout`'s key order — untouched, unchanged internal behavior), `services` (auto-discovered service groups not in `settings.layout`), `bookmarks` (auto-discovered bookmark groups), `proxmox-vms` (`<ProxmoxVmsGroup />`), `disks` (`<DisksGroup />`). This was an explicit user decision (confirmed 2026-08-21) after the coarser current render structure (three shared wrapper divs, not one div per group) was surfaced — full per-group interleaving was rejected as a bigger, riskier change to working render logic for no requested benefit. A future widget becomes a sixth (seventh, ...) id appended to this same list — the merge logic already handles that without a rewrite.
- **Persist to `config/layout-order.yaml`, never `settings.yaml`.** `js-yaml`'s `dump()` does not preserve comments/formatting, so writing into the user's hand-edited `settings.yaml` would silently destroy their comments on the first drag. This is a brand-new, dedicated file.
- **No auth gate on `/api/layout-order`.** Explicit approved-design choice — matches this app's default no-login posture (see `README.md`'s Security note); do not add one.
- **No tab-scoped ordering.** One global section order regardless of the active tab (approved design). `layout-groups`' own internal tab-filtering (`settings.layout[...].tab`) is untouched.
- **Drag-handle-only.** The section's own interactive content (Refresh buttons, collapse toggles, service links) must stay fully clickable; only a small dedicated handle initiates a drag. Never absolutely-position the handle over existing content — every current section header already places content at both the left (title) and right (a button) of its top row, so an overlay handle risks the exact "unclickable button" class of bug this project hit before with the Refresh button's invisible-text regression. Render the handle as its own full-width strip instead.
- **Optimistic update, revert-on-failure.** Dragging must reorder the UI immediately; the POST happens in the background; a failed POST reverts the local order. No blocking spinner, no toast library — this app doesn't have one and adding one is out of scope.
- **First-run visual parity.** `KNOWN_SECTION_IDS`' default order must exactly match today's hardcoded render order (`layout-groups`, `services`, `bookmarks`, `proxmox-vms`, `disks`) so a user with no `layout-order.yaml` yet sees an unchanged dashboard.
- **No server-specific code.** This repo ships publicly (see `README.md`); nothing in this feature may reference Pavel's own infrastructure, IPs, or hostnames. (Nothing in this plan does — flagging per this project's standing rule.)
- **pnpm only.** Every command in this plan uses `pnpm`, matching `package.json`'s `preinstall` guard.
- **Every new/modified route and non-trivial module needs Vitest coverage**, and every task must leave `pnpm test`, `pnpm lint`, and `pnpm exec prettier --check "src/**/*.{js,jsx}"` all green — `pnpm lint` (ESLint) does not catch formatting-only issues; the two checks are independent gates.

---

### Task 1: `layoutOrder.js` — pure merge/reorder logic + YAML persistence

**Files:**

- Create: `src/utils/config/layoutOrder.js`
- Test: `src/utils/config/layoutOrder.test.js`

**Interfaces:**

- Produces (used by Task 2 and Task 4):

  - `KNOWN_SECTION_IDS: string[]` — `["layout-groups", "services", "bookmarks", "proxmox-vms", "disks"]`, in default render order.
  - `mergeLayoutOrder(savedOrder: unknown, knownIds = KNOWN_SECTION_IDS): string[]` — pure. Keeps ids from `savedOrder` that are in `knownIds`, in their saved relative order, deduped; appends any `knownIds` not mentioned, in `knownIds`' own relative order. Always returns every id in `knownIds` exactly once. Tolerates `savedOrder` being `undefined`/non-array (treats as empty).
  - `isValidSectionOrder(value: unknown, knownIds = KNOWN_SECTION_IDS): boolean` — true iff `value` is a non-empty array of strings, each in `knownIds`, no duplicates. Does not require every known id to be present (a client sending a partial/stale set is still valid input — the server merges the rest).
  - `reorderSectionIds(order: string[], activeId: string, overId: string): string[]` — pure. Moves the section at `activeId` to sit where `overId` currently is. Returns `order` **unchanged (same reference)** if `activeId`/`overId` aren't both present in `order`, or are equal.
  - `getLayoutOrder(): string[]` — reads `config/layout-order.yaml` (via `CONF_DIR` from `utils/config/config`), returns a fully-merged order. Missing file, empty file, or malformed YAML all fall back to `mergeLayoutOrder([])` (i.e. `KNOWN_SECTION_IDS`) — this file is optional (no skeleton, no fatal path), unlike `settings.yaml`.
  - `writeLayoutOrder(order: unknown): string[]` — merges `order` against `KNOWN_SECTION_IDS`, writes `{ order: merged }` as YAML to `config/layout-order.yaml` (creating `CONF_DIR` if needed), returns the merged order that was written.

- [ ] **Step 1: Write the failing tests**

Create `src/utils/config/layoutOrder.test.js`:

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("utils/config/config", () => ({ CONF_DIR: "/config" }));

import {
  KNOWN_SECTION_IDS,
  getLayoutOrder,
  isValidSectionOrder,
  mergeLayoutOrder,
  reorderSectionIds,
  writeLayoutOrder,
} from "./layoutOrder";

describe("mergeLayoutOrder", () => {
  it("returns the default order unchanged when nothing is saved", () => {
    expect(mergeLayoutOrder([])).toEqual(KNOWN_SECTION_IDS);
    expect(mergeLayoutOrder(undefined)).toEqual(KNOWN_SECTION_IDS);
  });

  it("preserves a saved order of known ids", () => {
    const saved = ["disks", "layout-groups", "services", "bookmarks", "proxmox-vms"];
    expect(mergeLayoutOrder(saved)).toEqual(saved);
  });

  it("drops stale ids no longer known", () => {
    const saved = ["disks", "old-widget", "services"];
    expect(mergeLayoutOrder(saved, ["disks", "services", "bookmarks"])).toEqual(["disks", "services", "bookmarks"]);
  });

  it("appends newly-known ids not mentioned in the saved order, at the end", () => {
    const saved = ["disks", "services"];
    expect(mergeLayoutOrder(saved, ["disks", "services", "bookmarks", "new-widget"])).toEqual([
      "disks",
      "services",
      "bookmarks",
      "new-widget",
    ]);
  });

  it("dedupes a saved order containing a repeated id", () => {
    const saved = ["disks", "disks", "services"];
    expect(mergeLayoutOrder(saved, ["disks", "services", "bookmarks"])).toEqual(["disks", "services", "bookmarks"]);
  });
});

describe("isValidSectionOrder", () => {
  it("accepts a full permutation of known ids", () => {
    expect(isValidSectionOrder([...KNOWN_SECTION_IDS].reverse())).toBe(true);
  });

  it("accepts a partial subset of known ids (server merges the rest)", () => {
    expect(isValidSectionOrder(["disks", "services"])).toBe(true);
  });

  it("rejects an unknown id", () => {
    expect(isValidSectionOrder(["disks", "not-a-real-section"])).toBe(false);
  });

  it("rejects duplicates", () => {
    expect(isValidSectionOrder(["disks", "disks"])).toBe(false);
  });

  it("rejects non-arrays and empty arrays", () => {
    expect(isValidSectionOrder(null)).toBe(false);
    expect(isValidSectionOrder("disks")).toBe(false);
    expect(isValidSectionOrder([])).toBe(false);
  });
});

describe("reorderSectionIds", () => {
  it("moves the active id to sit where the over id is", () => {
    expect(reorderSectionIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderSectionIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns the same array reference, unchanged, for an unknown id", () => {
    const order = ["a", "b", "c"];
    expect(reorderSectionIds(order, "a", "missing")).toBe(order);
    expect(reorderSectionIds(order, "missing", "a")).toBe(order);
  });

  it("returns the same array reference, unchanged, when active and over are equal", () => {
    const order = ["a", "b", "c"];
    expect(reorderSectionIds(order, "b", "b")).toBe(order);
  });
});

describe("getLayoutOrder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the default order when the file doesn't exist", () => {
    existsSync.mockReturnValue(false);
    expect(getLayoutOrder()).toEqual(KNOWN_SECTION_IDS);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("returns a merged order from a valid saved file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("order:\n  - disks\n  - services\n");
    expect(getLayoutOrder()).toEqual(mergeLayoutOrder(["disks", "services"]));
  });

  it("falls back to the default order on malformed YAML", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("order:\n\t- disks\n"); // tab indentation is invalid YAML
    expect(getLayoutOrder()).toEqual(KNOWN_SECTION_IDS);
  });
});

describe("writeLayoutOrder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges and writes the order as YAML, returning the merged order", () => {
    const result = writeLayoutOrder(["disks", "services"]);

    expect(result).toEqual(mergeLayoutOrder(["disks", "services"]));
    expect(mkdirSync).toHaveBeenCalledWith("/config", { recursive: true });
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [path, contents] = writeFileSync.mock.calls[0];
    expect(path).toBe("/config/layout-order.yaml");
    expect(contents).toContain("disks");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/config/layoutOrder.test.js`
Expected: FAIL — `layoutOrder.js` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `src/utils/config/layoutOrder.js`:

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import yaml from "js-yaml";

import { CONF_DIR } from "utils/config/config";

// The five draggable dashboard sections, in their current hardcoded render
// order (src/pages/index.jsx before this feature). This doubles as the
// default order the first time anyone drags anything, and the order
// restored for any known id a saved file doesn't mention (mergeLayoutOrder).
export const KNOWN_SECTION_IDS = ["layout-groups", "services", "bookmarks", "proxmox-vms", "disks"];

const LAYOUT_ORDER_FILE = "layout-order.yaml";

// Pure merge: keep ids from savedOrder that are still known, in their saved
// relative order, deduped; append any known id savedOrder didn't mention (a
// newly-added section type) at the end, in knownIds' own relative order.
// Always returns every id in knownIds exactly once.
export function mergeLayoutOrder(savedOrder, knownIds = KNOWN_SECTION_IDS) {
  const known = new Set(knownIds);
  const seen = new Set();
  const kept = (Array.isArray(savedOrder) ? savedOrder : []).filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const missing = knownIds.filter((id) => !seen.has(id));
  return [...kept, ...missing];
}

// True when value is a non-empty array of strings, each a known section id,
// with no duplicates. Doesn't require every known id to be present - a
// stale/partial client-sent set is still valid; the server merges the rest.
export function isValidSectionOrder(value, knownIds = KNOWN_SECTION_IDS) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const known = new Set(knownIds);
  const seen = new Set();
  return value.every((id) => {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Pure reorder: move the section with id activeId to sit where overId
// currently is. Returns `order` unchanged (same reference) if either id
// isn't present or they're equal - callers get a safe no-op instead of a
// thrown error for a stale/no-op drag event.
export function reorderSectionIds(order, activeId, overId) {
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return order;

  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function layoutOrderPath() {
  return join(CONF_DIR, LAYOUT_ORDER_FILE);
}

// Reads config/layout-order.yaml and returns a fully-merged order (every
// known id present exactly once). Missing file, empty file, or malformed
// YAML all fall back to the default order - unlike settings.yaml this file
// is optional, so there's no skeleton-copy step and no fatal path.
export function getLayoutOrder() {
  const path = layoutOrderPath();
  if (!existsSync(path)) return mergeLayoutOrder([]);

  try {
    const parsed = yaml.load(readFileSync(path, "utf8"));
    return mergeLayoutOrder(parsed?.order);
  } catch {
    return mergeLayoutOrder([]);
  }
}

// Merges `order` against known ids and persists the result. Returns the
// merged order that was written.
export function writeLayoutOrder(order) {
  const merged = mergeLayoutOrder(order);
  mkdirSync(CONF_DIR, { recursive: true });
  writeFileSync(layoutOrderPath(), yaml.dump({ order: merged }, { lineWidth: -1, noRefs: true }), "utf8");
  return merged;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/config/layoutOrder.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Lint and format**

Run: `pnpm lint && pnpm exec prettier --check "src/utils/config/layoutOrder.js" "src/utils/config/layoutOrder.test.js"`
Expected: both clean. If prettier fails, run `pnpm exec prettier --write` on the two files and re-check.

- [ ] **Step 6: Commit**

```bash
git add src/utils/config/layoutOrder.js src/utils/config/layoutOrder.test.js
git commit -m "feat(layout): add pure section-order merge/reorder logic + YAML persistence"
```

---

### Task 2: `/api/layout-order` route (GET/POST)

**Files:**

- Create: `src/pages/api/layout-order/index.js`
- Test: `src/pages/api/layout-order/index.test.js`

**Interfaces:**

- Consumes: `getLayoutOrder`, `isValidSectionOrder`, `writeLayoutOrder` from `utils/config/layoutOrder` (Task 1).
- Produces: `GET /api/layout-order` → `200 { order: string[] }`. `POST /api/layout-order` with body `{ order: string[] }` → `200 { order: string[] }` (the merged, persisted order) on success, `400 { error: string }` on an invalid body, `500 { error: string }` if the write throws. Any other method → `405 { error: "Method not allowed" }`. This exact shape (`{ order: [...] }`) is what Task 4's `getStaticProps` SWR fallback and client `useSWR("/api/layout-order")` both read.

- [ ] **Step 1: Write the failing tests**

Create `src/pages/api/layout-order/index.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getLayoutOrder, writeLayoutOrder, logger } = vi.hoisted(() => ({
  getLayoutOrder: vi.fn(),
  writeLayoutOrder: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/config/layoutOrder", async () => {
  const actual = await vi.importActual("utils/config/layoutOrder");
  return { ...actual, getLayoutOrder, writeLayoutOrder };
});
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/layout-order/index";

describe("pages/api/layout-order", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for unsupported methods", async () => {
    const req = { method: "DELETE" };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(getLayoutOrder).not.toHaveBeenCalled();
  });

  it("GET returns the current order", async () => {
    getLayoutOrder.mockReturnValue(["disks", "services", "bookmarks", "layout-groups", "proxmox-vms"]);
    const req = { method: "GET" };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ order: ["disks", "services", "bookmarks", "layout-groups", "proxmox-vms"] });
  });

  it("POST persists a valid order and returns the merged result", async () => {
    writeLayoutOrder.mockReturnValue(["disks", "services", "bookmarks", "layout-groups", "proxmox-vms"]);
    const req = { method: "POST", body: { order: ["disks", "services"] } };
    const res = createMockRes();

    await handler(req, res);

    expect(writeLayoutOrder).toHaveBeenCalledWith(["disks", "services"]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ order: ["disks", "services", "bookmarks", "layout-groups", "proxmox-vms"] });
  });

  it("POST returns 400 for an order containing an unknown id", async () => {
    const req = { method: "POST", body: { order: ["not-a-real-section"] } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(writeLayoutOrder).not.toHaveBeenCalled();
  });

  it("POST returns 400 when the body has no order", async () => {
    const req = { method: "POST", body: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("POST returns 500 and logs when persisting throws", async () => {
    writeLayoutOrder.mockImplementation(() => {
      throw new Error("disk full");
    });
    const req = { method: "POST", body: { order: ["disks"] } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/pages/api/layout-order/index.test.js`
Expected: FAIL — route module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/pages/api/layout-order/index.js`:

```js
import { getLayoutOrder, isValidSectionOrder, writeLayoutOrder } from "utils/config/layoutOrder";
import createLogger from "utils/logger";

const logger = createLogger("layoutOrderApi");

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.method === "GET") {
    return res.status(200).json({ order: getLayoutOrder() });
  }

  const { order } = req.body ?? {};
  if (!isValidSectionOrder(order)) {
    return res.status(400).json({ error: "Invalid order" });
  }

  try {
    const merged = writeLayoutOrder(order);
    return res.status(200).json({ order: merged });
  } catch (error) {
    logger.error("Failed to persist layout order:", error);
    return res.status(500).json({ error: "Failed to persist layout order" });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/pages/api/layout-order/index.test.js`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Lint and format**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/api/layout-order/index.js" "src/pages/api/layout-order/index.test.js"`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/layout-order/index.js src/pages/api/layout-order/index.test.js
git commit -m "feat(layout): add GET/POST /api/layout-order route"
```

---

### Task 3: `@dnd-kit`-powered `SortableSection` + `SortableSectionList` components

**Files:**

- Modify: `package.json` (new dependencies)
- Create: `src/components/layout/SortableSection.jsx`
- Test: `src/components/layout/SortableSection.test.jsx`
- Create: `src/components/layout/SortableSectionList.jsx`
- Test: `src/components/layout/SortableSectionList.test.jsx`

**Interfaces:**

- Consumes: `reorderSectionIds` from `utils/config/layoutOrder` (Task 1).
- Produces (used by Task 4):

  - `SortableSection({ id: string, children: ReactNode })` — wraps `children` in a `useSortable({id})`-driven positioned `div`, with a small full-width drag-handle strip (its own row, never overlapping `children`) rendered above them. `children` render completely unmodified and stay fully interactive.
  - `SortableSectionList({ sections: {id: string, element: ReactNode}[], onReorder: (newIds: string[]) => void })` — renders each `sections[i].element` wrapped in a `SortableSection`, in array order, inside a `DndContext` + `SortableContext`. On drag end over a different section, calls `onReorder` with the new id order (via `reorderSectionIds`); does not call `onReorder` for a no-op drag (dropped on itself, or outside any droppable).

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 @dnd-kit/utilities@3.2.2`
Expected: `package.json`/`pnpm-lock.yaml` gain the three packages under `dependencies`.

- [ ] **Step 2: Write the failing tests**

Create `src/components/layout/SortableSection.test.jsx`:

```jsx
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button", "aria-roledescription": "sortable" },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

import SortableSection from "./SortableSection";

describe("SortableSection", () => {
  it("renders its children unchanged", () => {
    render(
      <SortableSection id="disks">
        <div data-testid="content">Disks content</div>
      </SortableSection>,
    );

    expect(screen.getByTestId("content")).toHaveTextContent("Disks content");
  });

  it("puts the drag attributes/listeners only on the handle, not on the section content", () => {
    render(
      <SortableSection id="disks">
        <button type="button" data-testid="inner-button">
          Refresh
        </button>
      </SortableSection>,
    );

    const handle = screen.getByRole("button", { name: "Drag to reorder this section" });
    expect(handle).toHaveAttribute("aria-roledescription", "sortable");

    expect(screen.getByTestId("inner-button")).not.toHaveAttribute("aria-roledescription");
  });
});
```

Create `src/components/layout/SortableSectionList.test.jsx`:

```jsx
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { capturedOnDragEnd } = vi.hoisted(() => ({ capturedOnDragEnd: { current: null } }));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd }) => {
    capturedOnDragEnd.current = onDragEnd;
    return children;
  },
  PointerSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }) => children,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: "vertical",
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

import SortableSectionList from "./SortableSectionList";

describe("SortableSectionList", () => {
  it("renders sections in the given order", () => {
    const sections = [
      { id: "disks", element: <div data-testid="disks">Disks</div> },
      { id: "services", element: <div data-testid="services">Services</div> },
    ];

    render(<SortableSectionList sections={sections} onReorder={vi.fn()} />);

    const rendered = screen.getAllByTestId(/disks|services/);
    expect(rendered.map((el) => el.dataset.testid)).toEqual(["disks", "services"]);
  });

  it("calls onReorder with the new id order after a drag ends over a different section", () => {
    const sections = [
      { id: "disks", element: <div>Disks</div> },
      { id: "services", element: <div>Services</div> },
      { id: "bookmarks", element: <div>Bookmarks</div> },
    ];
    const onReorder = vi.fn();

    render(<SortableSectionList sections={sections} onReorder={onReorder} />);
    capturedOnDragEnd.current({ active: { id: "disks" }, over: { id: "bookmarks" } });

    expect(onReorder).toHaveBeenCalledWith(["services", "bookmarks", "disks"]);
  });

  it("does not call onReorder for a no-op drag (dropped on itself or outside any droppable)", () => {
    const sections = [
      { id: "disks", element: <div>Disks</div> },
      { id: "services", element: <div>Services</div> },
    ];
    const onReorder = vi.fn();

    render(<SortableSectionList sections={sections} onReorder={onReorder} />);
    capturedOnDragEnd.current({ active: { id: "disks" }, over: { id: "disks" } });
    capturedOnDragEnd.current({ active: { id: "disks" }, over: null });

    expect(onReorder).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/components/layout/`
Expected: FAIL — neither component exists yet.

- [ ] **Step 4: Write the implementation**

Create `src/components/layout/SortableSection.jsx`:

```jsx
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BiMove } from "react-icons/bi";

// Wraps one whole dashboard section (a services/bookmarks block, Virtual
// Machines, Disks, ...) to make it draggable as a unit. The grip strip above
// the section is the only drag source - the section's own content (buttons,
// links, collapse toggles) stays fully interactive. Nothing is absolutely
// positioned over existing content, so this can't collide with a section's
// own header buttons the way an overlay handle could.
export default function SortableSection({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "opacity-50" : undefined}>
      <div className="flex justify-center">
        <button
          type="button"
          aria-label="Drag to reorder this section"
          className="touch-none cursor-grab rounded px-8 py-0.5 text-theme-400 hover:bg-theme-100/40 hover:text-theme-600 active:cursor-grabbing dark:text-theme-500 dark:hover:bg-white/5 dark:hover:text-theme-300"
          {...attributes}
          {...listeners}
        >
          <BiMove size={16} />
        </button>
      </div>
      {children}
    </div>
  );
}
```

Create `src/components/layout/SortableSectionList.jsx`:

```jsx
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { reorderSectionIds } from "utils/config/layoutOrder";

import SortableSection from "./SortableSection";

// `sections` is the ordered array of { id, element } to render - the caller
// (src/pages/index.jsx) owns the order and re-renders with a new array
// after a drop. This component only translates a dnd-kit drag gesture into
// that new order via onReorder(newOrderIds); it holds no order state itself.
export default function SortableSectionList({ sections, onReorder }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const currentOrder = sections.map((section) => section.id);
    const nextOrder = reorderSectionIds(currentOrder, active.id, over.id);
    if (nextOrder !== currentOrder) {
      onReorder(nextOrder);
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sections.map((section) => section.id)} strategy={verticalListSortingStrategy}>
        {sections.map(({ id, element }) => (
          <SortableSection key={id} id={id}>
            {element}
          </SortableSection>
        ))}
      </SortableContext>
    </DndContext>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/components/layout/`
Expected: PASS, all 5 tests green.

- [ ] **Step 6: Lint and format**

Run: `pnpm lint && pnpm exec prettier --check "src/components/layout/**/*.jsx"`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/components/layout/
git commit -m "feat(layout): add SortableSection/SortableSectionList dnd-kit components"
```

---

### Task 4: Wire into `src/pages/index.jsx`

**Files:**

- Modify: `src/pages/index.jsx`
- Modify: `src/__tests__/pages/index.test.jsx`
- Modify: `README.md`

**Interfaces:**

- Consumes: `getLayoutOrder`, `KNOWN_SECTION_IDS` from `utils/config/layoutOrder` (Task 1); `SortableSectionList` from `components/layout/SortableSectionList` (Task 3); existing `ProxmoxVmsGroup`, `DisksGroup`, `ServicesGroup`, `BookmarksGroup`, `Tab`.

Before touching `index.jsx`, confirm the current baseline is green:

Run: `pnpm exec vitest run src/__tests__/pages/index.test.jsx`
Expected: PASS (this is today's regression safety net — every assertion here must still pass after this task, except where a step below explicitly says otherwise).

- [ ] **Step 1: Add `layoutOrder` to `getStaticProps`**

In `src/pages/index.jsx`, add the import (alongside the existing `utils/config/config` import):

```js
import { getLayoutOrder, KNOWN_SECTION_IDS } from "utils/config/layoutOrder";
```

In `getStaticProps` (around line 61), change:

```js
const services = await servicesResponse();
const bookmarks = await bookmarksResponse();
const widgets = await widgetsResponse();
const language = normalizeLanguage(settings.language);

return {
  props: {
    initialSettings: settings,
    fallback: {
      "/api/services": services,
      "/api/bookmarks": bookmarks,
      "/api/widgets": widgets,
      "/api/hash": false,
    },
    ...(await serverSideTranslations(language)),
  },
};
```

to:

```js
const services = await servicesResponse();
const bookmarks = await bookmarksResponse();
const widgets = await widgetsResponse();
const layoutOrder = getLayoutOrder();
const language = normalizeLanguage(settings.language);

return {
  props: {
    initialSettings: settings,
    fallback: {
      "/api/services": services,
      "/api/bookmarks": bookmarks,
      "/api/widgets": widgets,
      "/api/layout-order": { order: layoutOrder },
      "/api/hash": false,
    },
    ...(await serverSideTranslations(language)),
  },
};
```

And in the `catch` branch's fallback object, add the same key with the default:

```js
        fallback: {
          "/api/services": [],
          "/api/bookmarks": [],
          "/api/widgets": [],
          "/api/layout-order": { order: KNOWN_SECTION_IDS },
          "/api/hash": false,
        },
```

- [ ] **Step 2: Split `servicesAndBookmarksGroups` into individually addressable blocks**

Replace the `servicesAndBookmarksGroups` `useMemo` (currently returning one JSX fragment containing tabs + three conditional divs) with a `sectionBlocks` `useMemo` returning an object of the four pieces instead of one fragment, so each can become an independently orderable section. Change:

```js
const servicesAndBookmarksGroups = useMemo(() => {
  const tabGroupFilter = (g) => g && [activeTab, ""].includes(slugifyAndEncode(settings.layout?.[g.name]?.tab));
  const undefinedGroupFilter = (g) => settings.layout?.[g.name] === undefined;

  const layoutGroups = Object.keys(settings.layout ?? {})
    .map((groupName) => services?.find((g) => g.name === groupName) ?? bookmarks?.find((b) => b.name === groupName))
    .filter(tabGroupFilter);

  if (!settings.layout && JSON.stringify(settings.layout) !== JSON.stringify(initialSettings.layout)) {
    // wait for settings to populate (if different from initial settings), otherwise all the widgets will be requested initially even if we are on a single tab
    return <div />;
  }

  const serviceGroups = services?.filter(tabGroupFilter).filter(undefinedGroupFilter);
  const bookmarkGroups = bookmarks.filter(tabGroupFilter).filter(undefinedGroupFilter);

  return (
    <>
      {tabs.length > 0 && (
        <div key="tabs" id="tabs" className="m-5 sm:m-9 sm:mt-4 sm:mb-0">
          <ul
            className={classNames(
              "sm:flex rounded-md bg-theme-100/20 dark:bg-white/5",
              settings.cardBlur !== undefined &&
                `backdrop-blur${settings.cardBlur.length ? "-" : ""}${settings.cardBlur}`,
            )}
            id="myTab"
            data-tabs-toggle="#myTabContent"
            role="tablist"
          >
            {tabs.map((tab) => (
              <Tab key={tab} tab={tab} />
            ))}
          </ul>
        </div>
      )}
      {layoutGroups.length > 0 && (
        <div key="layoutGroups" id="layout-groups" className="flex flex-wrap m-4 sm:m-8 sm:mt-4 items-start mb-2">
          {layoutGroups.map((group) =>
            group.services ? (
              <ServicesGroup
                key={group.name}
                group={group}
                layout={settings.layout?.[group.name]}
                maxGroupColumns={settings.fiveColumns ? 5 : settings.maxGroupColumns}
                disableCollapse={settings.disableCollapse}
                useEqualHeights={settings.useEqualHeights}
                groupsInitiallyCollapsed={settings.groupsInitiallyCollapsed}
              />
            ) : (
              <BookmarksGroup
                key={group.name}
                bookmarks={group}
                layout={settings.layout?.[group.name]}
                disableCollapse={settings.disableCollapse}
                maxGroupColumns={settings.maxBookmarkGroupColumns ?? settings.maxGroupColumns}
                groupsInitiallyCollapsed={settings.groupsInitiallyCollapsed}
              />
            ),
          )}
        </div>
      )}
      {serviceGroups?.length > 0 && (
        <div key="services" id="services" className="flex flex-wrap m-4 sm:m-8 sm:mt-4 items-start mb-2">
          {serviceGroups.map((group) => (
            <ServicesGroup
              key={group.name}
              group={group}
              layout={settings.layout?.[group.name]}
              maxGroupColumns={settings.fiveColumns ? 5 : settings.maxGroupColumns}
              disableCollapse={settings.disableCollapse}
              groupsInitiallyCollapsed={settings.groupsInitiallyCollapsed}
            />
          ))}
        </div>
      )}
      {bookmarkGroups?.length > 0 && (
        <div key="bookmarks" id="bookmarks" className="flex flex-wrap m-4 sm:m-8 sm:mt-4 items-start mb-2">
          {bookmarkGroups.map((group) => (
            <BookmarksGroup
              key={group.name}
              bookmarks={group}
              layout={settings.layout?.[group.name]}
              disableCollapse={settings.disableCollapse}
              maxGroupColumns={settings.maxBookmarkGroupColumns ?? settings.maxGroupColumns}
              groupsInitiallyCollapsed={settings.groupsInitiallyCollapsed}
              bookmarksStyle={settings.bookmarksStyle}
            />
          ))}
        </div>
      )}
    </>
  );
}, [
  tabs,
  activeTab,
  services,
  bookmarks,
  settings.layout,
  settings.fiveColumns,
  settings.maxGroupColumns,
  settings.maxBookmarkGroupColumns,
  settings.disableCollapse,
  settings.useEqualHeights,
  settings.cardBlur,
  settings.groupsInitiallyCollapsed,
  settings.bookmarksStyle,
  initialSettings.layout,
]);
```

to:

```js
const sectionBlocks = useMemo(() => {
  const tabGroupFilter = (g) => g && [activeTab, ""].includes(slugifyAndEncode(settings.layout?.[g.name]?.tab));
  const undefinedGroupFilter = (g) => settings.layout?.[g.name] === undefined;

  if (!settings.layout && JSON.stringify(settings.layout) !== JSON.stringify(initialSettings.layout)) {
    // wait for settings to populate (if different from initial settings), otherwise all the widgets will be requested initially even if we are on a single tab
    return { tabsElement: null, layoutGroupsElement: null, servicesElement: null, bookmarksElement: null };
  }

  const layoutGroups = Object.keys(settings.layout ?? {})
    .map((groupName) => services?.find((g) => g.name === groupName) ?? bookmarks?.find((b) => b.name === groupName))
    .filter(tabGroupFilter);
  const serviceGroups = services?.filter(tabGroupFilter).filter(undefinedGroupFilter);
  const bookmarkGroups = bookmarks.filter(tabGroupFilter).filter(undefinedGroupFilter);

  const tabsElement =
    tabs.length > 0 ? (
      <div id="tabs" className="m-5 sm:m-9 sm:mt-4 sm:mb-0">
        <ul
          className={classNames(
            "sm:flex rounded-md bg-theme-100/20 dark:bg-white/5",
            settings.cardBlur !== undefined &&
              `backdrop-blur${settings.cardBlur.length ? "-" : ""}${settings.cardBlur}`,
          )}
          id="myTab"
          data-tabs-toggle="#myTabContent"
          role="tablist"
        >
          {tabs.map((tab) => (
            <Tab key={tab} tab={tab} />
          ))}
        </ul>
      </div>
    ) : null;

  const layoutGroupsElement =
    layoutGroups.length > 0 ? (
      <div id="layout-groups" className="flex flex-wrap m-4 sm:m-8 sm:mt-4 items-start mb-2">
        {layoutGroups.map((group) =>
          group.services ? (
            <ServicesGroup
              key={group.name}
              group={group}
              layout={settings.layout?.[group.name]}
              maxGroupColumns={settings.fiveColumns ? 5 : settings.maxGroupColumns}
              disableCollapse={settings.disableCollapse}
              useEqualHeights={settings.useEqualHeights}
              groupsInitiallyCollapsed={settings.groupsInitiallyCollapsed}
            />
          ) : (
            <BookmarksGroup
              key={group.name}
              bookmarks={group}
              layout={settings.layout?.[group.name]}
              disableCollapse={settings.disableCollapse}
              maxGroupColumns={settings.maxBookmarkGroupColumns ?? settings.maxGroupColumns}
              groupsInitiallyCollapsed={settings.groupsInitiallyCollapsed}
            />
          ),
        )}
      </div>
    ) : null;

  const servicesElement =
    serviceGroups?.length > 0 ? (
      <div id="services" className="flex flex-wrap m-4 sm:m-8 sm:mt-4 items-start mb-2">
        {serviceGroups.map((group) => (
          <ServicesGroup
            key={group.name}
            group={group}
            layout={settings.layout?.[group.name]}
            maxGroupColumns={settings.fiveColumns ? 5 : settings.maxGroupColumns}
            disableCollapse={settings.disableCollapse}
            groupsInitiallyCollapsed={settings.groupsInitiallyCollapsed}
          />
        ))}
      </div>
    ) : null;

  const bookmarksElement =
    bookmarkGroups?.length > 0 ? (
      <div id="bookmarks" className="flex flex-wrap m-4 sm:m-8 sm:mt-4 items-start mb-2">
        {bookmarkGroups.map((group) => (
          <BookmarksGroup
            key={group.name}
            bookmarks={group}
            layout={settings.layout?.[group.name]}
            disableCollapse={settings.disableCollapse}
            maxGroupColumns={settings.maxBookmarkGroupColumns ?? settings.maxGroupColumns}
            groupsInitiallyCollapsed={settings.groupsInitiallyCollapsed}
            bookmarksStyle={settings.bookmarksStyle}
          />
        ))}
      </div>
    ) : null;

  return { tabsElement, layoutGroupsElement, servicesElement, bookmarksElement };
}, [
  tabs,
  activeTab,
  services,
  bookmarks,
  settings.layout,
  settings.fiveColumns,
  settings.maxGroupColumns,
  settings.maxBookmarkGroupColumns,
  settings.disableCollapse,
  settings.useEqualHeights,
  settings.cardBlur,
  settings.groupsInitiallyCollapsed,
  settings.bookmarksStyle,
  initialSettings.layout,
]);
```

- [ ] **Step 3: Add section order state, the reorder handler, and the composed `sections` array**

Add `useCallback` to the existing React import (`import { useContext, useEffect, useMemo, useState } from "react";` → `import { useCallback, useContext, useEffect, useMemo, useState } from "react";`), and add `SortableSectionList` to the imports:

```js
import SortableSectionList from "components/layout/SortableSectionList";
```

Immediately after the `sectionBlocks` `useMemo` from Step 2, add:

```js
const { data: persistedSectionOrder, mutate: mutateSectionOrder } = useSWR("/api/layout-order");
const [sectionOrder, setSectionOrder] = useState(() => persistedSectionOrder?.order ?? KNOWN_SECTION_IDS);

useEffect(() => {
  if (persistedSectionOrder?.order) setSectionOrder(persistedSectionOrder.order);
}, [persistedSectionOrder]);

const handleReorder = useCallback(
  async (nextOrder) => {
    const previousOrder = sectionOrder;
    setSectionOrder(nextOrder);
    try {
      const res = await fetch("/api/layout-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: nextOrder }),
      });
      if (!res.ok) throw new Error(`request failed with status ${res.status}`);
      const persisted = await res.json();
      mutateSectionOrder(persisted, false);
    } catch (error) {
      logger.error("Failed to persist dashboard section order:", error);
      setSectionOrder(previousOrder);
    }
  },
  [sectionOrder, mutateSectionOrder],
);

const sections = useMemo(() => {
  const elementsById = {
    "layout-groups": sectionBlocks.layoutGroupsElement,
    services: sectionBlocks.servicesElement,
    bookmarks: sectionBlocks.bookmarksElement,
    "proxmox-vms": <ProxmoxVmsGroup />,
    disks: <DisksGroup />,
  };
  return sectionOrder.map((id) => ({ id, element: elementsById[id] })).filter((section) => section.element);
}, [sectionOrder, sectionBlocks]);
```

Add a module-level logger for this error log (near the top of the file, after the other top-level constants like `rightAlignedWidgets`):

```js
const logger = createLogger("index");
```

`createLogger` is already imported at the top of this file (used inside `getStaticProps`), so no new import is needed for this line - just the new module-level `const`.

- [ ] **Step 4: Replace the render usage**

Change:

```jsx
        {servicesAndBookmarksGroups}

        <ProxmoxVmsGroup />

        <DisksGroup />
```

to:

```jsx
{
  sectionBlocks.tabsElement;
}

<SortableSectionList sections={sections} onReorder={handleReorder} />;
```

- [ ] **Step 5: Run the existing test suite and fix the mocks it needs**

Run: `pnpm exec vitest run src/__tests__/pages/index.test.jsx`
Expected at this point: several failures, because the test file's hoisted mocks don't yet know about `/api/layout-order`, `utils/config/layoutOrder`, or `components/layout/SortableSectionList`.

Apply these edits to `src/__tests__/pages/index.test.jsx`:

1. In the `vi.hoisted` block, add two fields to `state` and one new mock function, and add the new SWR branch. Change:

```js
const state = {
  throwIn: null,
  validateData: [],
  hashData: null,
  mutateHash: vi.fn(),
  servicesData: [],
  bookmarksData: [],
  widgetsData: [],
  quickLaunchProps: null,
  widgetCalls: [],
  windowFocused: false,
};
```

to:

```js
const state = {
  throwIn: null,
  validateData: [],
  hashData: null,
  mutateHash: vi.fn(),
  servicesData: [],
  bookmarksData: [],
  widgetsData: [],
  quickLaunchProps: null,
  widgetCalls: [],
  windowFocused: false,
  layoutOrderData: null,
  mutateLayoutOrder: vi.fn(),
  sortableSectionListProps: null,
};
```

And add, alongside the existing `getSettings`/`servicesResponse`/etc. declarations:

```js
const getLayoutOrder = vi.fn(() => ["layout-groups", "services", "bookmarks", "proxmox-vms", "disks"]);
```

Add `getLayoutOrder` to the object this `vi.hoisted` block returns, and to the outer destructured `const { ... } = vi.hoisted(...)` above it.

In the `useSWR` mock function, add a branch:

```js
const useSWR = vi.fn((key) => {
  if (key === "/api/validate") return { data: state.validateData };
  if (key === "/api/hash") return { data: state.hashData, mutate: state.mutateHash };
  if (key === "/api/services") return { data: state.servicesData };
  if (key === "/api/bookmarks") return { data: state.bookmarksData };
  if (key === "/api/widgets") return { data: state.widgetsData };
  if (key === "/api/layout-order") return { data: state.layoutOrderData, mutate: state.mutateLayoutOrder };
  return { data: undefined };
});
```

2. Add two new `vi.mock` calls, alongside the existing ones:

```js
vi.mock("utils/config/layoutOrder", () => ({
  getLayoutOrder,
  KNOWN_SECTION_IDS: ["layout-groups", "services", "bookmarks", "proxmox-vms", "disks"],
}));

vi.mock("components/layout/SortableSectionList", () => ({
  default: ({ sections, onReorder }) => {
    state.sortableSectionListProps = { sections, onReorder };
    return (
      <div data-testid="sortable-section-list">
        {sections.map(({ id, element }) => (
          <div key={id} data-testid={`section-${id}`}>
            {element}
          </div>
        ))}
      </div>
    );
  },
}));
```

3. In the `beforeEach` of the `"pages/index Index routing + SWR branches"` describe block, add resets:

```js
beforeEach(() => {
  vi.clearAllMocks();
  state.hashData = null;
  state.mutateHash.mockClear();
  state.servicesData = [];
  state.bookmarksData = [];
  state.widgetsData = [];
  state.layoutOrderData = null;
  state.sortableSectionListProps = null;
});
```

4. In the `beforeEach` of the `"pages/index Home behavior"` describe block, add the same two resets:

```js
beforeEach(() => {
  vi.clearAllMocks();
  state.validateData = [];
  state.hashData = null;
  state.servicesData = [
    {
      name: "Services",
      services: [{ name: "s1", href: "http://svc/1" }, { name: "s2" }],
      groups: [{ name: "Nested", services: [{ name: "s3", href: "http://svc/3" }], groups: [] }],
    },
  ];
  state.bookmarksData = [{ name: "Bookmarks", bookmarks: [{ name: "b1", href: "http://bm/1" }, { name: "b2" }] }];
  state.widgetsData = [{ type: "glances" }, { type: "search" }];
  state.quickLaunchProps = null;
  state.widgetCalls = [];
  state.layoutOrderData = null;
  state.sortableSectionListProps = null;
});
```

5. Run: `pnpm exec vitest run src/__tests__/pages/index.test.jsx`
   Expected: all pre-existing tests PASS again (the mocked `SortableSectionList` renders each section's `element` inside a plain `data-testid="section-<id>"` div, so `services-group`/`bookmarks-group` testids from the already-mocked `ServicesGroup`/`BookmarksGroup` are still found the same way).

- [ ] **Step 6: Add new tests for the ordering and persistence behavior**

Append to the `"pages/index Home behavior"` describe block in `src/__tests__/pages/index.test.jsx`:

```jsx
it("orders sections per the persisted layout order and drops empty blocks", async () => {
  state.servicesData = [];
  state.bookmarksData = [{ name: "Bookmarks", bookmarks: [{ name: "b1", href: "http://bm/1" }] }];
  state.layoutOrderData = { order: ["disks", "bookmarks", "proxmox-vms"] };

  await renderIndex({
    initialSettings: { title: "Homepage", layout: {} },
    settings: { title: "Homepage", layout: {}, language: "en" },
  });

  await waitFor(() => {
    expect(state.sortableSectionListProps).toBeTruthy();
  });
  expect(state.sortableSectionListProps.sections.map((s) => s.id)).toEqual(["disks", "bookmarks", "proxmox-vms"]);
});

it("keeps the optimistic order and updates the SWR cache when persisting succeeds", async () => {
  state.layoutOrderData = { order: ["layout-groups", "services", "bookmarks", "proxmox-vms", "disks"] };
  const persistedResponse = { order: ["disks", "layout-groups", "services", "bookmarks", "proxmox-vms"] };
  const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => persistedResponse }));
  fetch = fetchSpy;

  await renderIndex({
    initialSettings: { title: "Homepage", layout: {} },
    settings: { title: "Homepage", layout: {}, language: "en" },
  });

  await waitFor(() => {
    expect(state.sortableSectionListProps).toBeTruthy();
  });

  const newOrder = ["disks", "layout-groups", "services", "bookmarks", "proxmox-vms"];
  await state.sortableSectionListProps.onReorder(newOrder);

  expect(fetchSpy).toHaveBeenCalledWith(
    "/api/layout-order",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ order: newOrder }) }),
  );
  await waitFor(() => {
    expect(state.sortableSectionListProps.sections.map((s) => s.id)).toEqual(newOrder);
  });
});

it("optimistically reorders, then reverts when persisting fails", async () => {
  state.layoutOrderData = { order: ["layout-groups", "services", "bookmarks", "proxmox-vms", "disks"] };
  const fetchSpy = vi.fn(async () => ({ ok: false, status: 500 }));
  fetch = fetchSpy;

  await renderIndex({
    initialSettings: { title: "Homepage", layout: {} },
    settings: { title: "Homepage", layout: {}, language: "en" },
  });

  await waitFor(() => {
    expect(state.sortableSectionListProps).toBeTruthy();
  });

  const newOrder = ["disks", "proxmox-vms", "bookmarks", "services", "layout-groups"];
  await state.sortableSectionListProps.onReorder(newOrder);

  expect(fetchSpy).toHaveBeenCalled();
  await waitFor(() => {
    expect(state.sortableSectionListProps.sections.map((s) => s.id)).toEqual([
      "layout-groups",
      "services",
      "bookmarks",
      "proxmox-vms",
      "disks",
    ]);
  });
});
```

- [ ] **Step 7: Run the full test file to verify everything passes**

Run: `pnpm exec vitest run src/__tests__/pages/index.test.jsx`
Expected: PASS, all tests green (pre-existing + 3 new).

- [ ] **Step 8: Run the full suite, lint, and format**

Run: `pnpm test && pnpm lint && pnpm exec prettier --check "src/**/*.{js,jsx}"`
Expected: all green. This is the project-wide regression gate — a failure anywhere outside `index.jsx`/`index.test.jsx` means Step 2's restructuring changed something unintended; investigate before proceeding.

- [ ] **Step 9: Update `README.md`**

In the `## What this fork adds on top of Homepage` table in `README.md`, add a row (keeping the table's existing column order and style):

```markdown
| Drag-and-drop section reordering | ❌ none | ✅ live (drag whole dashboard sections into any order) |
```

Insert it after the `Disk health (SMART)` row.

- [ ] **Step 10: Commit**

```bash
git add src/pages/index.jsx src/__tests__/pages/index.test.jsx README.md
git commit -m "feat(layout): wire drag-and-drop section reordering into the dashboard"
```

---

## Self-Review Notes

- **Spec coverage:** whole-section drag-and-drop (Task 3+4), smooth reflow during drag (dnd-kit's built-in transform-based reflow, Task 3), server persistence in a dedicated file consistent across devices (Tasks 1-2), generic enough for native groups + custom sections + future widgets (the `KNOWN_SECTION_IDS`/`mergeLayoutOrder` design in Task 1 — a new widget adds one id, no rewrite), no auth gate (Task 2), no tab-level ordering (untouched `layout-groups` internal tab filter, Task 4 Step 2), drag-handle-only (Task 3's `SortableSection`, not whole-card) — all covered.
- **Type/interface consistency check:** `SortableSectionList`'s `sections` prop shape (`{id, element}[]`) matches what `src/pages/index.jsx`'s `sections` `useMemo` produces in Task 4 Step 3, and matches what both component tests in Task 3 construct. `onReorder(newIds: string[])` matches `handleReorder`'s parameter in Task 4 and `SortableSectionList`'s call site. `getLayoutOrder()`/`writeLayoutOrder()`'s return shape (`string[]`) matches what the route in Task 2 wraps as `{ order: ... }`, which matches what Task 4's `getStaticProps` fallback and client `useSWR("/api/layout-order")` both expect (`persistedSectionOrder?.order`).
- **No placeholders:** every step above contains complete, runnable code — no "add appropriate tests", no "similar to Task N" elisions.
