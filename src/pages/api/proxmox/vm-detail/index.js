import { getPveConfig, getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { getQemuOsProbe, getQemuProcesses } from "utils/proxmox/agentExec";
import { parseOsProbe, parseTopProcesses } from "utils/proxmox/processDetail";
import { getLxcOsProbe, getLxcProcesses } from "utils/ssh/lxcClient";

const logger = createLogger("proxmoxVmDetailService");

const VALID_TYPE = new Set(["qemu", "lxc"]);
// Must start AND end with an alphanumeric character. This structurally
// excludes "." and ".." (a path-traversal token would need to start or end
// with "."), while still accepting real Proxmox node names such as
// "proxmox", "pve-node1", or FQDN-style "node.example.com".
const VALID_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VALID_VMID = /^\d+$/;

async function fetchLxcDetail(sshConfig, vmid) {
  const [processesResult, osProbeResult] = await Promise.allSettled([
    getLxcProcesses(sshConfig, vmid),
    getLxcOsProbe(sshConfig, vmid),
  ]);
  return { processesResult, osProbeResult };
}

async function fetchQemuDetail(pveConfig, node, vmid) {
  const [processesResult, osProbeResult] = await Promise.allSettled([
    getQemuProcesses(pveConfig, node, vmid),
    getQemuOsProbe(pveConfig, node, vmid),
  ]);
  return { processesResult, osProbeResult };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { type, node, vmid } = req.query;

  if (typeof type !== "string" || !VALID_TYPE.has(type)) {
    return res.status(400).json({ error: "Invalid or missing type parameter" });
  }
  if (typeof node !== "string" || !VALID_NODE.test(node)) {
    return res.status(400).json({ error: "Invalid or missing node parameter" });
  }
  if (typeof vmid !== "string" || !VALID_VMID.test(vmid)) {
    return res.status(400).json({ error: "Invalid or missing vmid parameter" });
  }

  let processesResult;
  let osProbeResult;

  if (type === "lxc") {
    const sshConfig = getSmartConfig();
    if (!sshConfig) {
      return res.status(500).json({ error: "SMART SSH configuration not found" });
    }
    ({ processesResult, osProbeResult } = await fetchLxcDetail(sshConfig, vmid));
  } else {
    const pveConfig = getPveConfig();
    if (!pveConfig) {
      return res.status(500).json({ error: "Proxmox server configuration not found" });
    }
    ({ processesResult, osProbeResult } = await fetchQemuDetail(pveConfig, node, vmid));
  }

  let processes = [];
  if (processesResult.status === "fulfilled") {
    processes = parseTopProcesses(processesResult.value);
  } else {
    logger.error("Process listing failed for %s/%s:", type, vmid, processesResult.reason);
  }

  let osReleaseName = null;
  let lastUpdate = null;
  if (osProbeResult.status === "fulfilled") {
    ({ prettyName: osReleaseName, lastUpdate } = parseOsProbe(osProbeResult.value));
  } else {
    logger.error("OS probe failed for %s/%s:", type, vmid, osProbeResult.reason);
  }

  return res.status(200).json({ processes, osReleaseName, lastUpdate });
}
