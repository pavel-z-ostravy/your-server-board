# Drag-and-Drop Dashboard Layout — Design

**Date:** 2026-08-21
**Status:** Approved for planning

## Problem

The dashboard's section order (native Homepage service/bookmark groups, plus this fork's custom `DisksGroup`/`ProxmoxVmsGroup` sections) is currently fixed. Native groups can only be reordered by hand-editing `config/services.yaml`/`config/bookmarks.yaml` and — for advanced positioning — Homepage's own `settings.layout` key. The two custom sections aren't part of that system at all; they're hardcoded after `{servicesAndBookmarksGroups}` in `src/pages/index.jsx` in a fixed order. Pavel wants to rearrange sections by mouse, with smooth reflow, and wants this to also cover Homepage widgets he plans to add later — so the mechanism needs to be generic across native and custom sections, not a one-off for the two sections that exist today.

## Goals

- Drag-and-drop reordering of whole top-level sections (service groups, bookmark groups, `DisksGroup`, `ProxmoxVmsGroup`, and any future section registered the same way) relative to each other.
- Order persists server-side, so it's the same across browsers/devices — not per-browser `localStorage`.
- New sections that appear later (a new service group added to `services.yaml`, a future Homepage widget, a future custom section) show up automatically (appended at the end) rather than being hidden or crashing.
- Smooth, live reflow while dragging (Trello/Notion-style) — never a free-form canvas with gaps.

## Non-goals

- Reordering individual items *within* a section (a single service tile inside its group) — out of scope, whole-section reordering only.
- Per-tab section order — Homepage's tab feature exists but isn't in use on this deployment today; this design targets one global order. Per-tab ordering is a natural future extension if tabs come into use, not built now (YAGNI).
- Any auth gate on the new write endpoint — the app runs with no authentication by default, and per explicit instruction, the new order-write endpoint stays unauthenticated even when NextAuth is configured elsewhere, consistent with the rest of the dashboard's current behavior.

## Architecture

### Section registry

A single ordered list of **section descriptors** drives what renders in `src/pages/index.jsx`, replacing today's fixed JSX sequence (`{servicesAndBookmarksGroups}` then `<ProxmoxVmsGroup />` then `<DisksGroup />`). Each descriptor has:

- `id` — stable identifier. For native service/bookmark groups, this is the group's `name` (already unique, already used as the React `key`). For custom sections, a fixed slug (`"proxmox-vms"`, `"disks"`).
- `kind` — `"service-group" | "bookmark-group" | "custom"` — determines which component renders it.
- The actual render props/component reference for that section (native groups keep using `ServicesGroup`/`BookmarksGroup` exactly as today; custom sections reference `ProxmoxVmsGroup`/`DisksGroup` exactly as today — no changes to those components' internals, only to how `index.jsx` sequences and wraps them).

`index.jsx` builds the full list of descriptors every render (from `services`/`bookmarks` data plus a small hardcoded list of custom sections), then sorts it according to the persisted order (see below) before rendering, wrapping each descriptor's output in a draggable wrapper.

### Persistence

New file `config/layout-order.yaml` (gitignored, like every other user config file in `config/`), containing a single list of section IDs in display order — nothing else. Deliberately **not** stored in `config/settings.yaml`: this codebase's only YAML library (`js-yaml`) doesn't preserve comments or formatting on write, so writing order changes into the user's hand-edited `settings.yaml` would silently strip its comments on the first drag. A dedicated file sidesteps that entirely — the whole file is machine-owned, safe to overwrite wholesale.

New API route `POST /api/layout-order` — validates the request body is an array of strings, writes it to `config/layout-order.yaml` (via the existing `js-yaml`/config-file conventions already used elsewhere in `utils/config/`), returns the saved order. The persisted order must also be available when the dashboard page first renders, so every visitor sees the saved arrangement immediately, not just after a client-side fetch resolves — the implementation plan should follow whatever mechanism `index.jsx` already uses to get `services`/`bookmarks` data to the initial render (investigate this codebase's existing pattern rather than assuming SSR vs. client-fetch) and read `layout-order.yaml` the same way. No auth check on the write route, matching the rest of the app's default posture and Pavel's explicit choice.

**Merge logic (pure function, the core piece worth unit-testing):** given the persisted order (an array of IDs, possibly referencing sections that no longer exist) and the actual current set of section descriptors, produce the final render order: known IDs in their persisted relative order first, then any current sections *not* in the persisted list appended at the end (in their natural/default order), with persisted IDs that no longer correspond to any current section silently dropped. This is what makes "add a new service group" or "a future widget" show up automatically without needing a migration step.

### Drag interaction

`@dnd-kit/core` + `@dnd-kit/sortable` (new dependencies) — a vertical `SortableContext` wrapping the full section list. Each section gets a small drag-handle icon in its header (not the whole card/group — sections already contain interactive elements like the Refresh button and Details toggle that must keep working normally). Dragging by the handle reflows the other sections live; dropping commits the new order.

On drop: update local React state immediately (optimistic — the reorder is visible with no delay), then fire the `POST /api/layout-order` request in the background. On failure, revert local state to the last known-good order and show a brief inline error (reusing this codebase's existing error-message styling conventions, e.g. the `text-rose-500/80` pattern already used in `DisksGroup`/`ProxmoxVmsGroup`).

## Testing

- Pure function: the merge-persisted-order-with-current-sections logic gets unit tests — known order preserved, unknown persisted IDs dropped, new/unlisted sections appended at the end, empty/missing persisted file falls back to a sensible default order.
- API route: standard mock-based tests matching this codebase's existing route-test conventions — valid array body accepted and written, invalid body (non-array, non-string entries) rejected with 400, write failure surfaces a clean error.
- The drag interaction itself (actual mouse-drag reflow behavior) is verified manually in the browser, consistent with how this project has verified UI work in every prior plan — not covered by automated tests, since meaningfully testing real drag-and-drop physics through Testing Library provides little confidence relative to its cost.
