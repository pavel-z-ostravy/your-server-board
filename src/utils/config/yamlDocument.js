import { Document, isSeq, parseDocument } from "yaml";

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
