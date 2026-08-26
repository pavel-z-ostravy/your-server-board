import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { listBackupStorages } from "utils/proxmox/backups";

const logger = createLogger("backupsStoragesService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node } = req.query;
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    const storages = await listBackupStorages(pveConfig, node);
    return res.status(200).json({ storages });
  } catch (error) {
    logger.error("Failed to list backup storages for %s:", node, error);
    return res.status(500).json({ error: "Failed to list backup storages" });
  }
}
