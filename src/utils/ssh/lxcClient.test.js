import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "fake-private-key"),
}));

const PS_COMMAND_200 = "pct exec 200 -- ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu";
const OS_PROBE_COMMAND_200 =
  "pct exec 200 -- sh -c 'cat /etc/os-release 2>/dev/null; echo ---; (stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none)'";

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

      if (command === PS_COMMAND_200) {
        if (commandBehavior === "nonzero") {
          stream.stderr.emit("data", Buffer.from("pct: container 200 not running\n"));
          stream.emit("close", 1);
        } else {
          stream.emit("data", Buffer.from("   3368  0.8 18.4 redis-server\n    174  0.0  1.3 dockerd\n"));
          stream.emit("close", 0);
        }
        return;
      }

      if (command === OS_PROBE_COMMAND_200) {
        stream.emit(
          "data",
          Buffer.from('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n---\nnone\n'),
        );
        stream.emit("close", 0);
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

const { getLxcProcesses, getLxcOsProbe } = await import("./lxcClient");

const sshConfig = { host: "10.0.1.9", username: "root", privateKeyPath: "/config/ssh/id_smart" };

afterEach(() => {
  commandBehavior = "success";
});

describe("lxcClient", () => {
  it("fetches raw process listing output via the exact pct exec command", async () => {
    const result = await getLxcProcesses(sshConfig, 200);
    expect(result).toBe("   3368  0.8 18.4 redis-server\n    174  0.0  1.3 dockerd\n");
  });

  it("rejects getLxcProcesses when pct exec exits non-zero", async () => {
    commandBehavior = "nonzero";
    await expect(getLxcProcesses(sshConfig, 200)).rejects.toThrow(/exited with code 1/);
  });

  it("rejects getLxcProcesses for a non-numeric vmid without making any SSH connection", async () => {
    const connectSpy = vi.spyOn(FakeClient.prototype, "connect");
    await expect(getLxcProcesses(sshConfig, "200; rm -rf /")).rejects.toThrow(/unsafe vmid/);
    expect(connectSpy).not.toHaveBeenCalled();
    connectSpy.mockRestore();
  });

  it("fetches raw OS-release/update-probe output via the exact pct exec command", async () => {
    const result = await getLxcOsProbe(sshConfig, 200);
    expect(result).toBe('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n---\nnone\n');
  });

  it("rejects getLxcOsProbe for a non-numeric vmid without making any SSH connection", async () => {
    const connectSpy = vi.spyOn(FakeClient.prototype, "connect");
    await expect(getLxcOsProbe(sshConfig, "$(reboot)")).rejects.toThrow(/unsafe vmid/);
    expect(connectSpy).not.toHaveBeenCalled();
    connectSpy.mockRestore();
  });
});
