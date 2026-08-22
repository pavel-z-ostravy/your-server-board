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
