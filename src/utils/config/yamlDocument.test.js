import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import {
  ensureTopSeq,
  findGroupServicesSeq,
  findServiceFieldsNode,
  findServiceFieldsNodeInGroup,
  listGroupNames,
  listInstalledInfoWidgets,
  listInstalledServiceWidgets,
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

// parseDocument("") and parseDocument of a comment-only string both produce
// a document whose `.contents` is `null` (not a Seq) - this is what an
// empty/malformed services.yaml parses to.
const EMPTY_DOC = parseDocument("# just a comment\n");

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

  it("returns null instead of throwing when the doc has no top-level Seq", () => {
    expect(EMPTY_DOC.contents).toBeNull();
    expect(findServiceFieldsNode(EMPTY_DOC, "Transmission")).toBeNull();
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

  it("returns null instead of throwing when the doc has no top-level Seq", () => {
    expect(findGroupServicesSeq(EMPTY_DOC, "Media")).toBeNull();
  });
});

describe("findServiceFieldsNodeInGroup", () => {
  const AMBIGUOUS_FIXTURE = `---
- Media:
    - Plex:
        href: http://media-plex.local/
- Remote:
    - Plex:
        href: http://remote-plex.local/
`;

  it("finds the service scoped to the named group, not the first match anywhere", () => {
    const doc = parseDocument(AMBIGUOUS_FIXTURE);
    const fields = findServiceFieldsNodeInGroup(doc, "Remote", "Plex");
    expect(fields.toJSON()).toEqual({ href: "http://remote-plex.local/" });
  });

  it("returns null when the group exists but the service isn't in it", () => {
    const doc = parseDocument(AMBIGUOUS_FIXTURE);
    expect(findServiceFieldsNodeInGroup(doc, "Media", "DoesNotExist")).toBeNull();
  });

  it("returns null when the group doesn't exist", () => {
    const doc = parseDocument(AMBIGUOUS_FIXTURE);
    expect(findServiceFieldsNodeInGroup(doc, "DoesNotExist", "Plex")).toBeNull();
  });
});

describe("listServiceNames", () => {
  it("returns every service name across all groups, in document order", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    expect(listServiceNames(doc)).toEqual(["Plex", "Sonarr", "Transmission"]);
  });

  it("returns an empty array instead of throwing when the doc has no top-level Seq", () => {
    expect(listServiceNames(EMPTY_DOC)).toEqual([]);
  });
});

describe("listGroupNames", () => {
  it("returns every group name, in document order", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    expect(listGroupNames(doc)).toEqual(["Media", "Downloads"]);
  });

  it("returns an empty array instead of throwing when the doc has no top-level Seq", () => {
    expect(listGroupNames(EMPTY_DOC)).toEqual([]);
  });
});

describe("ensureTopSeq", () => {
  it("returns the existing Seq unchanged when contents is already a Seq", () => {
    const doc = parseDocument(SERVICES_FIXTURE);
    const seq = ensureTopSeq(doc);
    expect(seq).toBe(doc.contents);
    expect(seq.items).toHaveLength(2);
  });

  it("replaces a comment-only (non-Seq) contents with an empty Seq, preserving the header comment", () => {
    const doc = parseDocument("---\n# For configuration options, see:\n# https://example.com\n");
    const seq = ensureTopSeq(doc);
    expect(seq.items).toEqual([]);
    seq.items.push(doc.createNode({ NextDNS: [] }));
    const out = doc.toString();
    expect(out).toContain("# For configuration options, see:");
    expect(out.indexOf("# For configuration options")).toBeLessThan(out.indexOf("NextDNS"));
  });

  it("replaces a fully-empty (null contents) doc with an empty Seq", () => {
    const doc = parseDocument("");
    const seq = ensureTopSeq(doc);
    expect(seq.items).toEqual([]);
    seq.items.push(doc.createNode({ resources: { cpu: true } }));
    expect(doc.toString().trim()).toBe("- resources:\n    cpu: true".trim());
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

  it("throws when the fragment contains an alias whose anchor is defined outside the 'widget' subtree", () => {
    expect(() => parseWidgetFragment("base: &b {u: 1}\nwidget:\n  type: x\n  cfg: *b\n")).toThrow(
      "Invalid widget YAML",
    );
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
  it("returns slug, index, and a content fingerprint for every entry, including duplicate slugs", () => {
    const doc = parseDocument(`---
- resources:
    cpu: true
- resources:
    disk: /mnt
- datetime:
    text_size: xl
`);
    expect(listInstalledInfoWidgets(doc)).toEqual([
      { slug: "resources", index: 0, fingerprint: '{"resources":{"cpu":true}}' },
      { slug: "resources", index: 1, fingerprint: '{"resources":{"disk":"/mnt"}}' },
      { slug: "datetime", index: 2, fingerprint: '{"datetime":{"text_size":"xl"}}' },
    ]);
  });

  it("gives a different fingerprint to entries with the same slug but different content", () => {
    const doc = parseDocument(`---
- resources:
    cpu: true
- resources:
    disk: /mnt
`);
    const [first, second] = listInstalledInfoWidgets(doc);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("returns an empty array instead of throwing when the doc has no top-level Seq", () => {
    expect(listInstalledInfoWidgets(EMPTY_DOC)).toEqual([]);
  });
});
