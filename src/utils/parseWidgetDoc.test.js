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
