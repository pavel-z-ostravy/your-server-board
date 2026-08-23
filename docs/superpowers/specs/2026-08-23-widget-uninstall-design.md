# Widget Uninstall — Design

**Date:** 2026-08-23
**Status:** Approved for planning

## Problem

The widget one-click install feature (shipped 2026-08-23) writes a chosen widget's config directly into `services.yaml`/`widgets.yaml`, but there's no way to undo that from the app — a user who installs a widget on the wrong service, or just wants it gone, has to hand-edit the config file (or restore from the automatic `.bak` file, which also reverts every other change made since). Pavel asked for a trash-can affordance in two places: on the live dashboard next to a service that has a widget, and on the `/widgets` catalog page.

## Goals

- A trash-can icon on the live dashboard, on any service card that currently has a widget configured, that removes just that service's `widget:` block — the service tile itself stays (reverts to a plain link card), matching this project's non-goal from the install spec ("no uninstall UI... yet" — this closes that gap for the service case specifically).
- On the `/widgets` catalog page, every entry that is currently installed (as a service widget, on one or more services, or as an info widget) shows an "Installed on:" list with a trash-can icon per instance — covering both categories, including info widgets (`resources`, `datetime`, `search`, ...) which have no dashboard-side removal affordance in this phase (see Non-goals).
- Removing a service's widget is a single, low-ceremony action (a lightweight inline confirm — "Remove widget from `<service>`? Cancel / Remove"), not a multi-step wizard: unlike install, there's no target/YAML/disclaimer decision to walk through, just "do it or don't."
- Every removal writes through the same backup-before-write, re-parse-validated `configWriter.writeConfigDocument` the install feature already uses — no new safety mechanism, full reuse.
- The dashboard reflects a successful removal without requiring a manual page reload.

## Non-goals

- **No trash-can icon on the dashboard for info widgets.** Info widgets (`resources`, `datetime`, `search`, ...) render in a separate part of the dashboard this spec doesn't touch (not investigated as part of this feature — the existing service-card component, `src/components/services/item.jsx`, only renders service widgets). Removing an info widget in this phase is only possible from the `/widgets` catalog page's "Installed on:" list. If dashboard-side info-widget removal is wanted later, that's a separate follow-up once that rendering path is understood.
- **No edit-in-place.** Removing a widget removes it; there's no "edit this widget's config" flow. To change a widget's settings, remove it and reinstall with different values (the existing install wizard already supports "attach to an existing service").
- **No bulk/multi-select removal.** One instance at a time, one confirm click at a time.
- **No undo beyond the automatic backup.** Same recovery story as install: a `.bak.<timestamp>` file is created before every removal write; restoring it is a manual file operation, same as today.
- **No removal of the service itself.** Only the `widget:` key is removed for service widgets — confirmed explicitly with Pavel, who chose this over deleting the whole service entry.

## Architecture

### Locating what's installed

Two new pure helpers in `src/utils/config/yamlDocument.js`, alongside the existing `find*`/`list*` functions:

```js
// Returns [{ type, serviceName }, ...] for every service across every group
// that currently has a widget: block - the type is widget.type.value, the
// serviceName is the enclosing single-key service map's key.
export function listInstalledServiceWidgets(servicesDoc) { ... }

// Returns [{ slug, index }, ...] for every top-level widgets.yaml entry -
// slug is the entry's single key (e.g. "resources", "datetime"), index is
// its position in the top-level Seq. Position (not just slug) matters
// because widgets.yaml commonly has more than one entry with the same key
// (e.g. two "resources" blocks for different mount points) - the index is
// what removal targets, not the slug alone.
export function listInstalledInfoWidgets(widgetsDoc) { ... }
```

Both return `[]` gracefully on a non-Seq/empty doc (reusing the same `isSeq` guard pattern already established for the other navigation functions).

### `GET /api/widgets-catalog/installed`

New route, `src/pages/api/widgets-catalog/installed/index.js`. Reads both config files via `readConfigDocument`, runs the two helpers above, and reshapes into a lookup keyed by catalog slug:

```
200 {
  services: { [slug: string]: string[] },  // e.g. { nextdns: ["My NextDNS Service"] }
  info: { [slug: string]: number[] }        // e.g. { resources: [0, 2] } - the indexes
}
500 { error }
```

Consumed by the `/widgets` page (to render "Installed on:" per catalog entry). The dashboard does NOT call this route — a service card already knows its own widget's `type` and the service's own `name` directly from the page's existing data (`service.widgets[].type`, `service.name`), so no lookup round-trip is needed there.

### `POST /api/widgets-catalog/uninstall`

New route, `src/pages/api/widgets-catalog/uninstall/index.js`, mirroring the install route's structure:

```
// category: "service"
{ category: "service", serviceName: string }

// category: "info"
{ category: "info", slug: string, index: number }
```

- `category: "service"`: finds the service via the existing `findServiceFieldsNode` helper (global-by-name, same as install's attach mode — no group needed), 404s if the service doesn't exist, 404s if it exists but has no `widget` key (`fieldsNode.has("widget")`), otherwise `fieldsNode.delete("widget")` and writes.
- `category: "info"`: reads `widgets.yaml`, checks `doc.contents.items[index]` exists AND its single key matches the claimed `slug` (defense against the list having changed between the page's last fetch and this click — e.g. another browser tab removed something first); 409 with a clear "config changed, please refresh" message on mismatch, 404 if the index is out of range; otherwise splices that one item out of the top-level Seq and writes.
- Both paths: `200 { success: true, backupFile }` on success, using the same `writeConfigDocument` backup-then-validate guarantee as every other write in this app.

### Frontend — dashboard

`src/components/services/item.jsx`'s existing `service-tags` area (the same top-right button row that already holds the Docker/Kubernetes/Proxmox stats-toggle buttons) gains one more conditional button, shown when `service.widgets?.length > 0`:

- A `BiTrash` icon button (matching the existing button styling in that row). Clicking it does not immediately delete — it flips local component state (`confirmingRemove`) that swaps the icon button for two small inline text buttons, "Remove?" and "Cancel", in the same spot (no modal, no popover positioning to get right — matches this row's existing low-chrome style). Clicking "Cancel" (or anything else on the card) flips the state back.
- Clicking "Remove?": `POST /api/widgets-catalog/uninstall` with `{ category: "service", serviceName: service.name }`. On success, calls SWR's global `mutate("/api/services")` (imported from `"swr"`) so `index.jsx`'s existing `useSWR("/api/services")` subscription revalidates and the card re-renders without its widget — no manual page reload needed, reusing the SWR cache-key relationship that's already there rather than plumbing a new refresh callback through props.
- On failure: the two-button state stays, with a small inline error text next to it (no wizard-style dedicated error screen needed for a single-field request).

### Frontend — `/widgets` catalog page

`src/pages/widgets.jsx`'s `WidgetRow` fetches `/api/widgets-catalog/installed` (one shared `useSWR` call at the `WidgetsPage` level, passed down — not one fetch per row) and, when the row is expanded and has installed instances, renders an "Installed on:" section above the existing Copy/Install buttons:

- Service entries: one line per service name in `installed.services[entry.slug]`, each with a trash icon.
- Info entries: one line per index in `installed.info[entry.slug]` (labeled generically, e.g. "Instance #1", "Instance #2" if there's more than one, since info widget items don't have a natural display name beyond their type) with a trash icon.
- Same two-state icon-button-to-"Remove?"/"Cancel" inline confirm pattern as the dashboard button (see above) — one `confirmingRemove` piece of state per line, not one per row, so confirming one instance doesn't affect the others.
- On success: re-fetch (SWR `mutate` on the `/api/widgets-catalog/installed` key) so the row's "Installed on:" list updates immediately.

## Testing

- `listInstalledServiceWidgets`/`listInstalledInfoWidgets`: unit tests against real fixture text (multi-group services.yaml with some services having widgets and some not; widgets.yaml with duplicate-slug entries), verifying both the found-instances case and the empty/non-Seq-doc guard case.
- `GET /api/widgets-catalog/installed`: route test with a mocked `configWriter`, verifying the slug-keyed reshaping from both helpers' raw output.
- `POST /api/widgets-catalog/uninstall`: route tests for both categories — success (widget removed, backup created, `doc.toString()` no longer contains the removed block), 404 (service not found; service found but no widget; info index out of range), 409 (info slug/index mismatch — simulating a stale client), 500 (write failure).
- `Item` component: test that the trash button only renders when `service.widgets.length > 0`, that confirming calls the uninstall route with the right `serviceName`, and that a successful call triggers the SWR `mutate` for `/api/services` (mocked).
- `/widgets` page: test that a catalog entry with `installed` data renders the "Installed on:" list with the right names/indexes, that clicking a trash icon calls the uninstall route with the right body per category, and that success removes that line from the list.
