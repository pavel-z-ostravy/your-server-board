import { readConfigDocument } from "utils/config/configWriter";
import { listInstalledInfoWidgets, listInstalledServiceWidgets } from "utils/config/yamlDocument";
import createLogger from "utils/logger";

const logger = createLogger("widgetsCatalogInstalled");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const servicesDoc = readConfigDocument("services.yaml");
    const widgetsDoc = readConfigDocument("widgets.yaml");

    const services = {};
    for (const { type, serviceName } of listInstalledServiceWidgets(servicesDoc)) {
      (services[type] ??= []).push(serviceName);
    }

    const info = {};
    for (const { slug, index } of listInstalledInfoWidgets(widgetsDoc)) {
      (info[slug] ??= []).push(index);
    }

    return res.status(200).json({ services, info });
  } catch (e) {
    logger.error("Failed to read installed widgets:", e);
    return res.status(500).json({ error: "Failed to read configuration" });
  }
}
