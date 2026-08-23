import { readConfigDocument } from "utils/config/configWriter";
import { getServiceWidgetYaml } from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetsCatalogServiceWidget");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { name } = req.query;
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const doc = readConfigDocument("services.yaml");
    return res.status(200).json({ yamlSnippet: getServiceWidgetYaml(doc, name) });
  } catch (e) {
    logger.error("Failed to read existing widget for service '%s':", name, e);
    return res.status(500).json({ error: "Failed to read services configuration" });
  }
}
