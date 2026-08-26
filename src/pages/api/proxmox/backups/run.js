import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { startBackup } from "utils/proxmox/backups";

const logger = createLogger("backupsRunService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_VMID = /^\d+$/;
const VALID_STORAGE = /^[A-Za-z0-9_-]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, vmid, storage } = req.body ?? {};
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof vmid !== "string" || !VALID_VMID.test(vmid)) {
    return res.status(400).json({ error: "Invalid or missing vmid parameter" });
  }
  if (typeof storage !== "string" || !VALID_STORAGE.test(storage)) {
    return res.status(400).json({ error: "Invalid or missing storage parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    const { upid } = await startBackup(pveConfig, node, vmid, storage);
    return res.status(200).json({ upid });
  } catch (error) {
    logger.error("Failed to start backup for %s/%s on %s:", node, vmid, storage, error);
    return res.status(500).json({ error: "Failed to start backup" });
  }
}
