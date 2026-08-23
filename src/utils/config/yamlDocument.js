import { Document, isMap, isSeq, parseDocument } from "yaml";

// Stringifying a detached node directly (e.g. `String(node)`) does NOT
// exercise the `yaml` package's real anchor/alias resolution: without a
// stringify `ctx`, collection nodes just fall back to `JSON.stringify`,
// which silently embeds `{ source: "<anchor name>" }` for an alias whose
// anchor lives outside the node's own subtree instead of throwing. The
// actual crash (see configWriter.writeConfigDocument) only happens once the
// node is attached to a *different* document and that document's
// `.toString()` walks the tree looking for the anchor. Reproduce that here
// by stringifying the node as the sole contents of a scratch Document, so an
// alias whose anchor isn't part of the extracted subtree is caught now,
// with a clear message, instead of surfacing later as a raw crash in the
// writer.
function assertStringifiable(node) {
  const scratch = new Document();
  scratch.contents = node;
  try {
    scratch.toString();
  } catch (e) {
    throw new Error(`Invalid widget YAML: ${e.message}`);
  }
}

// services.yaml shape: top-level Seq of single-key group Maps, each group's
// value a Seq of single-key service Maps, each service's value a Map of
// fields (href, description, widget, ...).

export function findServiceFieldsNode(servicesDoc, serviceName) {
  const topSeq = servicesDoc.contents;
  if (!isSeq(topSeq)) return null;
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

// Returns a service's existing "widget:\n  ..." block as YAML text (ready to
// drop straight into the install wizard's editable preview), or null if the
// service has no widget configured yet. Re-serializing through a scratch
// Document (rather than string-templating the fields) preserves comments,
// quoting, and unresolved `${ENV_VAR}` references exactly as they're
// written in the source file.
export function getServiceWidgetYaml(servicesDoc, serviceName) {
  const fieldsNode = findServiceFieldsNode(servicesDoc, serviceName);
  if (!isMap(fieldsNode)) return null;
  const widgetNode = fieldsNode.get("widget", true);
  if (!widgetNode) return null;
  const scratch = new Document();
  scratch.contents = scratch.createNode({});
  scratch.set("widget", widgetNode);
  return scratch.toString().trimEnd();
}

export function findGroupServicesSeq(servicesDoc, groupName) {
  const topSeq = servicesDoc.contents;
  if (!isSeq(topSeq)) return null;
  for (const groupMap of topSeq.items) {
    for (const groupPair of groupMap.items) {
      if (groupPair.key.value === groupName) {
        return groupPair.value;
      }
    }
  }
  return null;
}

// Like findServiceFieldsNode, but scoped to one named group - use this when
// the caller already knows which group a service lives in, to avoid
// matching a same-named service in a different group.
export function findServiceFieldsNodeInGroup(servicesDoc, groupName, serviceName) {
  const servicesSeq = findGroupServicesSeq(servicesDoc, groupName);
  if (!isSeq(servicesSeq)) return null;
  for (const serviceMapWrapper of servicesSeq.items) {
    for (const servicePair of serviceMapWrapper.items) {
      if (servicePair.key.value === serviceName) {
        return servicePair.value;
      }
    }
  }
  return null;
}

export function listServiceNames(servicesDoc) {
  const names = [];
  const topSeq = servicesDoc.contents;
  if (!isSeq(topSeq)) return names;
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
  if (!isSeq(topSeq)) return names;
  for (const groupMap of topSeq.items) {
    for (const groupPair of groupMap.items) {
      names.push(groupPair.key.value);
    }
  }
  return names;
}

// Ensures doc.contents is a top-level Seq, ready to .items.push(...) onto.
// A brand-new or fully-emptied services.yaml/widgets.yaml (nothing left but
// header comments, or a genuinely empty file) parses to a Scalar or null
// contents node rather than a Seq - installing into one of those is exactly
// how a user reaches this, since it's the state of a config file before its
// first-ever install. Replacing contents outright would silently drop any
// header comment attached to that placeholder node, so it's carried over
// onto the new Seq first.
export function ensureTopSeq(doc) {
  if (!isSeq(doc.contents)) {
    const oldContents = doc.contents;
    const newSeq = doc.createNode([]);
    if (oldContents) {
      const carried = [oldContents.comment, oldContents.commentBefore].filter(Boolean);
      if (carried.length > 0) newSeq.commentBefore = carried.join("\n");
    }
    doc.contents = newSeq;
  }
  return doc.contents;
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
  assertStringifiable(widgetNode);
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
  const listItemNode = doc.contents.items[0];
  assertStringifiable(listItemNode);
  return listItemNode;
}

// Returns { type, serviceName } for every service, across every group, that
// currently has a widget: block.
export function listInstalledServiceWidgets(servicesDoc) {
  const results = [];
  const topSeq = servicesDoc.contents;
  if (!isSeq(topSeq)) return results;
  for (const groupMap of topSeq.items) {
    for (const groupPair of groupMap.items) {
      const servicesSeq = groupPair.value;
      for (const serviceMapWrapper of servicesSeq.items) {
        for (const servicePair of serviceMapWrapper.items) {
          const fieldsNode = servicePair.value;
          const widgetNode = fieldsNode.get("widget", true);
          if (isMap(widgetNode)) {
            const type = widgetNode.get("type");
            if (typeof type === "string") {
              results.push({ type, serviceName: servicePair.key.value });
            }
          }
        }
      }
    }
  }
  return results;
}

// Returns { slug, index, fingerprint } for every top-level widgets.yaml
// entry - slug is the entry's single key, index is its position in the
// top-level Seq, fingerprint is a content hash of that entry (JSON of its
// parsed value). Duplicate slugs (e.g. two "resources" blocks) each get
// their own entry - the fingerprint is what lets a removal request detect
// "the entry that's now at this index isn't the one I meant to remove"
// even when the slug alone can't tell the difference.
export function listInstalledInfoWidgets(widgetsDoc) {
  const results = [];
  const topSeq = widgetsDoc.contents;
  if (!isSeq(topSeq)) return results;
  topSeq.items.forEach((itemMap, index) => {
    if (isMap(itemMap) && itemMap.items.length > 0) {
      results.push({
        slug: itemMap.items[0].key.value,
        index,
        fingerprint: JSON.stringify(itemMap.toJSON()),
      });
    }
  });
  return results;
}
