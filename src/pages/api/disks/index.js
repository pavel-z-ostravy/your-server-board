import { getSmartConfig } from "utils/config/proxmox";
import createLogger from "utils/logger";
import { computeDiskHealth } from "utils/disks/health";
import { getSmartData, listBlockDevices } from "utils/ssh/smartClient";

const logger = createLogger("disksApi");

async function buildDiskEntry(sshConfig, device) {
  const base = { name: device.name, device: `/dev/${device.name}`, model: device.model, size: device.size };

  try {
    const smartData = await getSmartData(sshConfig, base.device);
    const health = computeDiskHealth(smartData);
    return {
      ...base,
      protocol: smartData?.device?.protocol ?? null,
      temperature: health.temperature,
      smartPassed: health.smartPassed,
      reallocatedSectors: health.reallocatedSectors,
      wearPercentage: health.wearPercentage,
      mediaErrors: health.mediaErrors,
      status: health.status,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      protocol: null,
      temperature: null,
      smartPassed: null,
      reallocatedSectors: null,
      wearPercentage: null,
      mediaErrors: null,
      status: null,
      error: error.message,
    };
  }
}

export default async function handler(req, res) {
  const sshConfig = getSmartConfig();

  if (!sshConfig) {
    return res.status(500).json({ error: "SMART SSH configuration not found" });
  }

  let blockDevices;
  try {
    ({ blockdevices: blockDevices } = await listBlockDevices(sshConfig));
  } catch (error) {
    logger.error("Failed to enumerate block devices:", error);
    return res.status(500).json({ error: "Failed to enumerate block devices" });
  }

  const physicalDisks = (blockDevices ?? []).filter((device) => device.type === "disk");
  const entries = await Promise.all(physicalDisks.map((device) => buildDiskEntry(sshConfig, device)));

  return res.status(200).json(entries);
}
