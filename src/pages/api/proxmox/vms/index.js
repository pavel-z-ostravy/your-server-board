import { getPveConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { extractMacFromLxcNet0, extractMacFromQemuNet0, findIPv4ByMac } from "utils/proxmox/vmNetwork";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("proxmoxVmsService");

async function pveGet(pveConfig, path) {
  const url = `${pveConfig.url}/api2/json/${path}`;
  const headers = { Authorization: `PVEAPIToken=${pveConfig.token}=${pveConfig.secret}` };
  const [status, , data] = await httpProxy(url, { method: "GET", headers });
  const parsed = JSON.parse(Buffer.from(data).toString());
  if (status !== 200) {
    throw new Error(`Proxmox API returned ${status} for ${path}`);
  }
  return parsed.data;
}

function basicStatsFromResource(resource) {
  return {
    vmid: resource.vmid,
    node: resource.node,
    type: resource.type,
    name: resource.name,
    status: resource.status,
    cpuUsedCores: resource.cpu * resource.maxcpu,
    cpuTotalCores: resource.maxcpu,
    memUsedBytes: resource.mem,
    memTotalBytes: resource.maxmem,
    diskUsedBytes: resource.type === "lxc" ? resource.disk : null,
    diskTotalBytes: resource.maxdisk,
    uptimeSeconds: resource.uptime,
  };
}

async function enrichLxc(pveConfig, resource) {
  const config = await pveGet(pveConfig, `nodes/${resource.node}/lxc/${resource.vmid}/config`);
  const mac = extractMacFromLxcNet0(config?.net0);
  const interfaces = await pveGet(pveConfig, `nodes/${resource.node}/lxc/${resource.vmid}/interfaces`);
  return { macAddress: mac, ipAddress: findIPv4ByMac(interfaces, mac, "inet"), osName: config?.ostype ?? null };
}

async function enrichQemu(pveConfig, resource) {
  const config = await pveGet(pveConfig, `nodes/${resource.node}/qemu/${resource.vmid}/config`);
  const mac = extractMacFromQemuNet0(config?.net0);

  // The guest agent is independently optional — a VM with agent: undefined
  // (or one where it's configured but not actually running inside the
  // guest) must still return its MAC from config, just with IP/OS as null,
  // rather than failing this VM's entire enrichment.
  let ipAddress = null;
  let osName = null;
  if (config?.agent === "1" || config?.agent?.startsWith?.("1,")) {
    try {
      const agentInterfaces = await pveGet(
        pveConfig,
        `nodes/${resource.node}/qemu/${resource.vmid}/agent/network-get-interfaces`,
      );
      ipAddress = findIPv4ByMac(agentInterfaces?.result, mac, "ipv4");
    } catch (error) {
      logger.error("QEMU guest-agent network lookup failed for vmid %s:", resource.vmid, error);
    }
    try {
      const osinfo = await pveGet(pveConfig, `nodes/${resource.node}/qemu/${resource.vmid}/agent/get-osinfo`);
      osName = osinfo?.result?.["pretty-name"] ?? null;
    } catch (error) {
      logger.error("QEMU guest-agent osinfo lookup failed for vmid %s:", resource.vmid, error);
    }
  }

  return { macAddress: mac, ipAddress, osName };
}

async function buildEntry(pveConfig, resource) {
  const base = basicStatsFromResource(resource);
  try {
    const enrichment =
      resource.type === "lxc" ? await enrichLxc(pveConfig, resource) : await enrichQemu(pveConfig, resource);
    return { ...base, ...enrichment };
  } catch (error) {
    logger.error("Enrichment failed for %s/%s:", resource.type, resource.vmid, error);
    return { ...base, macAddress: null, ipAddress: null, osName: null };
  }
}

export default async function handler(req, res) {
  const pveConfig = getPveConfig();

  if (!pveConfig) {
    return res.status(500).json({ error: "Proxmox server configuration not found" });
  }

  let resources;
  try {
    resources = await pveGet(pveConfig, "cluster/resources?type=vm");
  } catch (error) {
    logger.error("Failed to fetch Proxmox cluster resources:", error);
    return res.status(500).json({ error: "Failed to fetch Proxmox cluster resources" });
  }

  const guests = (resources ?? []).filter((resource) => resource.template === 0);
  const entries = await Promise.all(guests.map((resource) => buildEntry(pveConfig, resource)));

  return res.status(200).json(entries);
}
