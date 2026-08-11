const DEFAULT_TEMP_WARN_C = 50;
const DEFAULT_TEMP_CRITICAL_C = 60;
const NVME_WEAR_WARN_PERCENT = 80;
const NVME_WEAR_CRITICAL_PERCENT = 95;
const REALLOCATED_SECTOR_ATTRIBUTE_ID = 5;

const SEVERITY_ORDER = ["ok", "warn", "critical"];

export function computeDiskHealth(smartData) {
  const smartPassed = smartData?.smart_status?.passed ?? null;
  const temperature = smartData?.temperature?.current ?? null;
  const tempWarnThreshold = smartData?.temperature?.op_limit_max ?? DEFAULT_TEMP_WARN_C;
  const tempCriticalThreshold = smartData?.temperature?.critical_limit_max ?? DEFAULT_TEMP_CRITICAL_C;
  const isNvme = smartData?.device?.protocol === "NVMe";

  let reallocatedSectors = null;
  if (!isNvme) {
    const attribute = smartData?.ata_smart_attributes?.table?.find(
      (entry) => entry.id === REALLOCATED_SECTOR_ATTRIBUTE_ID,
    );
    reallocatedSectors = attribute?.raw?.value ?? null;
  }

  let wearPercentage = null;
  let mediaErrors = null;
  if (isNvme) {
    wearPercentage = smartData?.nvme_smart_health_information_log?.percentage_used ?? null;
    mediaErrors = smartData?.nvme_smart_health_information_log?.media_errors ?? null;
  }

  let status = "ok";
  const escalate = (level) => {
    if (SEVERITY_ORDER.indexOf(level) > SEVERITY_ORDER.indexOf(status)) {
      status = level;
    }
  };

  if (smartPassed === false) escalate("critical");

  if (temperature !== null) {
    if (temperature > tempCriticalThreshold) escalate("critical");
    else if (temperature > tempWarnThreshold) escalate("warn");
  }

  if (reallocatedSectors !== null && reallocatedSectors > 0) escalate("warn");

  if (wearPercentage !== null) {
    if (wearPercentage > NVME_WEAR_CRITICAL_PERCENT) escalate("critical");
    else if (wearPercentage >= NVME_WEAR_WARN_PERCENT) escalate("warn");
  }

  if (mediaErrors !== null && mediaErrors > 0) escalate("warn");

  return { status, temperature, smartPassed, reallocatedSectors, wearPercentage, mediaErrors };
}
