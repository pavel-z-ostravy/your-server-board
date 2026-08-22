# Hamburger Menu + Widgets Catalog Page — Design

**Date:** 2026-08-22
**Status:** Approved for planning

## Problem

The dashboard has no persistent navigation today — `src/pages/_app.jsx` renders only the active page, and the only page that exists is `index.jsx` (plus API routes and auth pages). Pavel wants a hamburger menu (desktop and mobile) that opens a dedicated "Widgets" page: a searchable catalog of every widget type Homepage supports (~160 service widgets like Plex/Sonarr, ~12 info widgets like Resources/Search), showing each one's name, description, and a ready-to-copy YAML config example — mirroring what `https://gethomepage.dev/widgets/` documents, but sourced live from the upstream `gethomepage/homepage` GitHub repo instead of scraping that docs site's HTML.

## Goals

- A hamburger-triggered navigation menu, present on every page (desktop and mobile), built as a small extensible list of nav items — not hardcoded to just this one page, so a future page is a one-line addition.
- A `/widgets` page listing every service and info widget with name + description, with client-side search/filter.
- Clicking a widget shows its full description and a syntax-highlighted YAML example (the exact block already written and maintained by Homepage's own docs authors) with a one-click "Copy" button.
- Data is live from the upstream `gethomepage/homepage` GitHub repo (`docs/widgets/**/*.md`) — always in sync with whatever widgets that project currently documents, not a snapshot baked into this fork.

## Non-goals

- **No in-app config writing.** This repo has one prior, explicit design decision against an in-app settings UI (`docs/superpowers/specs/2026-08-11-your-server-board-design.md`): `js-yaml` cannot round-trip comments/formatting, so writing generated YAML into a user's hand-edited `services.yaml`/`widgets.yaml` would silently destroy their edits — exactly the risk the drag-and-drop layout feature sidestepped by writing to its own dedicated `layout-order.yaml` instead of `settings.yaml`. This feature does not touch either file. "Install" means "copy this YAML to your clipboard," full stop — the user still pastes it into their own config by hand.
- **No per-widget config form / placeholder auto-fill.** The copy-to-clipboard block is exactly what the widget's doc file already shows (e.g. `url: http://plex.host.or.ip:32400`) — the user edits placeholders themselves after pasting. Recognizing and pre-filling placeholders isn't attempted; there's no consistent placeholder convention across 160+ independently-authored doc files to build that on.
- **No HTML scraping of gethomepage.dev.** Confirmed live (2026-08-22): that site is a static MkDocs build with no exposed JSON/search-index endpoint. The upstream GitHub repo's `docs/widgets/**/*.md` files are the actual source those pages are generated from — same content, but structured (YAML frontmatter + a fenced code block) instead of rendered HTML.
- **No widget-runtime changes.** This feature is entirely about _discovering and copying config_, not about how widgets execute once configured — `src/widgets/widgets.js`/`components.js` are untouched.

## Architecture

### Catalog data source

A new server-side module fetches the upstream repo's full file tree in one call — `GET https://api.github.com/repos/gethomepage/homepage/git/trees/dev?recursive=1` (verified 2026-08-22: `dev` is the upstream default branch) — and filters paths matching `docs/widgets/services/*.md` and `docs/widgets/info/*.md`. For each matching path, it fetches the raw file content from `https://raw.githubusercontent.com/gethomepage/homepage/dev/<path>` (this endpoint is not subject to the GitHub REST API's 60-requests/hour unauthenticated rate limit the way `api.github.com` calls are — only the one tree-listing call uses that budget). Each file is parsed for:

- YAML frontmatter's `title` and `description` fields (e.g. `title: Plex`, `description: Plex Widget Configuration`) — every file verified to have this shape.
- The first fenced ` ```yaml ... ``` ` code block in the body — the ready-to-copy example.

Result shape per entry: `{ slug: string, title: string, description: string, yamlExample: string | null, category: "service" | "info" }`. A widget doc with no fenced YAML block (rare, but possible) gets `yamlExample: null` and the UI shows only its description with no Copy button for that one entry — not a fatal error for the whole catalog.

The whole result is cached in-process with a TTL (6 hours) behind a single module-level variable — a fresh dashboard visit doesn't refetch ~170 files from GitHub on every load, and the total GitHub REST API cost stays at one tree-listing call per cache period, comfortably under the unauthenticated rate limit even with the raw-content fetches added on top (those don't count against it). No new persistent storage; this is exactly the same "in-memory, time-boxed cache, no database" pattern this app already uses nowhere else but is simple to introduce here since nothing about it needs to survive a restart.

### API route

`GET /api/widgets-catalog` → `200 { services: WidgetEntry[], info: WidgetEntry[] }` on success. On a total fetch failure (GitHub unreachable, rate-limited with no cache yet available) → `500 { error: "..." }`, logged server-side. Once the cache has been populated once, a later transient GitHub failure is masked entirely — stale cached data is served rather than erroring, since "the widget catalog is a few hours old" is a fully acceptable degradation and "the whole page breaks because GitHub hiccuped" is not.

### Frontend — navigation

`src/pages/_app.jsx` gains a new `NavHeader` component (new file, `src/components/layout/NavHeader.jsx` — living alongside the existing `SortableSection`/`SortableSectionList` from the drag-and-drop feature, same directory), rendered once, above `<Component {...pageProps} />`, so every page gets it. Nav items are a plain array of `{ href, label, icon }` objects defined in the same file — today just `[{ href: "/widgets", label: "Widgets", icon: BiExtension }]` (or a similarly fitting icon from the already-installed `react-icons/bi` set this codebase already uses for `BiMove`). Adding a second page later is adding a second array entry, not touching component logic.

Behavior: a hamburger icon button (`BiMenu`) toggles a panel listing the nav items. On mobile (below Tailwind's `sm` breakpoint, matching this codebase's existing breakpoint conventions elsewhere) it's a full-width dropdown/overlay panel; on desktop it can stay a simple anchored dropdown from the same button — no separate always-visible desktop bar is needed for a one-item (soon few-item) menu, keeping this from growing into a second design language on top of the existing footer icon row. Closes on: selecting an item, clicking outside, or pressing Escape.

### Frontend — `/widgets` page

New `src/pages/widgets.jsx`. Fetches `/api/widgets-catalog` via `useSWR` (matching this codebase's established fetcher/error-handling pattern from `ProxmoxVmsGroup`/`DisksGroup`). Renders two sections, "Service Widgets" and "Info Widgets", each a filterable list (a text input filters by `title`/`description` substring match, case-insensitive, client-side over the already-fetched list — no server round-trip per keystroke). Clicking a widget row expands it in place (same lazy-expand-in-place interaction pattern `VmCard`'s "Details" toggle already established) to show the full description and the YAML example in a `<pre>` block with a "Copy" button (`navigator.clipboard.writeText`, with a brief "Copied!" confirmation state).

### Error handling

- Catalog fetch totally fails and no cache exists yet: `/widgets` shows an inline "Failed to load widget catalog" message — the rest of the dashboard (`index.jsx`, its own independent data) is completely unaffected, since this is a separate page, not a section bolted onto `index.jsx`.
- A single widget doc missing a YAML example: still listed, browsable, just without a Copy button for that one entry (see Architecture above).
- `navigator.clipboard` unavailable (very old browser, non-HTTPS context): the Copy button falls back to visibly selecting the `<pre>` block's text so the user can still copy manually, rather than silently doing nothing.

## Testing

- Pure parser functions (frontmatter extraction, fenced-YAML-block extraction) get unit tests using real fixture text captured from actual upstream widget doc files (e.g. the real `plex.md` content, verified live 2026-08-22) plus edge cases: no frontmatter, no fenced block, multiple fenced blocks (first one wins).
- The catalog-fetching module's GitHub-tree-filtering logic gets unit tests with mocked `fetch` responses (a representative tree JSON, a couple of raw file bodies) — verifying only `docs/widgets/{services,info}/*.md` paths are picked up and everything else in the tree is ignored.
- `GET /api/widgets-catalog` gets route tests matching this codebase's established mock-based pattern: success, total failure with no cache (500), and — the one genuinely new case this route introduces — serving stale cached data after a fetch that fails on a _subsequent_ call.
- `NavHeader` gets component tests: hamburger opens/closes the panel, item click navigates and closes the panel, outside-click and Escape close it.
- `/widgets` page gets tests for: rendering both categories from a mocked catalog response, the search filter narrowing results, the Copy button writing to a mocked `navigator.clipboard.writeText`, and the loading/error states.
