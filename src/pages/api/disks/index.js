import { getSmartConfig } from "utils/config/proxmox";
import { computeDiskCapacity } from "utils/disks/capacity";
import { computeDiskHealth } from "utils/disks/health";
import createLogger from "utils/logger";
import { getDiskUsage, getLvmReport, getPvMapping, getSmartData, listBlockDevices } from "utils/ssh/smartClient";

const logger = createLogger("disksApi");

// getSmartData (src/utils/ssh/smartClient.js) only accepts device paths matching
// /dev/sd[a-z] or /dev/nvme\d+n\d+. lsblk's type === "disk" also matches devices
// that pattern will always reject — ZFS zvols (zd0, common on Proxmox), virtio
// disks (vda), eMMC/SD (mmcblk0), and any SATA disk past the 26th (sdaa). Filter
// to names the SMART client can actually query so those don't turn into error cards.
const QUERYABLE_DEVICE_NAME = /^(sd[a-z]|nvme\d+n\d+)$/;

// Shared "we have nothing" shape for entries whose SMART query failed, so a
// future added field can't be forgotten in one branch but not the other.
const EMPTY_HEALTH = {
  protocol: null,
  temperature: null,
  smartPassed: null,
  reallocatedSectors: null,
  wearPercentage: null,
  mediaErrors: null,
};

async function buildDiskEntry(sshConfig, device, capacityData) {
  const base = { name: device.name, device: `/dev/${device.name}`, model: device.model, size: device.size };
  // Fallback used if computeDiskCapacity itself throws before assigning below —
  // the catch block still needs a value to spread into its response shape.
  let capacityFields = { usedBytes: null, totalBytes: null };

  try {
    const capacity = capacityData ? computeDiskCapacity(device, capacityData) : null;
    capacityFields = { usedBytes: capacity?.usedBytes ?? null, totalBytes: capacity?.totalBytes ?? null };

    const smartData = await getSmartData(sshConfig, base.device);
    const health = computeDiskHealth(smartData);
    return {
      ...base,
      ...capacityFields,
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
    // This app can run with no authentication at all, so /api/disks may be fully
    // public. Never expose raw error.message here — it can contain internal IPs,
    // paths, or remote stderr (e.g. "SSH command timed out after 15000ms:
    // smartctl -j -a /dev/sda", "connect ECONNREFUSED 10.0.1.9:22"). Log detail
    // server-side and return a fixed generic message instead, matching the
    // listBlockDevices failure path below.
    logger.error("SMART query failed for %s:", base.device, error);
    return {
      ...base,
      ...capacityFields,
      ...EMPTY_HEALTH,
      status: null,
      error: "SMART query failed",
    };
  }
}

// Capacity is an enrichment (see the plan's Global Constraints): if any of
// the three new SSH calls fail — including the real deploy-ordering scenario
// where the app ships before the updated proxmox-smart-helper.sh has been
// re-copied to the host — every disk still returns its existing SMART data
// with usedBytes/totalBytes: null, never a 500 for the whole route.
async function fetchCapacityData(sshConfig) {
  try {
    const [dfRows, lvsRows, pvsRows] = await Promise.all([
      getDiskUsage(sshConfig),
      getLvmReport(sshConfig),
      getPvMapping(sshConfig),
    ]);
    return { dfRows, lvsRows, pvsRows };
  } catch (error) {
    logger.error("Failed to fetch disk capacity data:", error);
    return null;
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

  const capacityData = await fetchCapacityData(sshConfig);

  const physicalDisks = (blockDevices ?? [])
    .filter((device) => device.type === "disk")
    .filter((device) => QUERYABLE_DEVICE_NAME.test(device.name));
  const entries = await Promise.all(physicalDisks.map((device) => buildDiskEntry(sshConfig, device, capacityData)));

  return res.status(200).json(entries);
}
