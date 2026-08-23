# Widget Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trash-can affordance to remove an installed widget in two places: on the live dashboard (service widgets only — removes just the `widget:` block, the service tile stays), and on the `/widgets` catalog page (both service and info widgets, via a new "Installed on:" lookup listing every current instance).

**Architecture:** Two new pure helpers in `yamlDocument.js` locate every currently-installed widget instance across `services.yaml`/`widgets.yaml`. A new `GET /api/widgets-catalog/installed` route reshapes that into a slug-keyed lookup for the `/widgets` page. A new `POST /api/widgets-catalog/uninstall` route does the actual removal — `fieldsNode.delete("widget")` for a service, an index-targeted splice (with a defensive slug-match check against a stale client) for an info entry — writing through the same `configWriter.writeConfigDocument` backup-then-validate guarantee the install feature already uses. A new `WidgetRemoveButton` component drops into the dashboard's existing `service-tags` button row (`src/components/services/item.jsx`) next to the pre-existing Docker/Kubernetes/Proxmox stats-toggle buttons, calling SWR's global `mutate("/api/services")` on success so the card re-renders without a manual reload. The `/widgets` page's `WidgetRow` gains an "Installed on:" list wired to the same uninstall route and its own SWR-mutated lookup.

**Tech Stack:** Next.js 16 (pages router) + React 19, `yaml` (existing dependency from the install feature), SWR, `react-icons/bi` (`BiTrash`, existing dependency), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-23-widget-uninstall-design.md`

## Global Constraints

- **Only the `widget:` key is ever removed for a service** — the service entry itself (href, description, other fields) is untouched. Confirmed explicitly with the project owner over deleting the whole service.
- **No dashboard-side removal affordance for info widgets** in this plan — only the `/widgets` catalog page's "Installed on:" list covers info widgets. This is an explicit spec Non-goal, not an oversight; don't add a dashboard button for info widgets.
- **Every write goes through `configWriter.writeConfigDocument`** — no task writes to `services.yaml`/`widgets.yaml` through any other path. This reuses the existing backup-before-write + re-parse-validate guarantee; no new safety mechanism is introduced.
- **Info-widget removal targets a positional index, never the slug alone** — `widgets.yaml` commonly has more than one entry with the same top-level key (e.g. two `resources:` blocks). The uninstall route must verify the slug at that index still matches what the client claims before removing (409 on mismatch), guarding against a stale "Installed on:" list.
- **The dashboard trash button only renders when a service has exactly one widget** (`service.widgets.length === 1`) — this plan's uninstall route only ever deletes the singular `widget:` key, not entries from a `widgets:` array (a separate, less common upstream Homepage feature this plan doesn't touch). Don't render the button for 0 or >1 widgets.
- **No authentication/authorization changes** — matches the install feature's own explicit deferral; this plan doesn't add or touch any access control.
- **pnpm only.**
- **Every new/modified module needs Vitest coverage**, and every task must leave `pnpm test`/the scoped vitest run, `pnpm lint`, `pnpm exec prettier --check`, and `pnpm build` all green. `pnpm build` is a hard requirement on this project after multiple prior features shipped build-breaking client/server bundle leaks that the other three checks alone didn't catch — never skip it.

---

### Task 1: `listInstalledServiceWidgets` + `listInstalledInfoWidgets` — pure lookup helpers

**Files:**

- Modify: `src/utils/config/yamlDocument.js`
- Modify: `src/utils/config/yamlDocument.test.js`

**Interfaces:**

- Produces (used by Tasks 2 and 3):

  - `listInstalledServiceWidgets(servicesDoc: yaml.Document): { type: string, serviceName: string }[]` — every service across every group that currently has a `widget:` block, with that widget's `type` and the service's own name. Returns `[]` on a non-Seq/empty doc.
  - `listInstalledInfoWidgets(widgetsDoc: yaml.Document): { slug: string, index: number }[]` — every top-level `widgets.yaml` entry, its single key as `slug` and its position in the top-level list as `index` (duplicates of the same slug are all listed, each with its own index). Returns `[]` on a non-Seq/empty doc.

- [ ] **Step 1: Write the failing tests**

Open `src/utils/config/yamlDocument.test.js` and add `listInstalledServiceWidgets` and `listInstalledInfoWidgets` to the existing import block at the top of the file (alphabetical order among the existing named imports from `"./yamlDocument"`), then add these two `describe` blocks after the existing `describe("ensureTopSeq", ...)` block (at the end of the file):

```js
describe("listInstalledServiceWidgets", () => {
  it("returns type and serviceName for every service that has a widget, across all groups", () => {
    const doc = parseDocument(`---
- Media:
    - Plex:
        href: http://plex.local/
        widget:
          type: plex
          url: http://x
    - Sonarr:
        href: http://sonarr.local/
- Downloads:
    - Transmission:
        href: http://transmission.local/
        widget:
          type: transmission
`);
    expect(listInstalledServiceWidgets(doc)).toEqual([
      { type: "plex", serviceName: "Plex" },
      { type: "transmission", serviceName: "Transmission" },
    ]);
  });

  it("returns an empty array instead of throwing when the doc has no top-level Seq", () => {
    expect(listInstalledServiceWidgets(EMPTY_DOC)).toEqual([]);
  });
});

describe("listInstalledInfoWidgets", () => {
  it("returns slug and index for every entry, including duplicate slugs", () => {
    const doc = parseDocument(`---
- resources:
    cpu: true
- resources:
    disk: /mnt
- datetime:
    text_size: xl
`);
    expect(listInstalledInfoWidgets(doc)).toEqual([
      { slug: "resources", index: 0 },
      { slug: "resources", index: 1 },
      { slug: "datetime", index: 2 },
    ]);
  });

  it("returns an empty array instead of throwing when the doc has no top-level Seq", () => {
    expect(listInstalledInfoWidgets(EMPTY_DOC)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/config/yamlDocument.test.js`
Expected: FAIL — `listInstalledServiceWidgets`/`listInstalledInfoWidgets` are not exported yet.

- [ ] **Step 3: Write the implementation**

In `src/utils/config/yamlDocument.js`, first change the top import line to also bring in `isMap`:

```js
import { Document, isMap, isSeq, parseDocument } from "yaml";
```

Then add these two functions after `ensureTopSeq` (at the end of the file):

```js
// Returns { type, serviceName } for every service, across every group, that
// currently has a widget: block.
export function listInstalledServiceWidgets(servicesDoc) {
  const results = [];
  const topSeq = servicesDoc.contents;
  if (!isSeq(topSeq)) return results;
  for (const groupMap of topSeq.items) {
    for (const groupPair of groupMap.items) {
      const servicesSeq = groupPair.value;
      for (const serviceMapWrapper of servicesSeq.items) {
        for (const servicePair of serviceMapWrapper.items) {
          const fieldsNode = servicePair.value;
          const widgetNode = fieldsNode.get("widget", true);
          if (isMap(widgetNode)) {
            const type = widgetNode.get("type");
            if (typeof type === "string") {
              results.push({ type, serviceName: servicePair.key.value });
            }
          }
        }
      }
    }
  }
  return results;
}

// Returns { slug, index } for every top-level widgets.yaml entry - slug is
// the entry's single key, index is its position in the top-level Seq.
// Duplicate slugs (e.g. two "resources" blocks) each get their own entry.
export function listInstalledInfoWidgets(widgetsDoc) {
  const results = [];
  const topSeq = widgetsDoc.contents;
  if (!isSeq(topSeq)) return results;
  topSeq.items.forEach((itemMap, index) => {
    if (isMap(itemMap) && itemMap.items.length > 0) {
      results.push({ slug: itemMap.items[0].key.value, index });
    }
  });
  return results;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/config/yamlDocument.test.js`
Expected: PASS, all tests green (existing tests plus the new ones).

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/utils/config/yamlDocument.js" "src/utils/config/yamlDocument.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/utils/config/yamlDocument.js src/utils/config/yamlDocument.test.js
git commit -m "feat(widget-uninstall): add installed-widget lookup helpers"
```

---

### Task 2: `GET /api/widgets-catalog/installed` route

**Files:**

- Create: `src/pages/api/widgets-catalog/installed/index.js`
- Create: `src/__tests__/pages/api/widgets-catalog/installed/index.test.js`

**Interfaces:**

- Consumes (from Task 1): `listInstalledInfoWidgets`, `listInstalledServiceWidgets` from `utils/config/yamlDocument`.
- Consumes (existing, from the install feature): `readConfigDocument` from `utils/config/configWriter`.
- Produces (used by Task 5's frontend, as an HTTP contract): `GET /api/widgets-catalog/installed` → `200 { services: { [slug: string]: string[] }, info: { [slug: string]: number[] } }` or `500 { error }`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/pages/api/widgets-catalog/installed/index.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import createMockRes from "test-utils/create-mock-res";

const { readConfigDocument } = vi.hoisted(() => ({ readConfigDocument: vi.fn() }));
vi.mock("utils/config/configWriter", () => ({ readConfigDocument }));

const { logger } = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/widgets-catalog/installed/index";

const SERVICES_FIXTURE = `---
- Media:
    - Plex:
        href: http://plex.local/
        widget:
          type: plex
          url: http://x
    - Sonarr:
        href: http://sonarr.local/
`;

const WIDGETS_FIXTURE = `---
- resources:
    cpu: true
- resources:
    disk: /mnt
- datetime:
    text_size: xl
`;

describe("pages/api/widgets-catalog/installed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for non-GET methods", async () => {
    const req = { method: "POST" };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns installed service and info widgets, keyed by slug", async () => {
    readConfigDocument.mockImplementation((filename) =>
      filename === "services.yaml" ? parseDocument(SERVICES_FIXTURE) : parseDocument(WIDGETS_FIXTURE),
    );

    const req = { method: "GET" };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      services: { plex: ["Plex"] },
      info: { resources: [0, 1], datetime: [2] },
    });
  });

  it("returns 500 and logs when reading fails", async () => {
    readConfigDocument.mockImplementation(() => {
      throw new Error("disk error");
    });

    const req = { method: "GET" };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/installed/index.test.js`
Expected: FAIL — `pages/api/widgets-catalog/installed/index` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/pages/api/widgets-catalog/installed/index.js`:

```js
import { readConfigDocument } from "utils/config/configWriter";
import { listInstalledInfoWidgets, listInstalledServiceWidgets } from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetsCatalogInstalled");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const servicesDoc = readConfigDocument("services.yaml");
    const widgetsDoc = readConfigDocument("widgets.yaml");

    const services = {};
    for (const { type, serviceName } of listInstalledServiceWidgets(servicesDoc)) {
      (services[type] ??= []).push(serviceName);
    }

    const info = {};
    for (const { slug, index } of listInstalledInfoWidgets(widgetsDoc)) {
      (info[slug] ??= []).push(index);
    }

    return res.status(200).json({ services, info });
  } catch (e) {
    logger.error("Failed to read installed widgets:", e);
    return res.status(500).json({ error: "Failed to read configuration" });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/installed/index.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/api/widgets-catalog/installed/index.js" "src/__tests__/pages/api/widgets-catalog/installed/index.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/widgets-catalog/installed/index.js src/__tests__/pages/api/widgets-catalog/installed/index.test.js
git commit -m "feat(widget-uninstall): add GET /api/widgets-catalog/installed route"
```

---

### Task 3: `POST /api/widgets-catalog/uninstall` route

**Files:**

- Create: `src/pages/api/widgets-catalog/uninstall/index.js`
- Create: `src/__tests__/pages/api/widgets-catalog/uninstall/index.test.js`

**Interfaces:**

- Consumes (existing, from the install feature): `findServiceFieldsNode` from `utils/config/yamlDocument`; `readConfigDocument`, `writeConfigDocument` from `utils/config/configWriter`.
- Produces (used by Tasks 4 and 5's frontend, as an HTTP contract, not a JS import):

  - `POST /api/widgets-catalog/uninstall` with body `{ category: "service", serviceName }` or `{ category: "info", slug, index }`.
  - `200 { success: true, backupFile: string | null }`, `400 { error }`, `404 { error }`, `405 { error }`, `409 { error }`, `500 { error }`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/pages/api/widgets-catalog/uninstall/index.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import createMockRes from "test-utils/create-mock-res";

const { readConfigDocument, writeConfigDocument } = vi.hoisted(() => ({
  readConfigDocument: vi.fn(),
  writeConfigDocument: vi.fn(),
}));
vi.mock("utils/config/configWriter", () => ({ readConfigDocument, writeConfigDocument }));

const { logger } = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/widgets-catalog/uninstall/index";

const SERVICES_FIXTURE = `---
- Media:
    - Plex:
        href: http://plex.local/
        widget:
          type: plex
          url: http://x
    - Sonarr:
        href: http://sonarr.local/
`;

const WIDGETS_FIXTURE = `---
- resources:
    cpu: true
- datetime:
    text_size: xl
`;

describe("pages/api/widgets-catalog/uninstall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for non-POST methods", async () => {
    const req = { method: "GET" };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 for an unknown category", async () => {
    const req = { method: "POST", body: { category: "bogus" } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  describe("category: service", () => {
    it("removes the widget block and returns the backup filename", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
      writeConfigDocument.mockReturnValue("services.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = { method: "POST", body: { category: "service", serviceName: "Plex" } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, backupFile: "services.yaml.bak.2026-08-23T00-00-00-000Z" });

      const [, doc] = writeConfigDocument.mock.calls[0];
      const out = doc.toString();
      expect(out).not.toContain("widget:");
      expect(out).toContain("Plex");
      expect(out).toContain("http://plex.local/");
    });

    it("returns 400 when serviceName is missing", async () => {
      const req = { method: "POST", body: { category: "service" } };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(readConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 404 when the service doesn't exist", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

      const req = { method: "POST", body: { category: "service", serviceName: "DoesNotExist" } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 404 when the service exists but has no widget", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

      const req = { method: "POST", body: { category: "service", serviceName: "Sonarr" } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });
  });

  describe("category: info", () => {
    it("removes the item at the given index and returns the backup filename", async () => {
      readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));
      writeConfigDocument.mockReturnValue("widgets.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = { method: "POST", body: { category: "info", slug: "resources", index: 0 } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const [, doc] = writeConfigDocument.mock.calls[0];
      const out = doc.toString();
      expect(out).not.toContain("resources");
      expect(out).toContain("datetime");
    });

    it("returns 400 when slug or index is missing", async () => {
      const req = { method: "POST", body: { category: "info", slug: "resources" } };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 when the index is out of range", async () => {
      readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));

      const req = { method: "POST", body: { category: "info", slug: "resources", index: 99 } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 409 when the slug at that index no longer matches (stale client)", async () => {
      readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));

      const req = { method: "POST", body: { category: "info", slug: "datetime", index: 0 } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(409);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });
  });

  it("returns 500 and logs when the write throws", async () => {
    readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
    writeConfigDocument.mockImplementation(() => {
      throw new Error("disk full");
    });

    const req = { method: "POST", body: { category: "service", serviceName: "Plex" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/uninstall/index.test.js`
Expected: FAIL — `pages/api/widgets-catalog/uninstall/index` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/pages/api/widgets-catalog/uninstall/index.js`:

```js
import { readConfigDocument, writeConfigDocument } from "utils/config/configWriter";
import { findServiceFieldsNode } from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetUninstall");

function uninstallService(req, res) {
  const { serviceName } = req.body ?? {};
  if (typeof serviceName !== "string" || !serviceName.trim()) {
    return res.status(400).json({ error: "serviceName is required" });
  }

  const doc = readConfigDocument("services.yaml");
  const fieldsNode = findServiceFieldsNode(doc, serviceName);
  if (!fieldsNode) {
    return res.status(404).json({ error: `Service '${serviceName}' not found` });
  }
  if (!fieldsNode.has("widget")) {
    return res.status(404).json({ error: `Service '${serviceName}' has no widget to remove` });
  }

  fieldsNode.delete("widget");
  const backupFile = writeConfigDocument("services.yaml", doc);
  return res.status(200).json({ success: true, backupFile });
}

function uninstallInfo(req, res) {
  const { slug, index } = req.body ?? {};
  if (typeof slug !== "string" || !slug.trim() || typeof index !== "number" || index < 0) {
    return res.status(400).json({ error: "slug and index are required" });
  }

  const doc = readConfigDocument("widgets.yaml");
  const topSeq = doc.contents;
  const itemMap = topSeq?.items?.[index];
  if (!itemMap) {
    return res.status(404).json({ error: `No widgets.yaml entry at index ${index}` });
  }
  const actualSlug = itemMap.items?.[0]?.key?.value;
  if (actualSlug !== slug) {
    return res.status(409).json({ error: "widgets.yaml has changed since this list was loaded - please refresh" });
  }

  topSeq.items.splice(index, 1);
  const backupFile = writeConfigDocument("widgets.yaml", doc);
  return res.status(200).json({ success: true, backupFile });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { category } = req.body ?? {};

  try {
    if (category === "service") {
      return uninstallService(req, res);
    }
    if (category === "info") {
      return uninstallInfo(req, res);
    }
    return res.status(400).json({ error: "category must be 'service' or 'info'" });
  } catch (e) {
    logger.error("Widget uninstall failed:", e);
    return res.status(500).json({ error: "Failed to write configuration" });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/uninstall/index.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/api/widgets-catalog/uninstall/index.js" "src/__tests__/pages/api/widgets-catalog/uninstall/index.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/widgets-catalog/uninstall/index.js src/__tests__/pages/api/widgets-catalog/uninstall/index.test.js
git commit -m "feat(widget-uninstall): add POST /api/widgets-catalog/uninstall route"
```

---

### Task 4: `WidgetRemoveButton` component, wired into the dashboard

**Files:**

- Create: `src/components/services/widget-remove-button.jsx`
- Create: `src/components/services/widget-remove-button.test.jsx`
- Modify: `src/components/services/item.jsx`
- Modify: `src/components/services/item.test.jsx`

**Interfaces:**

- Consumes (as an HTTP contract, from Task 3): `POST /api/widgets-catalog/uninstall`.
- Consumes: `mutate` from `swr` (the package's global/unbound mutate function, not a hook — works without an `SWRConfig`/`useSWR` subscription in this component).
- Produces (used by this task's own `item.jsx` change): `WidgetRemoveButton({ serviceName: string })` — a default-exported React component with no other props.

- [ ] **Step 1: Write the failing tests**

Create `src/components/services/widget-remove-button.test.jsx`:

```jsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", () => ({ mutate }));

import WidgetRemoveButton from "./widget-remove-button";

describe("components/services/widget-remove-button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("shows a trash icon that flips to Remove?/Cancel on click", () => {
    render(<WidgetRemoveButton serviceName="Plex" />);

    expect(screen.getByRole("button", { name: "Remove widget" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove?" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));

    expect(screen.getByRole("button", { name: "Remove?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("cancel returns to the icon button without calling the API", () => {
    render(<WidgetRemoveButton serviceName="Plex" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Remove widget" })).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("confirming calls the uninstall route with the service name and revalidates /api/services", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, backupFile: "x" }) });

    render(<WidgetRemoveButton serviceName="Plex" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove?" }));

    await waitFor(() => expect(mutate).toHaveBeenCalledWith("/api/services"));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/widgets-catalog/uninstall",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ category: "service", serviceName: "Plex" }),
      }),
    );
  });

  it("shows an inline error and stays in confirm mode when the request fails", async () => {
    global.fetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    render(<WidgetRemoveButton serviceName="Plex" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove widget" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove?" }));

    await waitFor(() => expect(screen.getByText("Failed")).toBeInTheDocument());
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove?" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/components/services/widget-remove-button.test.jsx`
Expected: FAIL — `./widget-remove-button` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/components/services/widget-remove-button.jsx`:

```jsx
import { useState } from "react";
import { BiTrash } from "react-icons/bi";
import { mutate } from "swr";

export default function WidgetRemoveButton({ serviceName }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    setError(false);
    try {
      const res = await fetch("/api/widgets-catalog/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "service", serviceName }),
      });
      if (!res.ok) {
        setRemoving(false);
        setError(true);
        return;
      }
      await mutate("/api/services");
      setRemoving(false);
      setConfirming(false);
    } catch {
      setRemoving(false);
      setError(true);
    }
  };

  if (confirming) {
    return (
      <div className="shrink-0 flex items-center gap-1 service-tag service-widget-remove-confirm text-[10px]">
        {error && <span className="text-rose-500/80">Failed</span>}
        <button type="button" onClick={handleRemove} disabled={removing} className="cursor-pointer">
          {removing ? "..." : "Remove?"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} disabled={removing} className="cursor-pointer">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="shrink-0 flex items-center justify-center cursor-pointer service-tag service-widget-remove"
    >
      <BiTrash size={14} />
      <span className="sr-only">Remove widget</span>
    </button>
  );
}
```

- [ ] **Step 4: Run the widget-remove-button tests to verify they pass**

Run: `pnpm exec vitest run src/components/services/widget-remove-button.test.jsx`
Expected: PASS, all tests green.

- [ ] **Step 5: Write the failing item.jsx test**

Open `src/components/services/item.test.jsx` and add this test at the end of the `describe("components/services/item", ...)` block, right before the final closing `});`:

```jsx
it("shows the remove-widget button only when the service has exactly one widget", () => {
  renderWithProviders(
    <Item
      groupName="G"
      useEqualHeights={false}
      service={{ id: "svc1", name: "My Service", href: "https://example.com", widgets: [] }}
    />,
    { settings: { showStats: false, statusStyle: "basic" } },
  );
  expect(screen.queryByRole("button", { name: "Remove widget" })).not.toBeInTheDocument();

  renderWithProviders(
    <Item
      groupName="G"
      useEqualHeights={false}
      service={{ id: "svc2", name: "Plex", href: "https://example.com", widgets: [{ type: "plex", index: 0 }] }}
    />,
    { settings: { showStats: false, statusStyle: "basic" } },
  );
  expect(screen.getByRole("button", { name: "Remove widget" })).toBeInTheDocument();

  renderWithProviders(
    <Item
      groupName="G"
      useEqualHeights={false}
      service={{
        id: "svc3",
        name: "Multi",
        href: "https://example.com",
        widgets: [
          { type: "plex", index: 0 },
          { type: "sonarr", index: 1 },
        ],
      }}
    />,
    { settings: { showStats: false, statusStyle: "basic" } },
  );
  // Still exactly one - contributed by svc2 only, since svc1 has zero widgets and svc3 has two.
  expect(screen.getAllByRole("button", { name: "Remove widget" })).toHaveLength(1);
});
```

- [ ] **Step 6: Run the item.jsx test to verify it fails**

Run: `pnpm exec vitest run src/components/services/item.test.jsx`
Expected: FAIL — no "Remove widget" button exists yet (the other pre-existing tests in this file still pass).

- [ ] **Step 7: Wire the button into item.jsx**

In `src/components/services/item.jsx`, add the import (alphabetically, after `import Status from "./status";` and before `import Widget from "./widget";`):

```js
import WidgetRemoveButton from "./widget-remove-button";
```

Then, inside the `service-tags` div, add this block immediately after the existing `{service.proxmoxNode && service.proxmoxVMID && (...)}` block and before the closing `</div>` of that same `service-tags` div:

```jsx
{
  service.widgets?.length === 1 && <WidgetRemoveButton serviceName={service.name} />;
}
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `pnpm exec vitest run src/components/services/widget-remove-button.test.jsx src/components/services/item.test.jsx`
Expected: PASS, all tests green (all pre-existing `item.test.jsx` tests plus the new one).

- [ ] **Step 9: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/components/services/widget-remove-button.jsx" "src/components/services/widget-remove-button.test.jsx" "src/components/services/item.jsx" "src/components/services/item.test.jsx" && pnpm build`
Expected: all clean/green.

- [ ] **Step 10: Commit**

```bash
git add src/components/services/widget-remove-button.jsx src/components/services/widget-remove-button.test.jsx src/components/services/item.jsx src/components/services/item.test.jsx
git commit -m "feat(widget-uninstall): add dashboard remove-widget button"
```

---

### Task 5: "Installed on:" list on `/widgets`

**Files:**

- Modify: `src/pages/widgets.jsx`
- Modify: `src/__tests__/pages/widgets.test.jsx`

**Interfaces:**

- Consumes (as an HTTP contract, from Tasks 2 and 3): `GET /api/widgets-catalog/installed`, `POST /api/widgets-catalog/uninstall`.

- [ ] **Step 1: Write the failing tests**

Open `src/__tests__/pages/widgets.test.jsx` and add these two `it` blocks inside the existing `describe("pages/widgets", ...)` block, after the `"does not show an Install button for a widget with no YAML example"` test:

```jsx
it('shows an "Installed on:" list with a trash icon for a service widget, and calls uninstall on confirm', async () => {
  global.fetch = vi.fn((url) => {
    if (url === "/api/widgets-catalog") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(catalogResponse) });
    }
    if (url === "/api/widgets-catalog/installed") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ services: { plex: ["My Plex"] }, info: {} }),
      });
    }
    if (url === "/api/widgets-catalog/uninstall") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, backupFile: "x" }) });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  renderWithSWR(<WidgetsPage />);
  await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

  screen.getByText("Plex").click();
  await waitFor(() => expect(screen.getByText("Installed on:")).toBeInTheDocument());
  expect(screen.getByText("My Plex")).toBeInTheDocument();

  const installedCallsBefore = global.fetch.mock.calls.filter(
    ([url]) => url === "/api/widgets-catalog/installed",
  ).length;

  fireEvent.click(screen.getByRole("button", { name: "Remove My Plex" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove?" }));

  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/widgets-catalog/uninstall",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ category: "service", serviceName: "My Plex" }),
      }),
    ),
  );

  await waitFor(() => {
    const installedCallsAfter = global.fetch.mock.calls.filter(
      ([url]) => url === "/api/widgets-catalog/installed",
    ).length;
    expect(installedCallsAfter).toBeGreaterThan(installedCallsBefore);
  });
});

it('does not show an "Installed on:" section when nothing is installed', async () => {
  global.fetch = vi.fn((url) => {
    if (url === "/api/widgets-catalog") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(catalogResponse) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ services: {}, info: {} }) });
  });

  renderWithSWR(<WidgetsPage />);
  await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

  screen.getByText("Plex").click();
  await waitFor(() => expect(screen.getByText("Copy")).toBeInTheDocument());
  expect(screen.queryByText("Installed on:")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/widgets.test.jsx`
Expected: FAIL — no "Installed on:" section exists yet (the pre-existing tests in this file still pass).

- [ ] **Step 3: Update the implementation**

In `src/pages/widgets.jsx`, add the `BiTrash` import after the existing imports (before the `fetcher` const):

```js
import { BiTrash } from "react-icons/bi";
```

Add a new `InstalledInstanceRow` component right after the `matchesQuery` function and before `WidgetRow`:

```jsx
function InstalledInstanceRow({ label, onRemove }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    setError(false);
    const ok = await onRemove();
    setRemoving(false);
    if (!ok) {
      setError(true);
      return;
    }
    setConfirming(false);
  };

  return (
    <li className="flex items-center justify-between gap-2 py-0.5 text-xs">
      <span>{label}</span>
      {confirming ? (
        <span className="flex items-center gap-2">
          {error && <span className="text-rose-500/80">Failed</span>}
          <button type="button" onClick={handleRemove} disabled={removing} className="text-rose-500/80">
            {removing ? "Removing..." : "Remove?"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={removing}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} aria-label={`Remove ${label}`}>
          <BiTrash size={14} />
        </button>
      )}
    </li>
  );
}
```

Change the `WidgetRow` function signature to accept `installed` and `mutateInstalled`, and add the lookup/removal logic right after the existing `dialogEntry` line:

```jsx
function WidgetRow({ entry, category, installed, mutateInstalled }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const preRef = useRef(null);
  const themeContext = useContext(ThemeContext);
  const dialogEntry = useMemo(() => ({ ...entry, category }), [entry, category]);

  const installedServiceNames = category === "service" ? (installed?.services?.[entry.slug] ?? []) : [];
  const installedInfoIndexes = category === "info" ? (installed?.info?.[entry.slug] ?? []) : [];
  const hasInstalled = installedServiceNames.length > 0 || installedInfoIndexes.length > 0;

  const removeInstance = async (body) => {
    try {
      const res = await fetch("/api/widgets-catalog/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return false;
      await mutateInstalled();
      return true;
    } catch {
      return false;
    }
  };

  const handleCopy = async () => {
```

(The `handleCopy` function body below that line is unchanged - only the new code above it and the function signature line are new.)

Finally, inside the `{expanded && (...)}` block, add the "Installed on:" section as the first child, right after `<div className="mt-2 text-xs">` and before the `{entry.yamlExample ? (...) : (...)}` conditional:

```jsx
      {expanded && (
        <div className="mt-2 text-xs">
          {hasInstalled && (
            <div className="mb-2">
              <p className="font-medium mb-1">Installed on:</p>
              <ul>
                {installedServiceNames.map((name) => (
                  <InstalledInstanceRow
                    key={name}
                    label={name}
                    onRemove={() => removeInstance({ category: "service", serviceName: name })}
                  />
                ))}
                {installedInfoIndexes.map((index, i) => (
                  <InstalledInstanceRow
                    key={index}
                    label={`Instance #${i + 1}`}
                    onRemove={() => removeInstance({ category: "info", slug: entry.slug, index })}
                  />
                ))}
              </ul>
            </div>
          )}
          {entry.yamlExample ? (
```

(Everything from `{entry.yamlExample ? (` onward through the rest of the file is unchanged - this only adds the new `hasInstalled` block directly above it, inside the same wrapping `<div className="mt-2 text-xs">`.)

Update `WidgetsPage` to fetch the installed lookup and pass it down:

```jsx
export default function WidgetsPage() {
  const { data, error } = useSWR("/api/widgets-catalog", fetcher);
  const { data: installed, mutate: mutateInstalled } = useSWR("/api/widgets-catalog/installed", fetcher);
  const [query, setQuery] = useState("");
```

And update both `WidgetRow` usages to pass the new props:

```jsx
          <h2 className="text-sm font-medium mt-2">Service Widgets</h2>
          <ul>
            {data.services
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow
                  key={entry.slug}
                  entry={entry}
                  category="service"
                  installed={installed}
                  mutateInstalled={mutateInstalled}
                />
              ))}
          </ul>

          <h2 className="text-sm font-medium mt-4">Info Widgets</h2>
          <ul>
            {data.info
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow
                  key={entry.slug}
                  entry={entry}
                  category="info"
                  installed={installed}
                  mutateInstalled={mutateInstalled}
                />
              ))}
          </ul>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/widgets.test.jsx`
Expected: PASS, all tests green (all pre-existing tests plus the two new ones).

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/widgets.jsx" "src/__tests__/pages/widgets.test.jsx" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/widgets.jsx src/__tests__/pages/widgets.test.jsx
git commit -m "feat(widget-uninstall): add Installed-on list to /widgets"
```
