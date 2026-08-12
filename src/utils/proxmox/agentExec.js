import createLogger from "utils/logger";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxAgentExec");

export const AGENT_EXEC_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 300;

// Both command arrays are fixed JS constants. Nothing derived from a
// request parameter is ever appended to either array — node/vmid only
// select which guest's agent receives one of these two exact operations.
// This is the QEMU-side equivalent of proxmox-smart-helper.sh's forced
// command pattern: the "server" enforcing the fixed shape is this file.
const PS_COMMAND = ["ps", "-eo", "pid=,pcpu=,pmem=,comm=", "--sort=-pcpu"];
const OS_PROBE_COMMAND = [
  "sh",
  "-c",
  "cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)",
];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pveAuthedGet(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "GET", headers });
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return JSON.parse(Buffer.from(data).toString()).data;
}

async function launchExec(pveConfig, node, vmid, command) {
  const url = `${pveConfig.url}/api2/json/nodes/${node}/qemu/${vmid}/agent/exec`;
  const headers = {
    Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // encodeURI (not encodeURIComponent) is used deliberately: it escapes whitespace and
  // other characters that would otherwise break form-urlencoded field boundaries, while
  // leaving "=" and "," untouched. None of the two fixed command arrays above contain a
  // literal "&", "+", or "#" (the characters encodeURI does NOT escape but that would be
  // unsafe here), so this is a safe, simpler encoding for these known, constant values.
  const body = command.map((part) => `command=${encodeURI(part)}`).join("&");
  const [status, , data] = await httpProxy(url, { method: "POST", headers, body });
  if (status !== 200) {
    throw new Error(`Failed to launch guest-agent exec on qemu/${vmid}: status ${status}`);
  }
  const parsed = JSON.parse(Buffer.from(data).toString());
  return parsed.data.pid;
}

async function pollExecStatus(pveConfig, node, vmid, pid) {
  const deadline = Date.now() + AGENT_EXEC_TIMEOUT_MS;
  for (;;) {
    const status = await pveAuthedGet(pveConfig, `nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`);
    if (status.exited === 1) {
      return status["out-data"] ?? "";
    }
    if (Date.now() >= deadline) {
      throw new Error(`Guest-agent exec on qemu/${vmid} (pid ${pid}) timed out after ${AGENT_EXEC_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runAgentCommand(pveConfig, node, vmid, command) {
  const pid = await launchExec(pveConfig, node, vmid, command);
  return pollExecStatus(pveConfig, node, vmid, pid);
}

export async function getQemuProcesses(pveConfig, node, vmid) {
  try {
    return await runAgentCommand(pveConfig, node, vmid, PS_COMMAND);
  } catch (error) {
    logger.error("Guest-agent process listing failed for qemu/%s:", vmid, error);
    throw error;
  }
}

export async function getQemuOsProbe(pveConfig, node, vmid) {
  try {
    return await runAgentCommand(pveConfig, node, vmid, OS_PROBE_COMMAND);
  } catch (error) {
    logger.error("Guest-agent OS probe failed for qemu/%s:", vmid, error);
    throw error;
  }
}
