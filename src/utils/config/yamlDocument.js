import { isSeq, parseDocument } from "yaml";

// services.yaml shape: top-level Seq of single-key group Maps, each group's
// value a Seq of single-key service Maps, each service's value a Map of
// fields (href, description, widget, ...).

export function findServiceFieldsNode(servicesDoc, serviceName) {
  const topSeq = servicesDoc.contents;
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
  return doc.contents.items[0];
}
