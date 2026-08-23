import { readConfigDocument, writeConfigDocument } from "utils/config/configWriter";
import { findServiceFieldsNode, findServiceFieldsNodeInGroup } from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetUninstall");

function uninstallService(req, res) {
  const { serviceName, groupName } = req.body ?? {};
  if (typeof serviceName !== "string" || !serviceName.trim()) {
    return res.status(400).json({ error: "serviceName is required" });
  }

  const doc = readConfigDocument("services.yaml");
  const groupScoped =
    typeof groupName === "string" && groupName.trim()
      ? findServiceFieldsNodeInGroup(doc, groupName, serviceName)
      : null;
  const fieldsNode = groupScoped ?? findServiceFieldsNode(doc, serviceName);
  if (!fieldsNode) {
    return res.status(404).json({ error: `Service '${serviceName}' not found` });
  }
  if (!fieldsNode.has("widget")) {
    return res.status(404).json({ error: `Service '${serviceName}' has no widget to remove` });
  }

  fieldsNode.delete("widget");
  const backupFile = writeConfigDocument("services.yaml", doc);
  return res.status(200).json({ success: true, backupFile });
}

function uninstallInfo(req, res) {
  const { slug, index, fingerprint } = req.body ?? {};
  if (
    typeof slug !== "string" ||
    !slug.trim() ||
    typeof index !== "number" ||
    index < 0 ||
    typeof fingerprint !== "string" ||
    !fingerprint
  ) {
    return res.status(400).json({ error: "slug, index, and fingerprint are required" });
  }

  const doc = readConfigDocument("widgets.yaml");
  const topSeq = doc.contents;
  const itemMap = topSeq?.items?.[index];
  if (!itemMap) {
    return res.status(404).json({ error: `No widgets.yaml entry at index ${index}` });
  }
  const actualSlug = itemMap.items?.[0]?.key?.value;
  const actualFingerprint = JSON.stringify(itemMap.toJSON());
  if (actualSlug !== slug || actualFingerprint !== fingerprint) {
    return res.status(409).json({ error: "widgets.yaml has changed since this list was loaded - please refresh" });
  }

  topSeq.items.splice(index, 1);
  const backupFile = writeConfigDocument("widgets.yaml", doc);
  return res.status(200).json({ success: true, backupFile });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { category } = req.body ?? {};

  try {
    if (category === "service") {
      return uninstallService(req, res);
    }
    if (category === "info") {
      return uninstallInfo(req, res);
    }
    return res.status(400).json({ error: "category must be 'service' or 'info'" });
  } catch (e) {
    logger.error("Widget uninstall failed:", e);
    return res.status(500).json({ error: "Failed to write configuration" });
  }
}
