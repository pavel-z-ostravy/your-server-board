import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "fake-private-key"),
}));

const LSBLK_COMMAND = "lsblk -J -o NAME,SIZE,TYPE,MODEL,MOUNTPOINT,ROTA";
const SMARTCTL_SDA_COMMAND = "smartctl -j -a /dev/sda";
const DF_COMMAND = "df -B1 --output=source,target,fstype,used,size";
const LVS_COMMAND = "lvs --noheadings --units b --nosuffix -o lv_name,vg_name,lv_attr,data_percent,lv_size";
const PVS_COMMAND = "pvs --noheadings -o pv_name,vg_name";

// Mutable per-test behavior knobs for the fake ssh2 Client below. Reset in
// afterEach so tests can't leak behavior into each other.
let connectBehavior = "ready"; // "ready" | "hang" | "error"
let lsblkBehavior = "success"; // "success" | "nonzero"
let smartBehavior = "success"; // "success" | "nonzero-valid-json" | "nonzero-invalid"
let capacityBehavior = "success"; // "success" | "nonzero" | "empty"

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

class FakeClient extends EventEmitter {
  connect() {
    if (connectBehavior === "hang") {
      // Never emits "ready" or "error" — simulates a stuck SSH connect.
      return;
    }
    if (connectBehavior === "error") {
      setImmediate(() => this.emit("error", new Error("connection refused")));
      return;
    }
    setImmediate(() => this.emit("ready"));
  }

  exec(command, callback) {
    const stream = new FakeStream();
    setImmediate(() => {
      callback(null, stream);

      if (command === LSBLK_COMMAND) {
        if (lsblkBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("lsblk: failure\n"));
          stream.emit("close", 1);
        } else {
          stream.emit("data", Buffer.from('{"blockdevices":[{"name":"sda"}]}'));
          stream.emit("close", 0);
        }
        return;
      }

      if (command === SMARTCTL_SDA_COMMAND) {
        switch (smartBehavior) {
          case "nonzero-valid-json":
            // A drive that IS failing: non-zero exit, but complete JSON.
            stream.emit("data", Buffer.from('{"model_name":"Failing Disk","smartctl":{"exit_status":8}}'));
            stream.emit("close", 8);
            break;
          case "nonzero-invalid":
            // A genuine invocation failure: non-zero exit, unparseable stdout.
            stream.stderr.emit("data", Buffer.from("smartctl: device open failed\n"));
            stream.emit("close", 1);
            break;
          default:
            stream.emit("data", Buffer.from('{"model_name":"Test"}'));
            stream.emit("close", 0);
        }
        return;
      }

      if (command === DF_COMMAND) {
        if (capacityBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("df: failure\n"));
          stream.emit("close", 1);
        } else if (capacityBehavior === "empty") {
          stream.emit("data", Buffer.from("Filesystem Mounted on Type Used 1B-blocks\n"));
          stream.emit("close", 0);
        } else {
          stream.emit(
            "data",
            Buffer.from(
              "Filesystem            Mounted on   Type Used         1B-blocks\n" +
                "/dev/mapper/pve-root  /            ext4 25914707968  89628205056\n" +
                "/dev/sda2             /boot/efi    vfat 9211904      1071624192\n",
            ),
          );
          stream.emit("close", 0);
        }
        return;
      }

      if (command === LVS_COMMAND) {
        if (capacityBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("lvs: failure\n"));
          stream.emit("close", 1);
        } else if (capacityBehavior === "empty") {
          stream.emit("data", Buffer.from(""));
          stream.emit("close", 0);
        } else {
          stream.emit(
            "data",
            Buffer.from("  data pve twi-aotz-- 63.09 151640866816\n" + "  root pve -wi-ao---- 91662319616\n"),
          );
          stream.emit("close", 0);
        }
        return;
      }

      if (command === PVS_COMMAND) {
        if (capacityBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("pvs: failure\n"));
          stream.emit("close", 1);
        } else if (capacityBehavior === "empty") {
          stream.emit("data", Buffer.from(""));
          stream.emit("close", 0);
        } else {
          stream.emit("data", Buffer.from("  /dev/sda3 pve\n"));
          stream.emit("close", 0);
        }
        return;
      }

      // Unexpected command in a test — fail loudly rather than silently
      // matching a fallback branch.
      stream.stderr.emit("data", Buffer.from(`unexpected command: ${command}\n`));
      stream.emit("close", 127);
    });
  }

  end() {}
}

vi.mock("ssh2", () => ({
  Client: FakeClient,
}));

const { getSmartData, listBlockDevices, getDiskUsage, getLvmReport, getPvMapping, SSH_COMMAND_TIMEOUT_MS } =
  await import("./smartClient");

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "/config/ssh/id_smart" };

afterEach(() => {
  connectBehavior = "ready";
  lsblkBehavior = "success";
  smartBehavior = "success";
  capacityBehavior = "success";
  vi.useRealTimers();
});

describe("smartClient", () => {
  it("lists block devices via the exact lsblk command", async () => {
    const result = await listBlockDevices(sshConfig);
    expect(result.blockdevices).toEqual([{ name: "sda" }]);
  });

  it("rejects listBlockDevices when lsblk exits non-zero", async () => {
    lsblkBehavior = "nonzero";
    await expect(listBlockDevices(sshConfig)).rejects.toThrow(/exited with code 1/);
  });

  it("fetches SMART data for a valid device path using the exact smartctl command", async () => {
    const result = await getSmartData(sshConfig, "/dev/sda");
    expect(result.model_name).toBe("Test");
  });

  it("rejects device paths outside the allowed pattern", async () => {
    await expect(getSmartData(sshConfig, "/dev/sda; rm -rf /")).rejects.toThrow(/unsafe device path/);
  });

  it("resolves with parsed SMART data even when smartctl exits non-zero (failing disk)", async () => {
    smartBehavior = "nonzero-valid-json";
    const result = await getSmartData(sshConfig, "/dev/sda");
    expect(result.model_name).toBe("Failing Disk");
    expect(result.smartctl.exit_status).toBe(8);
  });

  it("rejects when smartctl exits non-zero AND stdout isn't valid JSON", async () => {
    smartBehavior = "nonzero-invalid";
    await expect(getSmartData(sshConfig, "/dev/sda")).rejects.toThrow(/Failed to parse smartctl output/);
  });

  it("rejects if the SSH connection never becomes ready, within the configured timeout", async () => {
    vi.useFakeTimers();
    connectBehavior = "hang";

    const promise = getSmartData(sshConfig, "/dev/sda");
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(SSH_COMMAND_TIMEOUT_MS);
    await assertion;
  });

  it("cleans up the connection when the SSH connection itself errors", async () => {
    connectBehavior = "error";
    const endSpy = vi.spyOn(FakeClient.prototype, "end");

    await expect(getSmartData(sshConfig, "/dev/sda")).rejects.toThrow(/connection refused/);
    expect(endSpy).toHaveBeenCalled();

    endSpy.mockRestore();
  });

  it("fetches disk usage via the exact df command", async () => {
    const result = await getDiskUsage(sshConfig);
    expect(result).toEqual([
      { source: "/dev/mapper/pve-root", target: "/", fstype: "ext4", usedBytes: 25914707968, sizeBytes: 89628205056 },
      { source: "/dev/sda2", target: "/boot/efi", fstype: "vfat", usedBytes: 9211904, sizeBytes: 1071624192 },
    ]);
  });

  it("returns an empty array when df has nothing to report beyond the header", async () => {
    capacityBehavior = "empty";
    const result = await getDiskUsage(sshConfig);
    expect(result).toEqual([]);
  });

  it("rejects getDiskUsage when df exits non-zero", async () => {
    capacityBehavior = "nonzero";
    await expect(getDiskUsage(sshConfig)).rejects.toThrow(/exited with code 1/);
  });

  it("fetches the LVM report via the exact lvs command, with dataPercent null for non-thin LVs", async () => {
    const result = await getLvmReport(sshConfig);
    expect(result).toEqual([
      { lvName: "data", vgName: "pve", lvAttr: "twi-aotz--", dataPercent: 63.09, lvSizeBytes: 151640866816 },
      { lvName: "root", vgName: "pve", lvAttr: "-wi-ao----", dataPercent: null, lvSizeBytes: 91662319616 },
    ]);
  });

  it("returns an empty array when lvs has no output (no LVM on this host)", async () => {
    capacityBehavior = "empty";
    const result = await getLvmReport(sshConfig);
    expect(result).toEqual([]);
  });

  it("rejects getLvmReport when lvs exits non-zero", async () => {
    capacityBehavior = "nonzero";
    await expect(getLvmReport(sshConfig)).rejects.toThrow(/exited with code 1/);
  });

  it("fetches the PV-to-VG mapping via the exact pvs command", async () => {
    const result = await getPvMapping(sshConfig);
    expect(result).toEqual([{ pvName: "/dev/sda3", vgName: "pve" }]);
  });

  it("returns an empty array when pvs has no output (no LVM on this host)", async () => {
    capacityBehavior = "empty";
    const result = await getPvMapping(sshConfig);
    expect(result).toEqual([]);
  });

  it("rejects getPvMapping when pvs exits non-zero", async () => {
    capacityBehavior = "nonzero";
    await expect(getPvMapping(sshConfig)).rejects.toThrow(/exited with code 1/);
  });
});
