import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { parsePveVersion, pickPrimaryIpAddress } from "utils/proxmox/nodeStatus";
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
    ipAddress: null,
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

  // Fetched independently via allSettled - a failure in either call must
  // only degrade its own field(s), never the other's, matching this route's
  // established graceful-degradation contract (and this codebase's existing
  // Promise.allSettled precedent in pages/api/proxmox/vm-detail/index.js).
  const [statusResult, networkResult] = await Promise.allSettled([
    pveGet(pveConfig, `nodes/${node.node}/status`),
    pveGet(pveConfig, `nodes/${node.node}/network`),
  ]);

  let pveVersion = null;
  let loadAvg = null;
  if (statusResult.status === "fulfilled") {
    pveVersion = parsePveVersion(statusResult.value?.pveversion);
    loadAvg = Array.isArray(statusResult.value?.loadavg) ? statusResult.value.loadavg.map(Number) : null;
  } else {
    logger.error("Failed to fetch Proxmox node version/load detail:", statusResult.reason);
  }

  let ipAddress = null;
  if (networkResult.status === "fulfilled") {
    ipAddress = pickPrimaryIpAddress(networkResult.value);
  } else {
    logger.error("Failed to fetch Proxmox node network detail:", networkResult.reason);
  }

  return res.status(200).json({ ...base, pveVersion, loadAvg, ipAddress });
}
