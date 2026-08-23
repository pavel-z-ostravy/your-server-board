import { readConfigDocument } from "utils/config/configWriter";
import { listGroupNames, listServiceNames } from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetsCatalogServices");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const doc = readConfigDocument("services.yaml");
    return res.status(200).json({
      groups: listGroupNames(doc),
      services: listServiceNames(doc),
    });
  } catch (e) {
    logger.error("Failed to read services.yaml:", e);
    return res.status(500).json({ error: "Failed to read services configuration" });
  }
}
