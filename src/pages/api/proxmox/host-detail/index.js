import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { parseTopProcesses } from "utils/proxmox/processDetail";
import { getHostProcesses } from "utils/ssh/hostClient";

const logger = createLogger("proxmoxHostDetailService");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sshConfig = getSmartConfig();
  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let processes = [];
  try {
    const stdout = await getHostProcesses(sshConfig);
    processes = parseTopProcesses(stdout);
  } catch (error) {
    logger.error("Host process listing failed:", error);
  }

  return res.status(200).json({ processes });
}
