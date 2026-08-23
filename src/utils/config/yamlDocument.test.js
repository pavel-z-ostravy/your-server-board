import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

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
