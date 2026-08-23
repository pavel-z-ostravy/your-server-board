import { readConfigDocument, writeConfigDocument } from "utils/config/configWriter";
import {
  findGroupServicesSeq,
  findServiceFieldsNode,
  listServiceNames,
  parseInfoWidgetSnippet,
  parseWidgetFragment,
} from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetInstall");

async function handleInfoInstall(req, res) {
  const { yamlSnippet } = req.body ?? {};

  let itemNode;
  try {
    itemNode = parseInfoWidgetSnippet(yamlSnippet);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const doc = readConfigDocument("widgets.yaml");
  doc.contents.items.push(itemNode);
  const backupFile = writeConfigDocument("widgets.yaml", doc);

  return res.status(200).json({ success: true, backupFile });
}

function attachToExistingService(doc, serviceName, widgetNode, res) {
  const fieldsNode = findServiceFieldsNode(doc, serviceName);
  if (!fieldsNode) {
    return res.status(404).json({ error: `Service '${serviceName}' not found` });
  }
  fieldsNode.set("widget", widgetNode);
  const backupFile = writeConfigDocument("services.yaml", doc);
  return res.status(200).json({ success: true, backupFile });
}

function addNewService(doc, req, widgetNode, res) {
  const { serviceName, groupName, href, description } = req.body;
  if (![serviceName, groupName, href].every((v) => typeof v === "string" && v.trim())) {
    return res.status(400).json({ error: "serviceName, groupName, and href are required" });
  }

  if (listServiceNames(doc).includes(serviceName)) {
    return res.status(409).json({ error: `Service '${serviceName}' already exists` });
  }

  const fields = { href };
  if (description && description.trim()) fields.description = description;
  const newServiceNode = doc.createNode({ [serviceName]: fields });
  newServiceNode.items[0].value.set("widget", widgetNode);

  let servicesSeq = findGroupServicesSeq(doc, groupName);
  if (!servicesSeq) {
    const newGroupNode = doc.createNode({ [groupName]: [] });
    doc.contents.items.push(newGroupNode);
    servicesSeq = newGroupNode.items[0].value;
  }
  servicesSeq.items.push(newServiceNode);

  const backupFile = writeConfigDocument("services.yaml", doc);
  return res.status(200).json({ success: true, backupFile });
}

async function handleServiceInstall(req, res) {
  const { mode } = req.body ?? {};

  let widgetNode;
  try {
    widgetNode = parseWidgetFragment(req.body?.yamlSnippet);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const doc = readConfigDocument("services.yaml");

  if (mode === "attach") {
    const { serviceName } = req.body;
    if (typeof serviceName !== "string" || !serviceName.trim()) {
      return res.status(400).json({ error: "serviceName is required" });
    }
    return attachToExistingService(doc, serviceName, widgetNode, res);
  }

  if (mode === "new") {
    return addNewService(doc, req, widgetNode, res);
  }

  return res.status(400).json({ error: "mode must be 'attach' or 'new'" });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { category } = req.body ?? {};

  try {
    if (category === "info") {
      return await handleInfoInstall(req, res);
    }
    if (category === "service") {
      return await handleServiceInstall(req, res);
    }
    return res.status(400).json({ error: "category must be 'info' or 'service'" });
  } catch (e) {
    logger.error("Widget install failed:", e);
    return res.status(500).json({ error: "Failed to write configuration" });
  }
}
