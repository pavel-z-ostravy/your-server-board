# Hamburger Menu + Widgets Catalog Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent hamburger nav menu (desktop + mobile) and a `/widgets` page listing every Homepage widget type (name, description, copy-to-clipboard YAML example), sourced live from the upstream `gethomepage/homepage` GitHub repo.

**Architecture:** A pure parser extracts `{title, description, yamlExample}` from a widget doc's markdown (frontmatter + first fenced YAML block). A new API route fetches the upstream repo's file tree and each matching doc's raw content via this codebase's existing `cachedRequest` helper (already used by `pages/api/releases.js` for GitHub API calls, so no new caching mechanism or dependency), filters to real widget docs (excluding category-landing `index.md` files), and returns `{services, info}`. A new `NavHeader` component (built on the `@headlessui/react` `Menu` already used by `components/services/dropdown.jsx`, so click-outside/Escape/focus handling comes for free) renders in `_app.jsx` above every page, with an extensible array of nav items. The `/widgets` page fetches the catalog via SWR, offers client-side search, and renders each entry's YAML example with `prism-react-renderer` (new dependency) plus a copy-to-clipboard button.

**Tech Stack:** Next.js 16 (pages router) + React 19, SWR, `@headlessui/react` (existing), `prism-react-renderer` (new), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-22-hamburger-widgets-catalog-design.md`

## Global Constraints

- **No config-file writes anywhere in this plan.** The "install" story is entirely "copy this YAML to your clipboard" — nothing in any task writes to `services.yaml`, `widgets.yaml`, or any other file under `config/`.
- **Reuse `cachedRequest` from `utils/proxy/http`** for every GitHub HTTP call in this plan — do not add a hand-rolled cache or call `fetch`/`httpProxy` directly. This matches the existing `pages/api/releases.js` precedent exactly and keeps the whole feature's GitHub API usage within the unauthenticated rate limit (one `api.github.com` call per cache period; `raw.githubusercontent.com` calls are not subject to that limit).
- **Exclude `docs/widgets/services/index.md` and `docs/widgets/info/index.md`** (and any other `index.md`) from the catalog — these are category-landing pages, not individual widget docs (verified live 2026-08-22: both exist, both have frontmatter that would otherwise produce a fake "widget" entry).
- **Reuse `@headlessui/react`'s `Menu`** for `NavHeader` — do not hand-roll click-outside/Escape-key listeners; `components/services/dropdown.jsx` already establishes this pattern and its test file (`dropdown.test.jsx`) already establishes how to stub `@headlessui/react` deterministically in tests.
- **No server-specific code** — this repo ships publicly; nothing may reference this deployment's real host, IP, or credentials. Every fixture value in this plan's tests is either genuinely public upstream-repo content (the real Plex/Date & Time doc examples, verified live 2026-08-22) or clearly invented.
- **pnpm only.**
- **Every new/modified module needs Vitest coverage**, and every task must leave `pnpm test`, `pnpm lint`, `pnpm exec prettier --check "src/**/*.{js,jsx}"`, and `pnpm build` all green. `pnpm build` is a hard requirement on this project after a prior feature shipped a build-breaking client/server bundle leak that `pnpm test`/`pnpm lint`/`pnpm exec prettier` alone didn't catch — never skip it.

---

### Task 1: `parseWidgetDoc` — pure widget-doc parser

**Files:**

- Create: `src/utils/parseWidgetDoc.js`
- Create: `src/utils/parseWidgetDoc.test.js`

**Interfaces:**

- Produces (used by Task 2):

  - `parseWidgetDoc(markdown: unknown): { title: string | null, description: string | null, yamlExample: string | null }` — extracts `title`/`description` from a `---\n...\n---` YAML frontmatter block (first match of each `field: value` line), and the content of the first ` ```yaml ` or ` ```yml ` fenced code block in the body (trailing newline trimmed). Any piece that isn't found is `null`. Non-string input returns all-`null` rather than throwing.

- [ ] **Step 1: Write the failing tests**

Create `src/utils/parseWidgetDoc.test.js`:

````js
import { describe, expect, it } from "vitest";

import { parseWidgetDoc } from "./parseWidgetDoc";

// Real content, verified against the live upstream gethomepage/homepage repo
// (docs/widgets/services/plex.md, 2026-08-22).
const PLEX_MARKDOWN = `---
title: Plex
description: Plex Widget Configuration
---

Learn more about [Plex](https://www.plex.tv/).

The core Plex API is somewhat limited but basic info regarding library sizes and the number of active streams is supported.

\`\`\`yaml
widget:
  type: plex
  url: http://plex.host.or.ip:32400
  key: mytokenhere # see https://www.plexopedia.com/plex-media-server/general/plex-token/
\`\`\`
`;

describe("parseWidgetDoc", () => {
  it("extracts title, description, and the fenced YAML example from a real widget doc", () => {
    expect(parseWidgetDoc(PLEX_MARKDOWN)).toEqual({
      title: "Plex",
      description: "Plex Widget Configuration",
      yamlExample:
        "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere # see https://www.plexopedia.com/plex-media-server/general/plex-token/",
    });
  });

  it("accepts a ```yml fence (not just ```yaml)", () => {
    const markdown = `---\ntitle: X\ndescription: Y\n---\n\n\`\`\`yml\nfoo: bar\n\`\`\`\n`;
    expect(parseWidgetDoc(markdown).yamlExample).toBe("foo: bar");
  });

  it("returns all null when there is no frontmatter", () => {
    expect(parseWidgetDoc("# Just a heading\nNo frontmatter here.")).toEqual({
      title: null,
      description: null,
      yamlExample: null,
    });
  });

  it("returns yamlExample: null when the doc has no fenced code block", () => {
    const markdown = `---\ntitle: Info Widgets\ndescription: Homepage info widgets.\n---\n\nJust a list, no code block.\n`;
    expect(parseWidgetDoc(markdown)).toEqual({
      title: "Info Widgets",
      description: "Homepage info widgets.",
      yamlExample: null,
    });
  });

  it("uses only the first fenced block when a doc has more than one", () => {
    const markdown = `---\ntitle: X\ndescription: Y\n---\n\n\`\`\`yaml\nfirst: block\n\`\`\`\n\nSome prose.\n\n\`\`\`yaml\nsecond: block\n\`\`\`\n`;
    expect(parseWidgetDoc(markdown).yamlExample).toBe("first: block");
  });

  it("returns all null for non-string input", () => {
    expect(parseWidgetDoc(null)).toEqual({ title: null, description: null, yamlExample: null });
    expect(parseWidgetDoc(undefined)).toEqual({ title: null, description: null, yamlExample: null });
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/parseWidgetDoc.test.js`
Expected: FAIL — `parseWidgetDoc.js` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/utils/parseWidgetDoc.js`:

````js
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const YAML_BLOCK_PATTERN = /```ya?ml\r?\n([\s\S]*?)```/;

function extractFrontmatterField(frontmatterBlock, field) {
  const match = frontmatterBlock.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

// Extracts { title, description, yamlExample } from a widget doc's raw
// markdown (upstream gethomepage/homepage's docs/widgets/**/*.md shape:
// YAML frontmatter with title/description, then prose, then a fenced YAML
// config example). Any piece not found is null - a doc missing one piece
// (e.g. no fenced block) is still a valid, partially-usable result, not an
// error. `.match()` without the `g` flag returns the first match only, so
// a doc with multiple fenced blocks correctly yields the first one.
export function parseWidgetDoc(markdown) {
  if (typeof markdown !== "string") {
    return { title: null, description: null, yamlExample: null };
  }

  const frontmatterMatch = markdown.match(FRONTMATTER_PATTERN);
  const frontmatterBlock = frontmatterMatch ? frontmatterMatch[1] : "";

  const title = extractFrontmatterField(frontmatterBlock, "title");
  const description = extractFrontmatterField(frontmatterBlock, "description");

  const yamlMatch = markdown.match(YAML_BLOCK_PATTERN);
  const yamlExample = yamlMatch ? yamlMatch[1].trimEnd() : null;

  return { title, description, yamlExample };
}
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/parseWidgetDoc.test.js`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/utils/parseWidgetDoc.js" "src/utils/parseWidgetDoc.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/utils/parseWidgetDoc.js src/utils/parseWidgetDoc.test.js
git commit -m "feat(widgets-catalog): add pure widget-doc frontmatter/YAML parser"
```

---

### Task 2: `GET /api/widgets-catalog` route

**Files:**

- Create: `src/pages/api/widgets-catalog/index.js`
- Create: `src/__tests__/pages/api/widgets-catalog/index.test.js`

**Interfaces:**

- Consumes: `parseWidgetDoc` from `utils/parseWidgetDoc` (Task 1); `cachedRequest` from `utils/proxy/http` (existing, already used by `pages/api/releases.js`).
- Produces (used by Task 4):

  - `GET /api/widgets-catalog` → `200 { services: WidgetEntry[], info: WidgetEntry[] }` where `WidgetEntry = { slug: string, title: string, description: string, yamlExample: string | null }`, each array sorted alphabetically by `title`. `500 { error: "Failed to fetch widget catalog" }` only when the file-tree fetch itself fails (a single widget doc's fetch failing just excludes that one entry from its array, logged, never fails the whole route).

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/pages/api/widgets-catalog/index.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { cachedRequest, logger } = vi.hoisted(() => ({
  cachedRequest: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("utils/logger", () => ({ default: () => logger }));
vi.mock("utils/proxy/http", () => ({ cachedRequest }));

import handler from "pages/api/widgets-catalog/index";

const TREE_URL = "https://api.github.com/repos/gethomepage/homepage/git/trees/dev?recursive=1";

// Shape verified against a live GitHub API response (2026-08-22): a tree
// entry has at least `path` and `type`. Includes both category-landing
// index.md files (must be excluded) and an unrelated doc path (must be
// ignored) to prove the filter is scoped correctly.
const treeBody = {
  tree: [
    { path: "docs/widgets/services/plex.md", type: "blob" },
    { path: "docs/widgets/services/index.md", type: "blob" },
    { path: "docs/widgets/info/datetime.md", type: "blob" },
    { path: "docs/widgets/info/index.md", type: "blob" },
    { path: "docs/installation.md", type: "blob" },
    { path: "docs/widgets/authoring/metadata.md", type: "blob" },
  ],
};

// Real content, verified against the live upstream repo (2026-08-22).
const plexMarkdown = `---
title: Plex
description: Plex Widget Configuration
---

\`\`\`yaml
widget:
  type: plex
  url: http://plex.host.or.ip:32400
  key: mytokenhere
\`\`\`
`;

const datetimeMarkdown = `---
title: Date & Time
description: Date & Time Widget Configuration
---

\`\`\`yaml
- datetime:
    text_size: xl
\`\`\`
`;

describe("pages/api/widgets-catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 500 when the file tree fetch fails", async () => {
    cachedRequest.mockRejectedValueOnce(new Error("rate limited"));

    const req = {};
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch widget catalog" });
  });

  it("categorizes service and info widgets, excluding index.md and non-widget paths", async () => {
    cachedRequest.mockImplementation(async (url) => {
      if (url === TREE_URL) return treeBody;
      if (url.endsWith("docs/widgets/services/plex.md")) return plexMarkdown;
      if (url.endsWith("docs/widgets/info/datetime.md")) return datetimeMarkdown;
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = {};
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.services).toEqual([
      {
        slug: "plex",
        title: "Plex",
        description: "Plex Widget Configuration",
        yamlExample: "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere",
      },
    ]);
    expect(res.body.info).toEqual([
      {
        slug: "datetime",
        title: "Date & Time",
        description: "Date & Time Widget Configuration",
        yamlExample: "- datetime:\n    text_size: xl",
      },
    ]);
    expect(cachedRequest).not.toHaveBeenCalledWith(
      expect.stringContaining("index.md"),
      expect.anything(),
      expect.anything(),
    );
    expect(cachedRequest).not.toHaveBeenCalledWith(
      expect.stringContaining("installation.md"),
      expect.anything(),
      expect.anything(),
    );
    expect(cachedRequest).not.toHaveBeenCalledWith(
      expect.stringContaining("authoring"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("excludes a single widget doc whose fetch fails, without failing the whole catalog", async () => {
    cachedRequest.mockImplementation(async (url) => {
      if (url === TREE_URL) return treeBody;
      if (url.endsWith("docs/widgets/services/plex.md")) throw new Error("404");
      if (url.endsWith("docs/widgets/info/datetime.md")) return datetimeMarkdown;
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = {};
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.services).toEqual([]);
    expect(res.body.info).toHaveLength(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it("sorts each category alphabetically by title", async () => {
    const zebraMarkdown = `---\ntitle: Zebra\ndescription: Z\n---\n\n\`\`\`yaml\nzebra: true\n\`\`\`\n`;
    cachedRequest.mockImplementation(async (url) => {
      if (url === TREE_URL) {
        return {
          tree: [
            { path: "docs/widgets/services/zebra.md", type: "blob" },
            { path: "docs/widgets/services/plex.md", type: "blob" },
          ],
        };
      }
      if (url.endsWith("services/zebra.md")) return zebraMarkdown;
      if (url.endsWith("services/plex.md")) return plexMarkdown;
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const req = {};
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.services.map((e) => e.title)).toEqual(["Plex", "Zebra"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/index.test.js`
Expected: FAIL — the route module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/pages/api/widgets-catalog/index.js`:

```js
import createLogger from "utils/logger";
import { parseWidgetDoc } from "utils/parseWidgetDoc";
import { cachedRequest } from "utils/proxy/http";

const logger = createLogger("widgetsCatalog");

const TREE_URL = "https://api.github.com/repos/gethomepage/homepage/git/trees/dev?recursive=1";
const RAW_BASE_URL = "https://raw.githubusercontent.com/gethomepage/homepage/dev/";
const USER_AGENT = "your-server-board";
// 6 hours - keeps this route's total GitHub API usage (one api.github.com
// call per cache period; raw.githubusercontent.com calls are not subject to
// that limit) comfortably under the 60/hour unauthenticated rate limit.
const CACHE_MINUTES = 360;

const CATEGORY_DIRS = [
  ["docs/widgets/services/", "service"],
  ["docs/widgets/info/", "info"],
];

// Category-landing pages (docs/widgets/services/index.md, .../info/index.md)
// are real files with real frontmatter but aren't individual widget docs -
// excluded here rather than silently showing up as a fake "widget".
function categorizeAndSlug(path) {
  for (const [dir, category] of CATEGORY_DIRS) {
    if (path.startsWith(dir) && path.endsWith(".md")) {
      const slug = path.slice(dir.length, -".md".length);
      if (slug === "index") return null;
      return { category, slug };
    }
  }
  return null;
}

async function fetchWidgetEntry(path, slug) {
  const markdown = await cachedRequest(`${RAW_BASE_URL}${path}`, CACHE_MINUTES, USER_AGENT);
  const { title, description, yamlExample } = parseWidgetDoc(markdown);
  return { slug, title: title ?? slug, description: description ?? "", yamlExample };
}

export default async function handler(req, res) {
  let tree;
  try {
    tree = await cachedRequest(TREE_URL, CACHE_MINUTES, USER_AGENT);
  } catch (error) {
    logger.error("Failed to fetch widget doc file tree:", error);
    return res.status(500).json({ error: "Failed to fetch widget catalog" });
  }

  const matches = (tree?.tree ?? [])
    .map((entry) => {
      const info = categorizeAndSlug(entry.path);
      return info ? { path: entry.path, ...info } : null;
    })
    .filter((entry) => entry !== null);

  const results = await Promise.allSettled(matches.map((m) => fetchWidgetEntry(m.path, m.slug)));

  const services = [];
  const info = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      (matches[i].category === "service" ? services : info).push(result.value);
    } else {
      logger.error("Failed to fetch widget doc %s:", matches[i].path, result.reason);
    }
  });

  const byTitle = (a, b) => a.title.localeCompare(b.title);
  services.sort(byTitle);
  info.sort(byTitle);

  return res.status(200).json({ services, info });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/api/widgets-catalog/index.test.js`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/pages/api/widgets-catalog/index.js" "src/__tests__/pages/api/widgets-catalog/index.test.js" && pnpm build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/widgets-catalog/index.js src/__tests__/pages/api/widgets-catalog/index.test.js
git commit -m "feat(widgets-catalog): add GET /api/widgets-catalog route"
```

---

### Task 3: `NavHeader` — hamburger menu, wired into every page

**Files:**

- Create: `src/components/layout/NavHeader.jsx`
- Create: `src/components/layout/NavHeader.test.jsx`
- Modify: `src/pages/_app.jsx`

**Interfaces:**

- Consumes: nothing from earlier tasks (a static `NAV_ITEMS` array pointing at `/widgets`, a route Task 4 will create).
- Produces: renders on every page once wired into `_app.jsx`. No other task consumes this component's internals.

- [ ] **Step 1: Write the failing tests**

Create `src/components/layout/NavHeader.test.jsx`:

```jsx
// @vitest-environment jsdom

// Stub Menu/Transition to always render open (keeps tests deterministic),
// matching the existing pattern in src/components/services/dropdown.test.jsx.
vi.mock("@headlessui/react", async () => {
  const React = await import("react");
  const { Fragment } = React;

  function Transition({ as: As = Fragment, children }) {
    if (As === Fragment) return <>{children}</>;
    return <As>{children}</As>;
  }

  function Menu({ as: As = "div", children, ...props }) {
    const content = typeof children === "function" ? children({ open: true }) : children;
    return <As {...props}>{content}</As>;
  }

  function MenuButton(props) {
    return <button type="button" {...props} />;
  }
  function MenuItems(props) {
    return <div {...props} />;
  }
  function MenuItem({ children }) {
    return <>{children}</>;
  }

  Menu.Button = MenuButton;
  Menu.Items = MenuItems;
  Menu.Item = MenuItem;

  return { Menu, Transition };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import NavHeader from "./NavHeader";

describe("components/layout/NavHeader", () => {
  it("renders a hamburger button and a link to the Widgets page", () => {
    render(<NavHeader />);

    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();

    const widgetsLink = screen.getByRole("link", { name: "Widgets" });
    expect(widgetsLink).toBeInTheDocument();
    expect(widgetsLink).toHaveAttribute("href", "/widgets");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/components/layout/NavHeader.test.jsx`
Expected: FAIL — `NavHeader.jsx` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/components/layout/NavHeader.jsx`:

```jsx
import { Menu, Transition } from "@headlessui/react";
import Link from "next/link";
import { Fragment } from "react";
import { BiExtension, BiMenu } from "react-icons/bi";

// Plain array of { href, label, icon } - adding a page later is adding an
// entry here, not touching this component's rendering logic.
const NAV_ITEMS = [{ href: "/widgets", label: "Widgets", icon: BiExtension }];

export default function NavHeader() {
  return (
    <div className="absolute top-0 left-0 m-4 sm:m-8 z-20">
      <Menu as="div" className="relative inline-block text-left">
        <Menu.Button
          aria-label="Open menu"
          className="flex items-center justify-center w-8 h-8 rounded-md text-theme-500 dark:text-theme-300 hover:bg-theme-200/50 dark:hover:bg-theme-900/40"
        >
          <BiMenu size={20} />
        </Menu.Button>

        <Transition
          as={Fragment}
          enter="transition ease-out duration-100"
          enterFrom="transform opacity-0 scale-95"
          enterTo="transform opacity-100 scale-100"
          leave="transition ease-in duration-75"
          leaveFrom="transform opacity-100 scale-100"
          leaveTo="transform opacity-0 scale-95"
        >
          <Menu.Items className="absolute left-0 z-10 mt-2 w-48 origin-top-left rounded-md bg-theme-200/50 dark:bg-theme-900/50 backdrop-blur-sm shadow-md focus:outline-hidden text-theme-700 dark:text-theme-200">
            <div className="py-1">
              {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
                <Menu.Item key={href} as={Fragment}>
                  <Link
                    href={href}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-theme-300/70 dark:hover:bg-theme-900/70"
                  >
                    <Icon size={16} />
                    {label}
                  </Link>
                </Menu.Item>
              ))}
            </div>
          </Menu.Items>
        </Transition>
      </Menu>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/components/layout/NavHeader.test.jsx`
Expected: PASS, both tests green.

- [ ] **Step 5: Wire into `_app.jsx`**

In `src/pages/_app.jsx`, add the import alongside the other `utils/contexts/*` imports:

```js
import NavHeader from "components/layout/NavHeader";
```

Then change:

```jsx
<TabProvider>
  <Component {...pageProps} />
</TabProvider>
```

to:

```jsx
<TabProvider>
  <NavHeader />
  <Component {...pageProps} />
</TabProvider>
```

- [ ] **Step 6: Run the existing test suite to confirm nothing broke**

Run: `pnpm exec vitest run src/__tests__/pages/index.test.jsx`
Expected: PASS — `_app.jsx` itself has no direct test file, but `index.test.jsx` renders the page tree and must still pass unmodified. If it fails because `NavHeader`'s real (non-mocked) `next/link`/`@headlessui/react` behavior needs a router context that isolated component tests don't provide, that failure is expected only in `index.test.jsx`'s existing setup if it renders through `_app.jsx` - check whether `index.test.jsx` renders `<Home />` directly (most likely, matching this codebase's established pattern of testing page components in isolation, not through `_app.jsx`) rather than the App component; if so, `NavHeader` is never in that render tree and this run should pass with zero changes needed.

- [ ] **Step 7: Lint, format, and build**

Run: `pnpm lint && pnpm exec prettier --check "src/components/layout/NavHeader.jsx" "src/components/layout/NavHeader.test.jsx" "src/pages/_app.jsx" && pnpm build`
Expected: all clean/green. `pnpm build` is the load-bearing check here — confirm the build output's route table still lists every existing route and nothing errors, since this task adds a new client-side import (`next/link`) to the global app shell for the first time in this codebase.

- [ ] **Step 8: Commit**

```bash
git add src/components/layout/NavHeader.jsx src/components/layout/NavHeader.test.jsx src/pages/_app.jsx
git commit -m "feat(nav): add hamburger menu, wired into every page via _app.jsx"
```

---

### Task 4: `/widgets` page

**Files:**

- Create: `src/pages/widgets.jsx`
- Create: `src/__tests__/pages/widgets.test.jsx`
- Modify: `package.json` (new dependency)

**Interfaces:**

- Consumes: `GET /api/widgets-catalog` response shape from Task 2 (`{services, info}` of `{slug, title, description, yamlExample}`); `NavHeader`'s `/widgets` link from Task 3 now has somewhere real to point.
- Produces: nothing consumed by later tasks — final task in this plan.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add prism-react-renderer@2.4.1`
Expected: `package.json`/`pnpm-lock.yaml` gain the one package under `dependencies`.

- [ ] **Step 2: Write the failing tests**

Create `src/__tests__/pages/widgets.test.jsx`:

```jsx
// @vitest-environment jsdom

// Stub prism-react-renderer's Highlight to render the raw code as plain
// text - real tokenization is Prism's own well-tested behavior, not this
// app's; a deterministic stub avoids brittle assertions on token markup.
vi.mock("prism-react-renderer", () => ({
  Highlight: ({ code, children }) =>
    children({
      style: {},
      tokens: code.split("\n").map((line) => [{ content: line }]),
      getLineProps: () => ({}),
      getTokenProps: ({ token }) => ({ children: token.content }),
    }),
  themes: { nightOwl: {}, github: {} },
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WidgetsPage from "pages/widgets";

function renderWithSWR(ui) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

const catalogResponse = {
  services: [
    {
      slug: "plex",
      title: "Plex",
      description: "Plex Widget Configuration",
      yamlExample: "widget:\n  type: plex\n  url: http://plex.host.or.ip:32400\n  key: mytokenhere",
    },
    {
      slug: "sonarr",
      title: "Sonarr",
      description: "Sonarr Widget Configuration",
      yamlExample: "widget:\n  type: sonarr\n  url: http://sonarr.host.or.ip:8989\n  key: apikeyhere",
    },
  ],
  info: [
    {
      slug: "datetime",
      title: "Date & Time",
      description: "Date & Time Widget Configuration",
      yamlExample: null,
    },
  ],
};

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe("pages/widgets", () => {
  it("renders both categories from the catalog response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);

    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());
    expect(screen.getByText("Sonarr")).toBeInTheDocument();
    expect(screen.getByText("Date & Time")).toBeInTheDocument();
  });

  it("filters both categories by the search query", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("Search widgets..."), { target: { value: "plex" } });

    await waitFor(() => expect(screen.queryByText("Sonarr")).not.toBeInTheDocument());
    expect(screen.getByText("Plex")).toBeInTheDocument();
  });

  it("expands a widget row to show its YAML example and copies it to the clipboard", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Plex")).toBeInTheDocument());

    expect(screen.queryByText("Copy")).not.toBeInTheDocument();

    screen.getByText("Plex").click();

    await waitFor(() => expect(screen.getByText("Copy")).toBeInTheDocument());
    expect(screen.getByText(/type: plex/)).toBeInTheDocument();

    screen.getByText("Copy").click();

    await waitFor(() => expect(screen.getByText("Copied!")).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(catalogResponse.services[0].yamlExample);
  });

  it("shows a no-example message for a widget with no YAML block, and no Copy button", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(catalogResponse) });

    renderWithSWR(<WidgetsPage />);
    await waitFor(() => expect(screen.getByText("Date & Time")).toBeInTheDocument());

    screen.getByText("Date & Time").click();

    await waitFor(() => expect(screen.getByText("No example available.")).toBeInTheDocument());
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
  });

  it("shows a failure message when the catalog fetch fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "boom" }) });

    renderWithSWR(<WidgetsPage />);

    await waitFor(() => expect(screen.getByText("Failed to load widget catalog.")).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/pages/widgets.test.jsx`
Expected: FAIL — `src/pages/widgets.jsx` doesn't exist yet.

- [ ] **Step 4: Write the implementation**

Create `src/pages/widgets.jsx`:

```jsx
import { Highlight, themes } from "prism-react-renderer";
import { useContext, useRef, useState } from "react";
import useSWR from "swr";

import { ThemeContext } from "utils/contexts/theme";

const fetcher = (url) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("request failed");
    return r.json();
  });

function matchesQuery(entry, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return entry.title.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
}

function WidgetRow({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
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
              <button type="button" onClick={handleCopy} className="text-xs text-theme-500 dark:text-theme-300 mt-2">
                {copied ? "Copied!" : "Copy"}
              </button>
            </>
          ) : (
            <p className="text-theme-500 dark:text-theme-300">No example available.</p>
          )}
        </div>
      )}
    </li>
  );
}

export default function WidgetsPage() {
  const { data, error } = useSWR("/api/widgets-catalog", fetcher);
  const [query, setQuery] = useState("");

  return (
    <div className="flex flex-col m-4 sm:m-8 sm:mt-16 mb-2">
      <h1 className="text-theme-800 dark:text-theme-300 text-xl font-medium mb-4">Widgets</h1>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search widgets..."
        className="mb-4 px-3 py-1.5 rounded-md bg-theme-200/50 dark:bg-theme-900/20 text-sm"
      />

      {error && <p className="text-rose-500/80">Failed to load widget catalog.</p>}
      {!data && !error && <p className="text-theme-500 dark:text-theme-300 text-sm">Loading...</p>}

      {data && (
        <>
          <h2 className="text-sm font-medium mt-2">Service Widgets</h2>
          <ul>
            {data.services
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow key={entry.slug} entry={entry} />
              ))}
          </ul>

          <h2 className="text-sm font-medium mt-4">Info Widgets</h2>
          <ul>
            {data.info
              .filter((entry) => matchesQuery(entry, query))
              .map((entry) => (
                <WidgetRow key={entry.slug} entry={entry} />
              ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/pages/widgets.test.jsx`
Expected: PASS, all 5 tests green.

- [ ] **Step 6: Run the full suite, lint, format, and build**

Run: `pnpm test && pnpm lint && pnpm exec prettier --check "src/**/*.{js,jsx}" && pnpm build`
Expected: all green. `pnpm build` specifically must succeed — confirm `/widgets` appears in the build output's route table and no client/server bundle leak is introduced (this page imports `prism-react-renderer` and `ThemeContext`, both client-safe; it does not import anything from `utils/config/`, `utils/ssh/`, or `utils/proxy/http`).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/pages/widgets.jsx src/__tests__/pages/widgets.test.jsx
git commit -m "feat(widgets-catalog): add /widgets page with search and copy-to-clipboard"
```

---

## Self-Review Notes

- **Spec coverage:** hamburger menu on every page via `_app.jsx` (Task 3), extensible nav-item array (Task 3), `/widgets` page with search (Task 4), live upstream-GitHub-sourced catalog (Task 2) excluding category-landing pages (Task 2's `categorizeAndSlug`), copy-to-clipboard with a `navigator.clipboard` fallback (Task 4), no config-file writes anywhere (verified: no task imports `js-yaml`, `fs`, or any `utils/config/*` writer), syntax-highlighted YAML via `prism-react-renderer` (Task 4, confirmed as a real per-user-request dependency addition, not silently downgraded) — all covered.
- **Type/interface consistency check:** `parseWidgetDoc`'s return shape (Task 1) matches exactly what Task 2's `fetchWidgetEntry` destructures (`title`, `description`, `yamlExample`). Task 2's `WidgetEntry` shape (`slug`, `title`, `description`, `yamlExample`) matches exactly what Task 4's `WidgetRow`/`matchesQuery` read. `NavHeader`'s `/widgets` href (Task 3) matches the actual page route Task 4 creates (`src/pages/widgets.jsx` → `/widgets`).
- **No placeholders:** every step above contains complete, runnable code — no "add appropriate tests", no "similar to Task N" elisions.
