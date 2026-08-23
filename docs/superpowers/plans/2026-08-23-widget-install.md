# Widget One-Click Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user install a widget from `/widgets` directly into their real `services.yaml` (service widgets, attach-to-existing or add-as-new-service) or `widgets.yaml` (info widgets, append), via a disclaimer-gated wizard, with an automatic backup before every write.

**Architecture:** A new `yaml` (eemeli/yaml) dependency's `Document` API preserves comments/formatting on write, unlike the existing `js-yaml` (which stays for every other read path, unchanged). A pure `yamlDocument.js` module navigates the project's real `services.yaml`/`widgets.yaml` shapes (group→service nesting; flat list) and parses the widget doc's YAML fragment. A `configWriter.js` I/O layer reads/parses a config file, and writes it back only after creating a timestamped backup and re-parsing the mutated output to confirm it's still valid YAML. Two new API routes (`POST /api/widgets-catalog/install`, `GET /api/widgets-catalog/services`) expose this to the frontend. A `InstallWizardDialog` component (Headless UI `Dialog`) walks the user through target selection (service widgets only) → editable YAML preview → disclaimer + risk checkbox → result, and is wired into `WidgetRow` in `/widgets` via a new "Install..." button next to the existing "Copy" button.

**Tech Stack:** Next.js 16 (pages router) + React 19, `yaml` (new dependency), `js-yaml` (existing, untouched), `@headlessui/react` `Dialog` (new usage of an existing dependency), SWR, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-23-widget-install-design.md`

## Global Constraints

- **Every write to `services.yaml`/`widgets.yaml` is preceded by an automatic timestamped backup** created by `configWriter.js`'s `writeConfigDocument`, and the mutated document is re-parsed to confirm it's still valid YAML before the write is committed to disk. No task writes to either file through any other path.
- **The server never trusts client-supplied YAML.** `yamlSnippet` in every install request is re-parsed and validated server-side via `yamlDocument.js`'s `parseWidgetFragment`/`parseInfoWidgetSnippet` — never assumed valid because the client already showed it in a preview.
- **No authentication/authorization changes in this plan.** Security hardening around who can reach these new write-capable routes is explicitly out of scope for this phase (see spec's Non-goals) — do not add any access-control code.
- **New dependency `yaml@^2.9.0`** is added in Task 1 via `pnpm add`. `js-yaml` is untouched and keeps handling every existing read path in this codebase — this is additive, not a replacement.
- **Reuse `checkAndCopyConfig` (default export) and `CONF_DIR` (named export) from `utils/config/config`** for path resolution and skeleton-copy behavior — do not hand-roll config-directory logic.
- **Reuse `@headlessui/react`'s `Dialog`/`DialogBackdrop`/`DialogPanel`/`DialogTitle`** (v2 API, confirmed present in the installed `^2.2.10`) for the install wizard — do not hand-roll focus-trap/Escape/backdrop-click handling. Follow the existing convention (`dropdown.test.jsx`, `NavHeader.test.jsx`) of stubbing `@headlessui/react` with simplified deterministic components in tests rather than exercising the real library's animation/portal behavior.
- **Test file placement follows existing precedent exactly:** pure/I-O utility modules under `src/utils/**` get a co-located `*.test.js` next to the source file (matching `layoutOrder.server.test.js`, `config.test.js`); new routes under `src/pages/api/widgets-catalog/**` get their test mirrored into `src/__tests__/pages/api/widgets-catalog/**` (matching the sibling `src/__tests__/pages/api/widgets-catalog/index.test.js` from the prior widgets-catalog feature); new components under `src/components/**` get a co-located `*.test.jsx` (matching `dropdown.test.jsx`).
- **pnpm only.**
- **Every new/modified module needs Vitest coverage**, and every task must leave `pnpm test`, `pnpm lint`, `pnpm exec prettier --check` (on the task's touched files), and `pnpm build` all green. `pnpm build` is a hard requirement on this project after two prior features shipped build-breaking client/server bundle leaks that the other three checks alone didn't catch — never skip it.

---

### Task 1: `yaml` dependency + `yamlDocument.js` — pure YAML navigation/parsing helpers

**Files:**

- Modify: `package.json` (via `pnpm add`, not a hand-edit)
- Create: `src/utils/config/yamlDocument.js`
- Create: `src/utils/config/yamlDocument.test.js`

**Interfaces:**

- Produces (used by Tasks 3 and 4):

  - `findServiceFieldsNode(servicesDoc: yaml.Document, serviceName: string): yaml.YAMLMap | null` — the fields map for a named service, searched across all groups.
  - `findGroupServicesSeq(servicesDoc: yaml.Document, groupName: string): yaml.YAMLSeq | null` — the services list for a named group.
  - `listServiceNames(servicesDoc: yaml.Document): string[]` — every service name across all groups, in document order.
  - `listGroupNames(servicesDoc: yaml.Document): string[]` — every group name, in document order.
  - `parseWidgetFragment(yamlSnippet: unknown): yaml.YAMLMap` — parses a `"widget:\n  ..."` fragment and returns the value node of its `widget` key. Throws `Error` with a descriptive message if `yamlSnippet` isn't a non-empty string, isn't valid YAML, or has no top-level `widget` key.
  - `parseInfoWidgetSnippet(yamlSnippet: unknown): yaml.YAMLMap` — parses a standalone single-item list snippet (e.g. `"- datetime:\n    text_size: xl"`) and returns that one item's node. Throws `Error` if `yamlSnippet` isn't a non-empty string, isn't valid YAML, or isn't exactly one top-level list item.

- [ ] **Step 1: Add the `yaml` dependency**

Run: `pnpm add yaml@^2.9.0`
Expected: `package.json` and `pnpm-lock.yaml` updated; `dependencies.yaml` present.

- [ ] **Step 2: Write the failing tests**

Create `src/utils/config/yamlDocument.test.js`:

```js
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

import {
  findGroupServicesSeq,
  findServiceFieldsNode,
  listGroupNames,
  listServiceNames,
  parseInfoWidgetSnippet,
  parseWidgetFragment,
} from "./yamlDocument";

// Shaped like the project's real src/skeleton/services.yaml, extended with a
// second group so group-vs-service traversal is actually exercised.
const SERVICES_FIXTURE = `---
# For configuration options and examples, please see:
# https://gethomepage.dev/configs/services/

- Media:
    - Plex:
        href: http://plex.local/
        description: My Plex server
    - Sonarr:
        href: http://sonarr.local/
- Downloads:
    - Transmission:
        href: http://transmission.local/
`;

describe("findServiceFieldsNode", () => {
  it("finds a service's fields node across multiple groups", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    const fields = findServiceFieldsNode(doc, "Transmission");
    expect(fields.toJSON()).toEqual({ href: "http://transmission.local/" });
  });

  it("returns null when the service doesn't exist", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    expect(findServiceFieldsNode(doc, "DoesNotExist")).toBeNull();
  });
});

describe("findGroupServicesSeq", () => {
  it("finds a group's services sequence by name", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    const seq = findGroupServicesSeq(doc, "Media");
    expect(seq.items).toHaveLength(2);
  });

  it("returns null when the group doesn't exist", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    expect(findGroupServicesSeq(doc, "DoesNotExist")).toBeNull();
  });
});

describe("listServiceNames", () => {
  it("returns every service name across all groups, in document order", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    expect(listServiceNames(doc)).toEqual(["Plex", "Sonarr", "Transmission"]);
  });
});

describe("listGroupNames", () => {
  it("returns every group name, in document order", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    expect(listGroupNames(doc)).toEqual(["Media", "Downloads"]);
  });
});

describe("parseWidgetFragment", () => {
  it("returns the widget value node from a valid fragment", () => {
    const node = parseWidgetFragment(
      "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere\n",
    );
    expect(node.toJSON()).toEqual({ type: "plex", url: "http://plex.host.or.ip:32400", key: "mytokenhere" });
  });

  it("throws when the fragment has no top-level 'widget' key", () => {
    expect(() => parseWidgetFragment("not-a-widget-key: 1\n")).toThrow("must have a top-level 'widget' key");
  });

  it("throws on invalid YAML syntax", () => {
    expect(() => parseWidgetFragment("widget:\n  type: plex\n\ttab-indent: bad\n")).toThrow("Invalid widget YAML");
  });

  it("throws when yamlSnippet is missing or empty", () => {
    expect(() => parseWidgetFragment("")).toThrow("yamlSnippet is required");
    expect(() => parseWidgetFragment(undefined)).toThrow("yamlSnippet is required");
  });
});

describe("parseInfoWidgetSnippet", () => {
  it("returns the single list-item node from a valid snippet", () => {
    const node = parseInfoWidgetSnippet("- datetime:\n    text_size: xl\n");
    expect(node.toJSON()).toEqual({ datetime: { text_size: "xl" } });
  });

  it("throws when the snippet has more than one top-level list item", () => {
    expect(() =>
      parseInfoWidgetSnippet("- datetime:\n    text_size: xl\n- search:\n    provider: duckduckgo\n"),
    ).toThrow("exactly one top-level list item");
  });

  it("throws when the snippet isn't a list at all", () => {
    expect(() => parseInfoWidgetSnippet("datetime:\n  text_size: xl\n")).toThrow("exactly one top-level list item");
  });

  it("throws on invalid YAML syntax", () => {
    expect(() => parseInfoWidgetSnippet("- datetime:\n\ttab-indent: bad\n")).toThrow("Invalid widget YAML");
  });

  it("throws when yamlSnippet is missing or empty", () => {
    expect(() => parseInfoWidgetSnippet("")).toThrow("yamlSnippet is required");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/config/yamlDocument.test.js`
Expected: FAIL — `./yamlDocument` has no exports yet (file doesn't exist).

- [ ] **Step 4: Write the implementation**

Create `src/utils/config/yamlDocument.js`:

```js
import { isSeq, parseDocument } from "yaml";

// services.yaml shape: top-level Seq of single-key group Maps, each group's
// value a Seq of single-key service Maps, each service's value a Map of
// fields (href, description, widget, ...).

export function findServiceFieldsNode(servicesDoc, serviceName) {
  const topSeq = servicesDoc.contents;
  for (const groupMap of topSeq.items) {
    for (const groupPair of groupMap.items) {
      const servicesSeq = groupPair.value;
      for (const serviceMapWrapper of servicesSeq.items) {
        for (const servicePair of serviceMapWrapper.items) {
          if (servicePair.key.value === serviceName) {
            return servicePair.value;
          }
        }
      }
    }
  }
  return null;
}

export function findGroupServicesSeq(servicesDoc, groupName) {
  const topSeq = servicesDoc.contents;
  for (const groupMap of topSeq.items) {
    for (const groupPair of groupMap.items) {
      if (groupPair.key.value === groupName) {
        return groupPair.value;
      }
    }
  }
  return null;
}

export function listServiceNames(servicesDoc) {
  const names = [];
  const topSeq = servicesDoc.contents;
  for (const groupMap of topSeq.items) {
    for (const groupPair of groupMap.items) {
      for (const serviceMapWrapper of groupPair.value.items) {
        for (const servicePair of serviceMapWrapper.items) {
          names.push(servicePair.key.value);
        }
      }
    }
  }
  return names;
}

export function listGroupNames(servicesDoc) {
  const names = [];
  const topSeq = servicesDoc.contents;
  for (const groupMap of topSeq.items) {
    for (const groupPair of groupMap.items) {
      names.push(groupPair.key.value);
    }
  }
  return names;
}

function assertYamlSnippet(yamlSnippet) {
  if (typeof yamlSnippet !== "string" || !yamlSnippet.trim()) {
    throw new Error("yamlSnippet is required");
  }
}

// Parses a widget doc's "widget:\n  type: ...\n  ..." fragment and returns
// the value node of the widget key - ready to .set("widget", node) onto a
// service's fields Map.
export function parseWidgetFragment(yamlSnippet) {
  assertYamlSnippet(yamlSnippet);
  const doc = parseDocument(yamlSnippet);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid widget YAML: ${doc.errors[0].message}`);
  }
  const widgetNode = doc.get("widget", true);
  if (!widgetNode) {
    throw new Error("Widget YAML fragment must have a top-level 'widget' key");
  }
  return widgetNode;
}

// Parses an info widget doc's standalone list-item YAML (e.g.
// "- datetime:\n    text_size: xl") and returns the single Map node
// representing that list item - ready to push onto widgets.yaml's top Seq.
export function parseInfoWidgetSnippet(yamlSnippet) {
  assertYamlSnippet(yamlSnippet);
  const doc = parseDocument(yamlSnippet);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid widget YAML: ${doc.errors[0].message}`);
  }
  if (!isSeq(doc.contents) || doc.contents.items.length !== 1) {
    throw new Error("Info widget YAML must be exactly one top-level list item");
  }
  return doc.contents.items[0];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/config/yamlDocument.test.js`
Expected: PASS, all tests green.

- [ ] **Step 6: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/utils/config/yamlDocument.js" "src/utils/config/yamlDocument.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/utils/config/yamlDocument.js src/utils/config/yamlDocument.test.js
git commit -m "feat(widget-install): add yaml dependency and yamlDocument helpers"
```

---

### Task 2: `configWriter.js` — read/backup/write I/O layer

**Files:**

- Create: `src/utils/config/configWriter.js`
- Create: `src/utils/config/configWriter.test.js`

**Interfaces:**

- Consumes (from Task 1's `package.json` dependency, not its module): `parseDocument` from `yaml`.
- Consumes: `checkAndCopyConfig` (default export), `CONF_DIR` (named export) from `utils/config/config`.
- Produces (used by Tasks 3 and 4):

  - `readConfigDocument(filename: string): yaml.Document` — ensures the file exists (via `checkAndCopyConfig`), reads and parses it. Throws `Error` if the file's content isn't valid YAML.
  - `writeConfigDocument(filename: string, doc: { toString(): string }): string` — if a file already exists at `filename`, copies it to a timestamped backup first; re-parses the document's `toString()` output to confirm it's still valid YAML (throwing and refusing to write if not); writes the file; returns the backup file's basename (or `null` if no backup was made because the file didn't exist yet).

- [ ] **Step 1: Write the failing tests**

Create `src/utils/config/configWriter.test.js`:

```js
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  copyFileSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const { checkAndCopyConfig } = vi.hoisted(() => ({ checkAndCopyConfig: vi.fn() }));
vi.mock("utils/config/config", () => ({ default: checkAndCopyConfig, CONF_DIR: "/config" }));

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import { readConfigDocument, writeConfigDocument } from "./configWriter";

describe("readConfigDocument", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ensures the config exists, then reads and parses it", () => {
    readFileSync.mockReturnValue("- resources:\n    cpu: true\n");

    const doc = readConfigDocument("widgets.yaml");

    expect(checkAndCopyConfig).toHaveBeenCalledWith("widgets.yaml");
    expect(readFileSync).toHaveBeenCalledWith("/config/widgets.yaml", "utf8");
    expect(doc.toJS()).toEqual([{ resources: { cpu: true } }]);
  });

  it("throws when the file's content isn't valid YAML", () => {
    readFileSync.mockReturnValue("- resources:\n\tcpu: true\n"); // tab indentation is invalid YAML
    expect(() => readConfigDocument("widgets.yaml")).toThrow("not valid YAML");
  });
});

describe("writeConfigDocument", () => {
  beforeEach(() => vi.clearAllMocks());

  it("backs up the existing file, writes the new content, and returns the backup filename", () => {
    existsSync.mockReturnValue(true);
    const doc = { toString: () => "- resources:\n    cpu: true\n" };

    const backupFile = writeConfigDocument("widgets.yaml", doc);

    expect(copyFileSync).toHaveBeenCalledTimes(1);
    const [src, dest] = copyFileSync.mock.calls[0];
    expect(src).toBe("/config/widgets.yaml");
    expect(dest).toMatch(/^\/config\/widgets\.yaml\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);

    expect(writeFileSync).toHaveBeenCalledWith("/config/widgets.yaml", "- resources:\n    cpu: true\n", "utf8");
    expect(backupFile).toMatch(/^widgets\.yaml\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it("skips the backup when no file exists yet", () => {
    existsSync.mockReturnValue(false);
    const doc = { toString: () => "- resources:\n    cpu: true\n" };

    writeConfigDocument("widgets.yaml", doc);

    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("refuses to write when the mutated document fails to re-parse", () => {
    existsSync.mockReturnValue(false);
    const doc = { toString: () => "- resources:\n\tcpu: true\n" }; // tab indentation is invalid YAML

    expect(() => writeConfigDocument("widgets.yaml", doc)).toThrow("failed to re-parse");
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/config/configWriter.test.js`
Expected: FAIL — `./configWriter` has no exports yet (file doesn't exist).

- [ ] **Step 3: Write the implementation**

Create `src/utils/config/configWriter.js`:

```js
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { parseDocument } from "yaml";

import checkAndCopyConfig, { CONF_DIR } from "utils/config/config";
import createLogger from "utils/logger";

const logger = createLogger("configWriter");

// Reads and parses a config file as a mutable yaml Document. Ensures the
// file exists first (copies the skeleton if missing), same as every other
// config read path in this app.
export function readConfigDocument(filename) {
  checkAndCopyConfig(filename);
  const filePath = join(CONF_DIR, filename);
  const raw = readFileSync(filePath, "utf8");
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`${filename} is not valid YAML: ${doc.errors[0].message}`);
  }
  return doc;
}

// Creates a timestamped backup copy of filename inside CONF_DIR (if it
// already exists), then writes the mutated document, re-parsing the result
// to confirm it's still valid YAML before treating the write as successful.
// Returns the backup file's basename, or null if no backup was made.
export function writeConfigDocument(filename, doc) {
  const filePath = join(CONF_DIR, filename);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${filename}.bak.${timestamp}`;
  const backupPath = join(CONF_DIR, backupName);

  let backupFile = null;
  if (existsSync(filePath)) {
    copyFileSync(filePath, backupPath);
    backupFile = backupName;
  }

  const output = doc.toString();

  const revalidation = parseDocument(output);
  if (revalidation.errors.length > 0) {
    throw new Error(`Refusing to write ${filename}: mutated document failed to re-parse`);
  }

  writeFileSync(filePath, output, "utf8");
  logger.info("Wrote %s (backup: %s)", filename, backupFile ?? "none");

  return backupFile;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/config/configWriter.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/utils/config/configWriter.js" "src/utils/config/configWriter.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/utils/config/configWriter.js src/utils/config/configWriter.test.js
git commit -m "feat(widget-install): add configWriter read/backup/write layer"
```

---

### Task 3: `POST /api/widgets-catalog/install` route

**Files:**

- Create: `src/pages/api/widgets-catalog/install/index.js`
- Create: `src/__tests__/pages/api/widgets-catalog/install/index.test.js`

**Interfaces:**

- Consumes (from Task 1): `findGroupServicesSeq`, `findServiceFieldsNode`, `listServiceNames`, `parseInfoWidgetSnippet`, `parseWidgetFragment` from `utils/config/yamlDocument`.
- Consumes (from Task 2): `readConfigDocument`, `writeConfigDocument` from `utils/config/configWriter`.
- Produces (used by Task 5's frontend wizard, as an HTTP contract, not a JS import):

  - `POST /api/widgets-catalog/install` with body `{ category: "info", yamlSnippet }` or `{ category: "service", mode: "attach", serviceName, yamlSnippet }` or `{ category: "service", mode: "new", serviceName, groupName, href, description, yamlSnippet }`.
  - `200 { success: true, backupFile: string | null }`, `400 { error }`, `404 { error }`, `405 { error }`, `409 { error }`, `500 { error }`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/pages/api/widgets-catalog/install/index.test.js`:

```js
import { parseDocument } from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { readConfigDocument, writeConfigDocument } = vi.hoisted(() => ({
  readConfigDocument: vi.fn(),
  writeConfigDocument: vi.fn(),
}));
vi.mock("utils/config/configWriter", () => ({ readConfigDocument, writeConfigDocument }));

const { logger } = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/widgets-catalog/install/index";

const SERVICES_FIXTURE = `---
- Media:
    - Plex:
        href: http://plex.local/
        description: My Plex server
    - Sonarr:
        href: http://sonarr.local/
`;

const WIDGETS_FIXTURE = `---
- resources:
    cpu: true
`;

const WIDGET_FRAGMENT = "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere\n";
const INFO_SNIPPET = "- datetime:\n    text_size: xl\n";

describe("pages/api/widgets-catalog/install", () => {
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

  describe("category: info", () => {
    it("appends the parsed item to widgets.yaml and returns the backup filename", async () => {
      readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));
      writeConfigDocument.mockReturnValue("widgets.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = { method: "POST", body: { category: "info", yamlSnippet: INFO_SNIPPET } };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, backupFile: "widgets.yaml.bak.2026-08-23T00-00-00-000Z" });
      expect(readConfigDocument).toHaveBeenCalledWith("widgets.yaml");

      const [filename, doc] = writeConfigDocument.mock.calls[0];
      expect(filename).toBe("widgets.yaml");
      expect(doc.toString()).toContain("datetime");
      expect(doc.toString()).toContain("resources");
    });

    it("returns 400 when yamlSnippet is missing", async () => {
      const req = { method: "POST", body: { category: "info" } };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(readConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 400 when yamlSnippet is not a single list item", async () => {
      const req = { method: "POST", body: { category: "info", yamlSnippet: "not: a-list-item" } };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    });
  });

  describe("category: service, mode: attach", () => {
    it("attaches the widget to the named service and returns the backup filename", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
      writeConfigDocument.mockReturnValue("services.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = {
        method: "POST",
        body: { category: "service", mode: "attach", serviceName: "Plex", yamlSnippet: WIDGET_FRAGMENT },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, backupFile: "services.yaml.bak.2026-08-23T00-00-00-000Z" });

      const [, doc] = writeConfigDocument.mock.calls[0];
      expect(doc.toString()).toContain("type: plex");
      expect(doc.toString()).toContain("My Plex server");
    });

    it("returns 404 when the service doesn't exist", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

      const req = {
        method: "POST",
        body: { category: "service", mode: "attach", serviceName: "DoesNotExist", yamlSnippet: WIDGET_FRAGMENT },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 400 for a malformed widget YAML fragment", async () => {
      const req = {
        method: "POST",
        body: { category: "service", mode: "attach", serviceName: "Plex", yamlSnippet: "not-a-widget-key: 1" },
      };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(readConfigDocument).not.toHaveBeenCalled();
    });
  });

  describe("category: service, mode: new", () => {
    it("adds a new service into an existing group", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
      writeConfigDocument.mockReturnValue("services.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = {
        method: "POST",
        body: {
          category: "service",
          mode: "new",
          serviceName: "Radarr",
          groupName: "Media",
          href: "http://radarr.local/",
          description: "Movies",
          yamlSnippet: WIDGET_FRAGMENT,
        },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const [, doc] = writeConfigDocument.mock.calls[0];
      const out = doc.toString();
      expect(out).toContain("Radarr");
      expect(out).toContain("http://radarr.local/");
      expect(out).toContain("type: plex");
      expect(out).toContain("Plex");
    });

    it("creates a new group when groupName doesn't exist", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));
      writeConfigDocument.mockReturnValue("services.yaml.bak.2026-08-23T00-00-00-000Z");

      const req = {
        method: "POST",
        body: {
          category: "service",
          mode: "new",
          serviceName: "Transmission",
          groupName: "Downloads",
          href: "http://transmission.local/",
          description: "",
          yamlSnippet: WIDGET_FRAGMENT,
        },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const [, doc] = writeConfigDocument.mock.calls[0];
      const out = doc.toString();
      expect(out).toContain("Downloads");
      expect(out).toContain("Transmission");
    });

    it("returns 409 when the service name already exists anywhere", async () => {
      readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

      const req = {
        method: "POST",
        body: {
          category: "service",
          mode: "new",
          serviceName: "Sonarr",
          groupName: "Media",
          href: "http://sonarr2.local/",
          description: "",
          yamlSnippet: WIDGET_FRAGMENT,
        },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(409);
      expect(writeConfigDocument).not.toHaveBeenCalled();
    });

    it("returns 400 when required fields are missing", async () => {
      const req = {
        method: "POST",
        body: { category: "service", mode: "new", serviceName: "X", yamlSnippet: WIDGET_FRAGMENT },
      };
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    });
  });

  it("returns 500 and logs when the write throws", async () => {
    readConfigDocument.mockReturnValue(parseDocument(WIDGETS_FIXTURE));
    writeConfigDocument.mockImplementation(() => {
      throw new Error("disk full");
    });

    const req = { method: "POST", body: { category: "info", yamlSnippet: INFO_SNIPPET } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/install/index.test.js`
Expected: FAIL — `pages/api/widgets-catalog/install/index` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/pages/api/widgets-catalog/install/index.js`:

```js
import { readConfigDocument, writeConfigDocument } from "utils/config/configWriter";
import {
  findGroupServicesSeq,
  findServiceFieldsNode,
  listServiceNames,
  parseInfoWidgetSnippet,
  parseWidgetFragment,
} from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetInstall");

async function handleInfoInstall(req, res) {
  const { yamlSnippet } = req.body ?? {};

  let itemNode;
  try {
    itemNode = parseInfoWidgetSnippet(yamlSnippet);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const doc = readConfigDocument("widgets.yaml");
  doc.contents.items.push(itemNode);
  const backupFile = writeConfigDocument("widgets.yaml", doc);

  return res.status(200).json({ success: true, backupFile });
}

function attachToExistingService(doc, serviceName, widgetNode, res) {
  const fieldsNode = findServiceFieldsNode(doc, serviceName);
  if (!fieldsNode) {
    return res.status(404).json({ error: `Service '${serviceName}' not found` });
  }
  fieldsNode.set("widget", widgetNode);
  const backupFile = writeConfigDocument("services.yaml", doc);
  return res.status(200).json({ success: true, backupFile });
}

function addNewService(doc, req, widgetNode, res) {
  const { serviceName, groupName, href, description } = req.body;
  if (![serviceName, groupName, href].every((v) => typeof v === "string" && v.trim())) {
    return res.status(400).json({ error: "serviceName, groupName, and href are required" });
  }

  if (listServiceNames(doc).includes(serviceName)) {
    return res.status(409).json({ error: `Service '${serviceName}' already exists` });
  }

  const fields = { href };
  if (description && description.trim()) fields.description = description;
  const newServiceNode = doc.createNode({ [serviceName]: fields });
  newServiceNode.items[0].value.set("widget", widgetNode);

  let servicesSeq = findGroupServicesSeq(doc, groupName);
  if (!servicesSeq) {
    const newGroupNode = doc.createNode({ [groupName]: [] });
    doc.contents.items.push(newGroupNode);
    servicesSeq = newGroupNode.items[0].value;
  }
  servicesSeq.items.push(newServiceNode);

  const backupFile = writeConfigDocument("services.yaml", doc);
  return res.status(200).json({ success: true, backupFile });
}

async function handleServiceInstall(req, res) {
  const { mode } = req.body ?? {};

  let widgetNode;
  try {
    widgetNode = parseWidgetFragment(req.body?.yamlSnippet);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const doc = readConfigDocument("services.yaml");

  if (mode === "attach") {
    const { serviceName } = req.body;
    if (typeof serviceName !== "string" || !serviceName.trim()) {
      return res.status(400).json({ error: "serviceName is required" });
    }
    return attachToExistingService(doc, serviceName, widgetNode, res);
  }

  if (mode === "new") {
    return addNewService(doc, req, widgetNode, res);
  }

  return res.status(400).json({ error: "mode must be 'attach' or 'new'" });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { category } = req.body ?? {};

  try {
    if (category === "info") {
      return await handleInfoInstall(req, res);
    }
    if (category === "service") {
      return await handleServiceInstall(req, res);
    }
    return res.status(400).json({ error: "category must be 'info' or 'service'" });
  } catch (e) {
    logger.error("Widget install failed:", e);
    return res.status(500).json({ error: "Failed to write configuration" });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/install/index.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/api/widgets-catalog/install/index.js" "src/__tests__/pages/api/widgets-catalog/install/index.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/widgets-catalog/install/index.js src/__tests__/pages/api/widgets-catalog/install/index.test.js
git commit -m "feat(widget-install): add POST /api/widgets-catalog/install route"
```

---

### Task 4: `GET /api/widgets-catalog/services` route

**Files:**

- Create: `src/pages/api/widgets-catalog/services/index.js`
- Create: `src/__tests__/pages/api/widgets-catalog/services/index.test.js`

**Interfaces:**

- Consumes (from Task 1): `listGroupNames`, `listServiceNames` from `utils/config/yamlDocument`.
- Consumes (from Task 2): `readConfigDocument` from `utils/config/configWriter`.
- Produces (used by Task 5's frontend wizard, as an HTTP contract): `GET /api/widgets-catalog/services` → `200 { groups: string[], services: string[] }` or `500 { error }`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/pages/api/widgets-catalog/services/index.test.js`:

```js
import { parseDocument } from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { readConfigDocument } = vi.hoisted(() => ({ readConfigDocument: vi.fn() }));
vi.mock("utils/config/configWriter", () => ({ readConfigDocument }));

const { logger } = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock("utils/logger", () => ({ default: () => logger }));

import handler from "pages/api/widgets-catalog/services/index";

const SERVICES_FIXTURE = `---
- Media:
    - Plex:
        href: http://plex.local/
    - Sonarr:
        href: http://sonarr.local/
- Downloads:
    - Transmission:
        href: http://transmission.local/
`;

describe("pages/api/widgets-catalog/services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 405 for non-GET methods", async () => {
    const req = { method: "POST" };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns the groups and service names from services.yaml", async () => {
    readConfigDocument.mockReturnValue(parseDocument(SERVICES_FIXTURE));

    const req = { method: "GET" };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      groups: ["Media", "Downloads"],
      services: ["Plex", "Sonarr", "Transmission"],
    });
    expect(readConfigDocument).toHaveBeenCalledWith("services.yaml");
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

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/services/index.test.js`
Expected: FAIL — `pages/api/widgets-catalog/services/index` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/pages/api/widgets-catalog/services/index.js`:

```js
import { readConfigDocument } from "utils/config/configWriter";
import { listGroupNames, listServiceNames } from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetsCatalogServices");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const doc = readConfigDocument("services.yaml");
    return res.status(200).json({
      groups: listGroupNames(doc),
      services: listServiceNames(doc),
    });
  } catch (e) {
    logger.error("Failed to read services.yaml:", e);
    return res.status(500).json({ error: "Failed to read services configuration" });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/services/index.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/api/widgets-catalog/services/index.js" "src/__tests__/pages/api/widgets-catalog/services/index.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/widgets-catalog/services/index.js src/__tests__/pages/api/widgets-catalog/services/index.test.js
git commit -m "feat(widget-install): add GET /api/widgets-catalog/services route"
```

---

### Task 5: `InstallWizardDialog` component

**Files:**

- Create: `src/components/widgets/InstallWizardDialog.jsx`
- Create: `src/components/widgets/InstallWizardDialog.test.jsx`

**Interfaces:**

- Consumes (as an HTTP contract, from Tasks 3 and 4): `POST /api/widgets-catalog/install`, `GET /api/widgets-catalog/services`.
- Produces (used by Task 6):

  - `InstallWizardDialog({ entry: { slug, title, description, yamlExample, category: "service" | "info" }, open: boolean, onClose: () => void })` — a default-exported React component. Renders nothing when `entry` is falsy. Steps: `target` (service widgets only; skipped for `category: "info"`) → `preview` → `confirm` → `result`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/widgets/InstallWizardDialog.test.jsx`:

```jsx
// @vitest-environment jsdom

// Stub Dialog/DialogBackdrop/DialogPanel/DialogTitle to always render
// children when open (keeps tests deterministic), matching the existing
// pattern in dropdown.test.jsx / NavHeader.test.jsx for @headlessui/react.
vi.mock("@headlessui/react", async () => {
  const React = await import("react");

  function Dialog({ open, children, ...props }) {
    if (!open) return null;
    return <div {...props}>{children}</div>;
  }
  function DialogBackdrop(props) {
    return <div {...props} />;
  }
  function DialogPanel(props) {
    return <div {...props} />;
  }
  function DialogTitle(props) {
    return React.createElement("h2", props);
  }

  return { Dialog, DialogBackdrop, DialogPanel, DialogTitle };
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InstallWizardDialog from "./InstallWizardDialog";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

const SERVICE_ENTRY = {
  slug: "plex",
  title: "Plex",
  description: "Plex Widget Configuration",
  category: "service",
  yamlExample: "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere",
};

const INFO_ENTRY = {
  slug: "datetime",
  title: "Date & Time",
  description: "Date & Time Widget Configuration",
  category: "info",
  yamlExample: "- datetime:\n    text_size: xl",
};

function mockFetchSequence(handlers) {
  global.fetch = vi.fn((url, options) => {
    const match = handlers.find((h) => h.match(url, options));
    if (!match) throw new Error(`Unexpected fetch call: ${url}`);
    return Promise.resolve({ ok: match.ok !== false, json: () => Promise.resolve(match.body) });
  });
}

describe("components/widgets/InstallWizardDialog", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ groups: [], services: [] }) });
  });

  it("info widget: skips the target step and shows the YAML preview directly", async () => {
    renderWithSWR(<InstallWizardDialog entry={INFO_ENTRY} open onClose={vi.fn()} />);

    expect(await screen.findByLabelText("YAML preview")).toHaveValue(INFO_ENTRY.yamlExample);
    expect(screen.queryByText("Attach to an existing service")).not.toBeInTheDocument();
  });

  it("service widget: attach flow requires selecting a service before continuing", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: ["Media"], services: ["Sonarr"] } },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: "Sonarr" } });
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByLabelText("YAML preview")).toHaveValue(SERVICE_ENTRY.yamlExample);
  });

  it("service widget: new-service flow requires name, group, and href before continuing", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: ["Media"], services: ["Sonarr"] } },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Add as a new service")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Add as a new service"));

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Service name"), { target: { value: "Radarr" } });
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: "Media" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "http://radarr.local/" } });

    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });

  it("keeps Install disabled until the risk checkbox is checked, then submits and shows the backup filename", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: [], services: ["Sonarr"] } },
      {
        match: (url, options) => url === "/api/widgets-catalog/install" && options?.method === "POST",
        body: { success: true, backupFile: "services.yaml.bak.2026-08-23T00-00-00-000Z" },
      },
    ]);

    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: "Sonarr" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByLabelText("YAML preview");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("button", { name: "Install" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I understand the risk/));
    expect(screen.getByRole("button", { name: "Install" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(screen.getByText(/Installed\. Backup saved as services\.yaml\.bak/)).toBeInTheDocument(),
    );
  });

  it("shows the server's error message inline on a failed install, without closing the dialog", async () => {
    mockFetchSequence([
      { match: (url) => url === "/api/widgets-catalog/services", body: { groups: [], services: ["Sonarr"] } },
      {
        match: (url, options) => url === "/api/widgets-catalog/install" && options?.method === "POST",
        ok: false,
        body: { error: "Service 'Sonarr' not found" },
      },
    ]);

    const onClose = vi.fn();
    renderWithSWR(<InstallWizardDialog entry={SERVICE_ENTRY} open onClose={onClose} />);

    await waitFor(() => expect(screen.getByLabelText("Existing service")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Existing service"), { target: { value: "Sonarr" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText("YAML preview");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByLabelText(/I understand the risk/));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(screen.getByText("Service 'Sonarr' not found")).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/components/widgets/InstallWizardDialog.test.jsx`
Expected: FAIL — `./InstallWizardDialog` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/components/widgets/InstallWizardDialog.jsx`:

```jsx
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";
import useSWR from "swr";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function initialState(entry) {
  return {
    step: entry?.category === "service" ? "target" : "preview",
    targetMode: "attach",
    attachServiceName: "",
    newServiceName: "",
    newGroupName: "",
    newGroupCustom: "",
    newHref: "",
    newDescription: "",
    yamlText: entry?.yamlExample ?? "",
    acknowledged: false,
    submitting: false,
    result: null,
  };
}

export default function InstallWizardDialog({ entry, open, onClose }) {
  const [state, setState] = useState(() => initialState(entry));

  useEffect(() => {
    if (open) setState(initialState(entry));
  }, [open, entry]);

  const { data: servicesData } = useSWR(
    open && entry?.category === "service" ? "/api/widgets-catalog/services" : null,
    fetcher,
  );

  const update = (patch) => setState((prev) => ({ ...prev, ...patch }));
  const handleClose = () => {
    if (!state.submitting) onClose();
  };

  const groupName = state.newGroupName === "__new__" ? state.newGroupCustom : state.newGroupName;

  const buildBody = () => {
    if (entry.category === "info") {
      return { category: "info", yamlSnippet: state.yamlText };
    }
    if (state.targetMode === "attach") {
      return {
        category: "service",
        mode: "attach",
        serviceName: state.attachServiceName,
        yamlSnippet: state.yamlText,
      };
    }
    return {
      category: "service",
      mode: "new",
      serviceName: state.newServiceName,
      groupName,
      href: state.newHref,
      description: state.newDescription,
      yamlSnippet: state.yamlText,
    };
  };

  const handleInstall = async () => {
    update({ submitting: true });
    try {
      const res = await fetch("/api/widgets-catalog/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const body = await res.json();
      if (!res.ok) {
        update({ submitting: false, result: { error: body.error ?? "Install failed" } });
        return;
      }
      update({ submitting: false, step: "result", result: { success: true, backupFile: body.backupFile } });
    } catch {
      update({ submitting: false, result: { error: "Network error - install failed" } });
    }
  };

  if (!entry) return null;

  const targetNextDisabled =
    state.targetMode === "attach" ? !state.attachServiceName : !state.newServiceName || !groupName || !state.newHref;

  return (
    <Dialog open={open} onClose={handleClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-md bg-theme-100 dark:bg-theme-800 p-6 text-theme-700 dark:text-theme-200">
          <DialogTitle className="text-lg font-medium mb-4">Install {entry.title}</DialogTitle>

          {state.step === "target" && (
            <div>
              <label className="flex items-center gap-2 mb-2">
                <input
                  type="radio"
                  name="targetMode"
                  checked={state.targetMode === "attach"}
                  onChange={() => update({ targetMode: "attach" })}
                />
                Attach to an existing service
              </label>
              <label className="flex items-center gap-2 mb-2">
                <input
                  type="radio"
                  name="targetMode"
                  checked={state.targetMode === "new"}
                  onChange={() => update({ targetMode: "new" })}
                />
                Add as a new service
              </label>

              {state.targetMode === "attach" && (
                <select
                  aria-label="Existing service"
                  value={state.attachServiceName}
                  onChange={(e) => update({ attachServiceName: e.target.value })}
                  className="w-full mt-2 px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                >
                  <option value="">Select a service...</option>
                  {(servicesData?.services ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}

              {state.targetMode === "new" && (
                <div className="flex flex-col gap-2 mt-2">
                  <input
                    aria-label="Service name"
                    placeholder="Service name"
                    value={state.newServiceName}
                    onChange={(e) => update({ newServiceName: e.target.value })}
                    className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                  />
                  <select
                    aria-label="Group"
                    value={state.newGroupName}
                    onChange={(e) => update({ newGroupName: e.target.value })}
                    className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                  >
                    <option value="">Select a group...</option>
                    {(servicesData?.groups ?? []).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                    <option value="__new__">+ New group</option>
                  </select>
                  {state.newGroupName === "__new__" && (
                    <input
                      aria-label="New group name"
                      placeholder="New group name"
                      value={state.newGroupCustom}
                      onChange={(e) => update({ newGroupCustom: e.target.value })}
                      className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                    />
                  )}
                  <input
                    aria-label="URL"
                    placeholder="http://..."
                    value={state.newHref}
                    onChange={(e) => update({ newHref: e.target.value })}
                    className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                  />
                  <input
                    aria-label="Description"
                    placeholder="Description (optional)"
                    value={state.newDescription}
                    onChange={(e) => update({ newDescription: e.target.value })}
                    className="px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 mt-4">
                <button type="button" onClick={handleClose} className="text-sm px-3 py-1.5">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => update({ step: "preview" })}
                  disabled={targetNextDisabled}
                  className="text-sm px-3 py-1.5 rounded-md bg-theme-300/70 dark:bg-theme-900/70 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {state.step === "preview" && (
            <div>
              <p className="text-sm mb-2">Review and edit the YAML before installing:</p>
              <textarea
                aria-label="YAML preview"
                value={state.yamlText}
                onChange={(e) => update({ yamlText: e.target.value })}
                rows={8}
                className="w-full font-mono text-xs p-3 rounded-md bg-theme-200/50 dark:bg-theme-900/20"
              />
              <div className="flex justify-end gap-2 mt-4">
                {entry.category === "service" && (
                  <button
                    type="button"
                    onClick={() => update({ step: "target" })}
                    className="text-sm px-3 py-1.5 mr-auto"
                  >
                    Back
                  </button>
                )}
                <button type="button" onClick={handleClose} className="text-sm px-3 py-1.5">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => update({ step: "confirm" })}
                  disabled={!state.yamlText.trim()}
                  className="text-sm px-3 py-1.5 rounded-md bg-theme-300/70 dark:bg-theme-900/70 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {state.step === "confirm" && (
            <div>
              <p className="text-sm mb-3">
                This will write directly to your <code>services.yaml</code>/<code>widgets.yaml</code> config file on the
                server. A backup copy is created automatically before any change, but Homepage&apos;s behavior after
                this change is your responsibility.
              </p>
              <label className="flex items-center gap-2 text-sm mb-4">
                <input
                  type="checkbox"
                  checked={state.acknowledged}
                  onChange={(e) => update({ acknowledged: e.target.checked })}
                />
                I understand the risk and want to proceed.
              </label>
              {state.result?.error && <p className="text-rose-500/80 text-sm mb-3">{state.result.error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => update({ step: "preview" })}
                  className="text-sm px-3 py-1.5 mr-auto"
                >
                  Back
                </button>
                <button type="button" onClick={handleClose} className="text-sm px-3 py-1.5">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleInstall}
                  disabled={!state.acknowledged || state.submitting}
                  className="text-sm px-3 py-1.5 rounded-md bg-theme-300/70 dark:bg-theme-900/70 disabled:opacity-50"
                >
                  {state.submitting ? "Installing..." : "Install"}
                </button>
              </div>
            </div>
          )}

          {state.step === "result" && state.result?.success && (
            <div>
              <p className="text-sm mb-4">Installed. Backup saved as {state.result.backupFile}.</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleClose}
                  className="text-sm px-3 py-1.5 rounded-md bg-theme-300/70 dark:bg-theme-900/70"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/components/widgets/InstallWizardDialog.test.jsx`
Expected: PASS, all tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/components/widgets/InstallWizardDialog.jsx" "src/components/widgets/InstallWizardDialog.test.jsx" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/components/widgets/InstallWizardDialog.jsx src/components/widgets/InstallWizardDialog.test.jsx
git commit -m "feat(widget-install): add InstallWizardDialog component"
```

---

### Task 6: Wire "Install..." into `/widgets`

**Files:**

- Modify: `src/pages/widgets.jsx`
- Modify: `src/__tests__/pages/widgets.test.jsx`

**Interfaces:**

- Consumes (from Task 5): `InstallWizardDialog` default export from `components/widgets/InstallWizardDialog`.

- [ ] **Step 1: Write the failing tests**

Open `src/__tests__/pages/widgets.test.jsx` and add a mock for `InstallWizardDialog` right after the existing `prism-react-renderer` mock (before the `import { fireEvent, ... }` line):

```jsx
vi.mock("components/widgets/InstallWizardDialog", () => ({
  default: ({ entry, open, onClose }) =>
    open ? (
      <div>
        <p>
          Install dialog: {entry.title} ({entry.category})
        </p>
        <button type="button" onClick={onClose}>
          Close dialog
        </button>
      </div>
    ) : null,
}));
```

Then add these two `it` blocks inside the existing `describe("pages/widgets", ...)` block, after the `"expands a widget row..."` test:

```jsx
it('shows an "Install..." button next to Copy and opens the install dialog with the entry', async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

  renderWithSWR(<WidgetsPage />);
  await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

  screen.getByText("Plex").click();
  await waitFor(() => expect(screen.getByText("Install...")).toBeInTheDocument());

  screen.getByText("Install...").click();
  await waitFor(() => expect(screen.getByText("Install dialog: Plex (service)")).toBeInTheDocument());
});

it("does not show an Install button for a widget with no YAML example", async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

  renderWithSWR(<WidgetsPage />);
  await waitFor(() => expect(screen.getByText("Date & Time")).toBeInTheDocument());

  screen.getByText("Date & Time").click();
  await waitFor(() => expect(screen.getByText("No example available.")).toBeInTheDocument());
  expect(screen.queryByText("Install...")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/widgets.test.jsx`
Expected: FAIL — no "Install..." button exists yet, so the two new tests fail (the pre-existing tests still pass).

- [ ] **Step 3: Update the implementation**

In `src/pages/widgets.jsx`, add the import at the top (after the `useSWR` import):

```js
import InstallWizardDialog from "components/widgets/InstallWizardDialog";
```

Change `WidgetRow` to accept a `category` prop, add install-dialog state, and add the "Install..." button next to "Copy":

```jsx
function WidgetRow({ entry, category }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const preRef = useRef(null);
  const themeContext = useContext(ThemeContext);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(entry.yamlExample);
      } else if (preRef.current) {
        const range = document.createRange();
        range.selectNodeContents(preRef.current);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <li className="border-b border-theme-300/30 dark:border-theme-500/10 py-2">
      <button type="button" onClick={() => setExpanded((prev) => !prev)} className="w-full text-left">
        <span className="text-sm font-medium">{entry.title}</span>
        <p className="text-theme-500 dark:text-theme-300 text-xs font-light">{entry.description}</p>
      </button>
      {expanded && (
        <div className="mt-2 text-xs">
          {entry.yamlExample ? (
            <>
              <Highlight
                theme={themeContext?.theme === "light" ? themes.github : themes.nightOwl}
                code={entry.yamlExample}
                language="yaml"
              >
                {({ style, tokens, getLineProps, getTokenProps }) => (
                  <pre ref={preRef} style={style} className="rounded-md p-3 overflow-x-auto text-xs">
                    {tokens.map((line, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <div key={i} {...getLineProps({ line })}>
                        {line.map((token, key) => (
                          // eslint-disable-next-line react/no-array-index-key
                          <span key={key} {...getTokenProps({ token })} />
                        ))}
                      </div>
                    ))}
                  </pre>
                )}
              </Highlight>
              <div className="flex gap-3 mt-2">
                <button type="button" onClick={handleCopy} className="text-xs text-theme-500 dark:text-theme-300">
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => setInstallOpen(true)}
                  className="text-xs text-theme-500 dark:text-theme-300"
                >
                  Install...
                </button>
              </div>
              <InstallWizardDialog
                entry={{ ...entry, category }}
                open={installOpen}
                onClose={() => setInstallOpen(false)}
              />
            </>
          ) : (
            <p className="text-theme-500 dark:text-theme-300">No example available.</p>
          )}
        </div>
      )}
    </li>
  );
}
```

Update the two `WidgetRow` usages in `WidgetsPage` to pass `category`:

```jsx
          <h2 className="text-sm font-medium mt-2">Service Widgets</h2>
          <ul>
            {data.services
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow key={entry.slug} entry={entry} category="service" />
              ))}
          </ul>

          <h2 className="text-sm font-medium mt-4">Info Widgets</h2>
          <ul>
            {data.info
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow key={entry.slug} entry={entry} category="info" />
              ))}
          </ul>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/widgets.test.jsx`
Expected: PASS, all tests green (both pre-existing and the two new ones).

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/widgets.jsx" "src/__tests__/pages/widgets.test.jsx" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/widgets.jsx src/__tests__/pages/widgets.test.jsx
git commit -m "feat(widget-install): wire Install button into /widgets"
```
