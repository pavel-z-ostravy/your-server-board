# Widget One-Click Install — Design

**Date:** 2026-08-23
**Status:** Approved for planning

## Problem

The `/widgets` catalog (shipped 2026-08-22) lets a user browse every Homepage widget and copy its YAML example to the clipboard, but the user still has to SSH/file-browse into `config/services.yaml` or `config/widgets.yaml`, hand-paste the block, fix indentation, and restart/wait for reload themselves. Pavel asked whether installation could become a single button click, optionally wizard-guided.

This is phase 1 of a two-phase plan the user explicitly framed as "let's experiment now, harden later": ship real config-writing capability behind clear disclaimers and an explicit user risk-acknowledgement, with authentication/authorization hardening deferred to a later phase. **This phase does not add any new access control** — anyone who can already reach this app (today: anyone on the LAN, or logged in via the existing `NextAuth` guard if configured) can already read `/widgets`, and will now also be able to write to `services.yaml`/`widgets.yaml` through it.

## Goals

- A button/flow that writes a chosen widget's config directly into the user's real `services.yaml` (service widgets) or `widgets.yaml` (info widgets), preserving all of the file's existing comments, formatting, and unrelated entries.
- Support both installation modes for service widgets: **attach** the widget to an existing service already in `services.yaml`, or **add as a new service** (with the widget attached) into an existing or new group.
- Info widgets: append-only — there's no "attach to existing" concept for `widgets.yaml`, since its entries aren't independently named/targetable in the same way (`resources`, `search`, etc. are typically singletons some users do repeat, so append is the only sane default).
- Before any write: the user sees a short "what this does" explainer, a disclaimer that this directly edits their live config file, and must check an explicit "I understand the risk and want to proceed" acknowledgement — the Install button stays disabled until checked.
- Automatic timestamped backup of the target file created immediately before every write, so any bad edit is trivially recoverable by hand.
- Editable YAML preview before install: the user can tweak placeholder values (URLs, tokens, etc.) in a textarea pre-filled with the widget's example, matching this project's established restraint (see Non-goals) against building per-field forms or placeholder auto-detection.

## Non-goals

- **No automatic placeholder detection/pre-fill.** Same reasoning as the original widgets-catalog design: no consistent placeholder convention exists across ~170 independently authored doc files. The user edits the pre-filled YAML textarea by hand.
- **No authentication/authorization changes in this phase.** Explicitly deferred — the user asked for the write capability first, security hardening second, as a separate follow-up piece of work.
- **No uninstall/delete or edit-after-install UI.** Only forward installation. Removing or editing a previously installed widget is done by hand (or by installing over it — see Collision handling) — not a feature of this phase.
- **No semantic validation of user-entered values.** The install route validates that the resulting YAML re-parses correctly (syntax), not that a URL is reachable or a token is well-formed. Bad values are the user's own responsibility, consistent with the "at your own risk" framing.
- **No multi-file atomic transactions.** Each install writes exactly one file (`services.yaml` or `widgets.yaml`). There's no cross-file rollback need since only one file is ever touched per install call.
- **No new "existing services" browsing UI beyond what's needed for the attach dropdown.** The attach-mode service picker is a flat name list sourced from the current `services.yaml`, not a rich management view.

## Architecture

### New dependency: `yaml` (eemeli/yaml)

`js-yaml` (existing dependency, used everywhere else in this codebase for reading config) does not preserve comments or formatting on write — this is why the original widgets-catalog spec ruled out config-writing entirely. The `yaml` package's `parseDocument()` Document API was live-verified in this session against this project's actual `services.yaml`/`widgets.yaml` skeleton shapes and DOES preserve comments/formatting for all untouched parts of the document while allowing targeted mutation of specific nodes. Add `yaml@^2.9.0` as a new dependency. `js-yaml` is untouched and keeps handling every existing read path — this is additive, not a replacement.

### `src/utils/config/yamlDocument.js` (new, pure helpers)

Given a parsed `yaml` `Document`, these helpers navigate the project's two real config shapes:

- **`services.yaml` shape:** top-level `Seq` of single-key group `Map`s → each group's value is a `Seq` of single-key service `Map`s → each service's value is a `Map` of fields (`href`, `description`, `widget`, ...).
- **`widgets.yaml` shape:** flat top-level `Seq` of single-key `Map`s (e.g. `{ resources: {...} }`).

Functions (verified against real fixture text in this session):

```js
// Returns the fields-Map node for a named service, searching all groups.
// Returns null if not found.
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

// Returns the services-Seq node for a named group. Returns null if not found.
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

// Returns every top-level service name across all groups, in document order.
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

// Returns every top-level group name, in document order.
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

// Parses a widget doc's `widget:`-prefixed YAML fragment (e.g.
// "widget:\n  type: plex\n  url: ...") and returns the value node of the
// `widget` key — ready to `.set("widget", node)` onto a service fields Map.
export function parseWidgetFragment(YAML, yamlSnippet) {
  const doc = YAML.parseDocument(yamlSnippet);
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
// representing that list item — ready to push onto widgets.yaml's top Seq.
export function parseInfoWidgetSnippet(YAML, yamlSnippet) {
  const doc = YAML.parseDocument(yamlSnippet);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid widget YAML: ${doc.errors[0].message}`);
  }
  if (!YAML.isSeq(doc.contents) || doc.contents.items.length !== 1) {
    throw new Error("Info widget YAML must be exactly one top-level list item");
  }
  return doc.contents.items[0];
}
```

`YAML` (the `yaml` package's default export/namespace) is passed in rather than imported inside this module so tests can call these functions against `parseDocument()`-produced fixtures without any file I/O — this module has zero `fs` dependency, matching the "pure helpers" boundary from the file-structure convention this project already follows (see `utils/proxmox/processDetail.js` for the parse-vs-fetch split precedent).

### `src/utils/config/configWriter.js` (new, I/O layer)

Wraps `checkAndCopyConfig` + `CONF_DIR` (both already exported from `src/utils/config/config.js`) with parse/backup/write/validate:

```js
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { parseDocument } from "yaml";

import checkAndCopyConfig, { CONF_DIR } from "utils/config/config";
import createLogger from "utils/logger";

const logger = createLogger("configWriter");

// Reads and parses a config file as a mutable yaml Document.
// Ensures the file exists first (copies skeleton if missing), same as
// every other config read path in this app.
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

// Creates a timestamped backup copy of filename inside CONF_DIR, then
// writes the mutated document, re-parsing the result to confirm it's
// still valid YAML before treating the write as successful. Returns the
// backup file's basename.
export function writeConfigDocument(filename, doc) {
  const filePath = join(CONF_DIR, filename);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${filename}.bak.${timestamp}`;
  const backupPath = join(CONF_DIR, backupName);

  if (existsSync(filePath)) {
    copyFileSync(filePath, backupPath);
  }

  const output = doc.toString();

  const revalidation = parseDocument(output);
  if (revalidation.errors.length > 0) {
    throw new Error(`Refusing to write ${filename}: mutated document failed to re-parse`);
  }

  writeFileSync(filePath, output, "utf8");
  logger.info("Wrote %s (backup: %s)", filename, backupName);

  return backupName;
}
```

### API route: `POST /api/widgets-catalog/install`

New file `src/pages/api/widgets-catalog/install/index.js`, mirroring the existing `vm-detail` route's discriminator-param + validation-first pattern.

**Request body**, discriminated by `category`:

```
// category: "info"
{ category: "info", yamlSnippet: string }

// category: "service", mode: "attach"
{ category: "service", mode: "attach", serviceName: string, yamlSnippet: string }

// category: "service", mode: "new"
{
  category: "service",
  mode: "new",
  serviceName: string,
  groupName: string,       // existing group name, or a new one
  href: string,
  description: string,
  yamlSnippet: string,     // the "widget:\n  ..." fragment
}
```

`yamlSnippet` in every case is exactly the (possibly user-edited) text the frontend showed in its preview textarea — the server re-parses and validates it independently; it never trusts the client's own parse.

**Responses:**

- `200 { success: true, backupFile: string }`
- `400 { error: string }` — missing/invalid fields, or `yamlSnippet` fails to parse (message includes the underlying YAML parse error for info["info" category] and widget-fragment cases)
- `404 { error: "Service '<name>' not found" }` — `attach` mode, `serviceName` doesn't exist in `services.yaml`
- `409 { error: "Service '<name>' already exists" }` — `new` mode, collision with an existing service name anywhere in `services.yaml` (see the global-collision-check rationale below)
- `500 { error: string }` — filesystem/backup/write failure, logged server-side with full detail

**Handler logic:**

```js
import {
  findGroupServicesSeq,
  findServiceFieldsNode,
  listServiceNames,
  parseInfoWidgetSnippet,
  parseWidgetFragment,
} from "utils/config/yamlDocument";
import { readConfigDocument, writeConfigDocument } from "utils/config/configWriter";
import createLogger from "utils/logger";
import * as YAML from "yaml";

const logger = createLogger("widgetInstall");

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

async function handleInfoInstall(req, res) {
  const { yamlSnippet } = req.body;
  if (typeof yamlSnippet !== "string" || !yamlSnippet.trim()) {
    return res.status(400).json({ error: "yamlSnippet is required" });
  }

  let itemNode;
  try {
    itemNode = parseInfoWidgetSnippet(YAML, yamlSnippet);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const doc = readConfigDocument("widgets.yaml");
  doc.contents.items.push(itemNode);
  const backupFile = writeConfigDocument("widgets.yaml", doc);

  return res.status(200).json({ success: true, backupFile });
}

async function handleServiceInstall(req, res) {
  const { mode, yamlSnippet } = req.body;

  let widgetNode;
  try {
    widgetNode = parseWidgetFragment(YAML, yamlSnippet);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const doc = readConfigDocument("services.yaml");

  if (mode === "attach") {
    const { serviceName } = req.body;
    if (typeof serviceName !== "string" || !serviceName.trim()) {
      return res.status(400).json({ error: "serviceName is required" });
    }
    const fieldsNode = findServiceFieldsNode(doc, serviceName);
    if (!fieldsNode) {
      return res.status(404).json({ error: `Service '${serviceName}' not found` });
    }
    fieldsNode.set("widget", widgetNode);
    const backupFile = writeConfigDocument("services.yaml", doc);
    return res.status(200).json({ success: true, backupFile });
  }

  if (mode === "new") {
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

  return res.status(400).json({ error: "mode must be 'attach' or 'new'" });
}
```

Collision check for `new` mode intentionally checks the service name **globally** (across all groups), not just within the target group — Homepage itself doesn't support two services with the same name across groups cleanly for `widget:`-based integrations expecting unique keys, and a global check gives a clearer, simpler error than a same-name-different-group edge case the user would need to reason about.

### Frontend: wizard on `/widgets`

`src/pages/widgets.jsx`'s `WidgetRow` gains an "Install..." button next to the existing "Copy" button in the expanded panel, opening a new `src/components/widgets/InstallWizardDialog.jsx` (Headless UI `Dialog`, matching this codebase's existing `@headlessui/react` usage in `src/components/services/dropdown.jsx` and `NavHeader.jsx`).

**Wizard steps:**

1. **Target** (service widgets only — skipped entirely for info widgets, which go straight to step 2):
   - Radio choice: "Attach to an existing service" / "Add as a new service"
   - Attach: a `<select>` populated from a services list (new lightweight `GET /api/widgets-catalog/services` route — see below)
   - New: text inputs for service name, group (a `<select>` of existing group names plus a "+ New group" option that reveals a text input), href, description (optional)

2. **YAML preview** — a `<textarea>` pre-filled with `entry.yamlExample` (service widgets) or the widget's example block (info widgets), monospace, user-editable. No placeholder detection or pre-fill — matches this project's established Non-goal from the original widgets-catalog design.

3. **Disclaimer + confirmation** — static text: "This will write directly to your `services.yaml`/`widgets.yaml` config file on the server. A backup copy is created automatically before any change, but Homepage's behavior after this change is your responsibility." A required checkbox: "I understand the risk and want to proceed." The Install button stays `disabled` until checked.

4. **Result** — on success: "Installed. Backup saved as `<backupFile>`." On failure: the server's `error` message shown inline, wizard stays open so the user can fix the YAML and retry.

New minimal route `GET /api/widgets-catalog/services` → `200 { groups: string[], services: string[] }`, reading `services.yaml` via `readConfigDocument` + `listGroupNames`/`listServiceNames` (read-only, no write) — powers the attach-mode dropdown and the new-mode group `<select>`.

### Error handling

- Every write is preceded by a backup; every write is validated by re-parse before being treated as successful (see `writeConfigDocument`).
- The server never trusts client-side YAML validity — `yamlSnippet` is always re-parsed server-side.
- A 404/409/400 from the install route is shown inline in the wizard, not as a toast/global error — the user is mid-flow and needs the message next to the form they're editing.
- If `services.yaml`/`widgets.yaml` doesn't exist yet, `readConfigDocument` transparently creates it from the skeleton first (same behavior every other config read path already has via `checkAndCopyConfig`).

## Testing

- `yamlDocument.js`: unit tests for every exported function against real fixture text shaped like the actual `services.yaml`/`widgets.yaml` skeleton and richer multi-group/multi-service variants — found-node, not-found (null), the info-snippet parse success/failure cases, and the widget-fragment parse success/failure cases (missing `widget:` key, invalid YAML).
- `configWriter.js`: unit tests with a mocked `fs` module — verifies backup file naming/creation, write-then-revalidate behavior, and that a mutated-document-fails-to-reparse case throws before any `writeFileSync` call.
- `POST /api/widgets-catalog/install`: route tests covering all three success paths (info append, service attach, service new-into-existing-group, service new-into-new-group) and all error paths (400 invalid YAML, 400 missing fields, 404 service not found, 409 name collision, 500 on a simulated write failure) — mocking `configWriter`/`yamlDocument` the same way the existing `vm-detail` route tests mock their SSH/Proxmox dependencies.
- `GET /api/widgets-catalog/services`: route test for the success shape and the skeleton-fallback-on-missing-file case.
- `InstallWizardDialog`: component tests for step navigation (target step skipped for info widgets), the Install button's disabled state before the checkbox is checked, a successful install showing the backup filename, and a failed install showing the server's error message inline without closing the dialog.
- `WidgetRow`: extend the existing test file to verify the new "Install..." button opens the dialog with the correct `entry` passed through.
