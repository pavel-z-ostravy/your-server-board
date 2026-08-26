import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { pollBackupTask } from "utils/proxmox/backups";

const logger = createLogger("backupsStatusService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_UPID = /^UPID:[\w.:-]+$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, upid } = req.query;
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof upid !== "string" || !VALID_UPID.test(upid)) {
    return res.status(400).json({ error: "Invalid or missing upid parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    const result = await pollBackupTask(pveConfig, node, upid);
    return res.status(200).json(result);
  } catch (error) {
    logger.error("Failed to poll backup task %s on %s:", upid, node, error);
    return res.status(500).json({ error: "Failed to poll backup task" });
  }
}
