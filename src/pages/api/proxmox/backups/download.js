import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { streamBackupFile } from "utils/ssh/backupClient";

const logger = createLogger("backupsDownloadService");
const VALID_VOLID =
  /^[A-Za-z0-9_-]+:backup\/vzdump-(qemu|lxc)-\d+-\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.(vma(\.(gz|zst))?|tar(\.(gz|zst))?)$/;

// This route streams a response body manually instead of ever calling
// res.json()/res.end() synchronously - externalResolver tells Next.js not
// to warn that the API resolved without sending a response in the usual way.
export const config = {
  api: {
    externalResolver: true,
  },
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { volid } = req.query;
  if (typeof volid !== "string" || !VALID_VOLID.test(volid)) {
    return res.status(400).json({ error: "Invalid or missing volid parameter" });
  }

  const sshConfig = getSmartConfig();
  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let stream;
  let conn;
  try {
    ({ stream, conn } = await streamBackupFile(sshConfig, volid));
  } catch (error) {
    logger.error("Failed to open backup download stream for %s:", volid, error);
    return res.status(500).json({ error: "Failed to start download" });
  }

  const filename = volid.split("/").pop();
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/octet-stream");

  stream.on("error", (error) => {
    logger.error("Backup download stream failed for %s:", volid, error);
    res.end();
  });
  stream.on("close", () => {
    conn.end();
  });
  req.on("close", () => {
    conn.end();
  });

  return stream.pipe(res);
}
