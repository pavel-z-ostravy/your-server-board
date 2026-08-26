import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { deleteBackup } from "utils/proxmox/backups";

const logger = createLogger("backupsDeleteService");
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_VOLID =
  /^[A-Za-z0-9_-]+:backup\/vzdump-(qemu|lxc)-\d+-\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.(vma(\.(gz|zst))?|tar(\.(gz|zst))?)$/;

export default async function handler(req, res) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { node, volid } = req.query;
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof volid !== "string" || !VALID_VOLID.test(volid)) {
    return res.status(400).json({ error: "Invalid or missing volid parameter" });
  }

  const pveConfig = getPveConfig();
  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  try {
    await deleteBackup(pveConfig, node, volid);
    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error("Failed to delete backup %s on %s:", volid, node, error);
    return res.status(500).json({ error: "Failed to delete backup" });
  }
}
