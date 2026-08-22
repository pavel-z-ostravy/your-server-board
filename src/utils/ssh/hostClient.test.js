import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "fake-private-key"),
}));

const PS_COMMAND = "ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu";

let commandBehavior = "success"; // "success" | "nonzero"

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

      if (command === PS_COMMAND) {
        if (commandBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("ps: unexpected error\n"));
          stream.emit("close", 1);
        } else {
          stream.emit("data", Buffer.from("   512  4.2  1.1 pvedaemon\n    980  0.3  0.2 pveproxy\n"));
          stream.emit("close", 0);
        }
        return;
      }

      stream.stderr.emit("data", Buffer.from(`unexpected command: ${command}\n`));
      stream.emit("close", 127);
    });
  }

  end() {}
}

vi.mock("ssh2", () => ({
  Client: FakeClient,
}));

const { getHostProcesses } = await import("./hostClient");

const sshConfig = { host: "10.0.0.9", username: "root", privateKeyPath: "/config/ssh/id_smart" };

afterEach(() => {
  commandBehavior = "success";
});

describe("hostClient", () => {
  it("fetches raw process listing output via the exact ps command", async () => {
    const result = await getHostProcesses(sshConfig);
    expect(result).toBe("   512  4.2  1.1 pvedaemon\n    980  0.3  0.2 pveproxy\n");
  });

  it("rejects getHostProcesses when the command exits non-zero", async () => {
    commandBehavior = "nonzero";
    await expect(getHostProcesses(sshConfig)).rejects.toThrow(/exited with code 1/);
  });
});
