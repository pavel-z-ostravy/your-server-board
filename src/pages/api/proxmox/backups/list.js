import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { listBackupsForVm } from "utils/proxmox/backups";

const logger = createLogger("backupsListService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_VMID = /^\d+$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, vmid } = req.query;
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof vmid !== "string" || !VALID_VMID.test(vmid)) {
    return res.status(400).json({ error: "Invalid or missing vmid parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    const backups = await listBackupsForVm(pveConfig, node, vmid);
    return res.status(200).json({ backups });
  } catch (error) {
    logger.error("Failed to list backups for %s/%s:", node, vmid, error);
    return res.status(500).json({ error: "Failed to list backups" });
  }
}
