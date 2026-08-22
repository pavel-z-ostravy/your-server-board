import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { parsePveVersion } from "utils/proxmox/nodeStatus";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxHostService");

async function pveGet(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "GET", headers });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

// Returned when the node is offline, or GET /nodes returned no entries at
// all (shouldn't happen for a real single-node deployment, but the field
// shape must still be well-formed for the client either way).
function offlineEntry() {
  return {
    status: "offline",
    cpuUsedCores: null,
    cpuTotalCores: null,
    memUsedBytes: null,
    memTotalBytes: null,
    diskUsedBytes: null,
    diskTotalBytes: null,
    uptimeSeconds: null,
    pveVersion: null,
    loadAvg: null,
  };
}

export default async function handler(req, res) {
  const pveConfig = getPveConfig();

  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  let nodes;
  try {
    nodes = await pveGet(pveConfig, "nodes");
  } catch (error) {
    logger.error("Failed to fetch Proxmox nodes:", error);
    return res.status(500).json({ error: "Failed to fetch Proxmox node status" });
  }

  const node = nodes?.[0];
  if (!node || node.status !== "online") {
    return res.status(200).json(offlineEntry());
  }

  // GET /nodes already carries this deployment's cpu/mem/disk/uptime numbers
  // for its one node - no need to duplicate them from /nodes/{node}/status's
  // memory/rootfs objects below, which describe the exact same values.
  const base = {
    status: node.status,
    cpuUsedCores: node.cpu * node.maxcpu,
    cpuTotalCores: node.maxcpu,
    memUsedBytes: node.mem,
    memTotalBytes: node.maxmem,
    diskUsedBytes: node.disk,
    diskTotalBytes: node.maxdisk,
    uptimeSeconds: node.uptime,
  };

  try {
    const nodeStatus = await pveGet(pveConfig, `nodes/${node.node}/status`);
    return res.status(200).json({
      ...base,
      pveVersion: parsePveVersion(nodeStatus?.pveversion),
      loadAvg: Array.isArray(nodeStatus?.loadavg) ? nodeStatus.loadavg.map(Number) : null,
    });
  } catch (error) {
    logger.error("Failed to fetch Proxmox node version/load detail:", error);
    return res.status(200).json({ ...base, pveVersion: null, loadAvg: null });
  }
}
