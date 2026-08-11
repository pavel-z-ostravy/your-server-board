import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "fake-private-key"),
}));

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

class FakeClient extends EventEmitter {
  connect() {
    setImmediate(() => this.emit("ready"));
  }

  exec(command, callback) {
    const stream = new FakeStream();
    setImmediate(() => {
      callback(null, stream);
      if (command.startsWith("lsblk")) {
        stream.emit("data", Buffer.from('{"blockdevices":[{"name":"sda"}]}'));
      } else {
        stream.emit("data", Buffer.from('{"model_name":"Test"}'));
      }
      stream.emit("close", 0);
    });
  }

  end() {}
}

vi.mock("ssh2", () => ({
  Client: FakeClient,
}));

const { getSmartData, listBlockDevices } = await import("./smartClient");

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "/config/ssh/id_smart" };

describe("smartClient", () => {
  it("lists block devices via lsblk", async () => {
    const result = await listBlockDevices(sshConfig);
    expect(result.blockdevices).toEqual([{ name: "sda" }]);
  });

  it("fetches SMART data for a valid device path", async () => {
    const result = await getSmartData(sshConfig, "/dev/sda");
    expect(result.model_name).toBe("Test");
  });

  it("rejects device paths outside the allowed pattern", async () => {
    await expect(getSmartData(sshConfig, "/dev/sda; rm -rf /")).rejects.toThrow(/unsafe device path/);
  });
});
