import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { streamConfigBackup } from "utils/ssh/backupClient";

const logger = createLogger("backupsConfigDownloadService");

// This route streams a response body manually instead of ever calling
// res.json()/res.end() synchronously - externalResolver tells Next.js not
// to warn that the API resolved without sending a response in the usual way.
export const config = {
  api: {
    externalResolver: true,
    responseLimit: false,
  },
};

function timestampedFilename() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `pve-config-backup-${iso}.tar.gz`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sshConfig = getSmartConfig();
  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let stream;
  let conn;
  try {
    ({ stream, conn } = await streamConfigBackup(sshConfig));
  } catch (error) {
    logger.error("Failed to open Proxmox config backup stream:", error);
    return res.status(500).json({ error: "Failed to start download" });
  }

  res.setHeader("Content-Disposition", `attachment; filename="${timestampedFilename()}"`);
  res.setHeader("Content-Type", "application/gzip");

  // Headers/body are already streaming by the time we know whether the
  // remote command actually succeeded, so the HTTP response can't be changed
  // here on failure - the best we can do is make a non-zero exit visible in
  // the server logs instead of the browser silently saving a 0-byte file.
  let stderrOutput = "";
  stream.stderr.on("data", (data) => {
    stderrOutput += data.toString();
  });

  stream.on("error", (error) => {
    logger.error("Proxmox config backup stream failed:", error);
    conn.end();
    res.end();
  });
  stream.on("close", (code) => {
    if (code !== 0) {
      logger.error("Proxmox config backup command exited with code %d: %s", code, stderrOutput.trim());
    }
    conn.end();
  });
  req.on("close", () => {
    conn.end();
  });

  return stream.pipe(res);
}
