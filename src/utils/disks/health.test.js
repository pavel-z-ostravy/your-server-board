import { describe, expect, it } from "vitest";

import { computeDiskHealth } from "./health";

const ataHealthy = {
  device: { protocol: "ATA" },
  smart_status: { passed: true },
  temperature: { current: 40 },
  ata_smart_attributes: { table: [{ id: 5, raw: { value: 0 } }] },
};

const nvmeHealthy = {
  device: { protocol: "NVMe" },
  smart_status: { passed: true },
  temperature: { current: 33, op_limit_max: 90, critical_limit_max: 95 },
  nvme_smart_health_information_log: { percentage_used: 0, media_errors: 0 },
};

describe("computeDiskHealth", () => {
  it("reports ok for a healthy ATA drive", () => {
    expect(computeDiskHealth(ataHealthy)).toEqual({
      status: "ok",
      temperature: 40,
      smartPassed: true,
      reallocatedSectors: 0,
      wearPercentage: null,
      mediaErrors: null,
    });
  });

  it("reports ok for a healthy NVMe drive", () => {
    expect(computeDiskHealth(nvmeHealthy)).toEqual({
      status: "ok",
      temperature: 33,
      smartPassed: true,
      reallocatedSectors: null,
      wearPercentage: 0,
      mediaErrors: 0,
    });
  });

  it("reports critical when smart_status.passed is false, overriding everything else", () => {
    const data = { ...ataHealthy, smart_status: { passed: false } };
    expect(computeDiskHealth(data).status).toBe("critical");
  });

  it("reports warn for any reallocated sector on an ATA drive", () => {
    const data = { ...ataHealthy, ata_smart_attributes: { table: [{ id: 5, raw: { value: 1 } }] } };
    expect(computeDiskHealth(data).status).toBe("warn");
    expect(computeDiskHealth(data).reallocatedSectors).toBe(1);
  });

  it("reports warn using the device's own temperature threshold when present (NVMe)", () => {
    const data = { ...nvmeHealthy, temperature: { current: 91, op_limit_max: 90, critical_limit_max: 95 } };
    expect(computeDiskHealth(data).status).toBe("warn");
  });

  it("reports critical using the device's own critical temperature threshold when present (NVMe)", () => {
    const data = { ...nvmeHealthy, temperature: { current: 96, op_limit_max: 90, critical_limit_max: 95 } };
    expect(computeDiskHealth(data).status).toBe("critical");
  });

  it("falls back to generic temperature thresholds when the device reports none (ATA)", () => {
    expect(computeDiskHealth({ ...ataHealthy, temperature: { current: 55 } }).status).toBe("warn");
    expect(computeDiskHealth({ ...ataHealthy, temperature: { current: 65 } }).status).toBe("critical");
    expect(computeDiskHealth({ ...ataHealthy, temperature: { current: 45 } }).status).toBe("ok");
  });

  it("reports warn for NVMe wear at or above 80%, critical above 95%", () => {
    expect(
      computeDiskHealth({ ...nvmeHealthy, nvme_smart_health_information_log: { percentage_used: 80, media_errors: 0 } })
        .status,
    ).toBe("warn");
    expect(
      computeDiskHealth({ ...nvmeHealthy, nvme_smart_health_information_log: { percentage_used: 96, media_errors: 0 } })
        .status,
    ).toBe("critical");
  });

  it("reports warn for any NVMe media error regardless of wear percentage", () => {
    const data = { ...nvmeHealthy, nvme_smart_health_information_log: { percentage_used: 0, media_errors: 1 } };
    expect(computeDiskHealth(data).status).toBe("warn");
    expect(computeDiskHealth(data).mediaErrors).toBe(1);
  });

  it("takes the worst of multiple simultaneous issues", () => {
    const data = {
      ...nvmeHealthy,
      smart_status: { passed: false },
      nvme_smart_health_information_log: { percentage_used: 85, media_errors: 0 },
    };
    expect(computeDiskHealth(data).status).toBe("critical");
  });
});
