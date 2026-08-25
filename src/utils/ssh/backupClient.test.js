import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const VALID_VOLID = "local:backup/vzdump-qemu-100-2026_08_24-10_00_00.vma.zst";

let connectBehavior = "ready"; // "ready" | "hang" | "error"
let execBehavior = "success"; // "success" | "exec-error"

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
    if (connectBehavior === "hang") return;
    if (connectBehavior === "error") {
      setImmediate(() => this.emit("error", new Error("connection refused")));
      return;
    }
    setImmediate(() => this.emit("ready"));
  }

  exec(command, callback) {
    this.lastCommand = command;
    if (execBehavior === "exec-error") {
      setImmediate(() => callback(new Error("exec failed")));
      return;
    }
    setImmediate(() => callback(null, new FakeStream()));
  }

  end() {}
}

vi.mock("ssh2", () => ({ Client: FakeClient }));

const { SSH_CONNECT_TIMEOUT_MS, streamBackupFile } = await import("./backupClient");

const sshConfig = { host: "proxmox.local", username: "root", privateKeyPath: "/fake/key" };

afterEach(() => {
  connectBehavior = "ready";
  execBehavior = "success";
  vi.useRealTimers();
});

describe("streamBackupFile", () => {
  it("resolves with the live stream and connection for a valid volid", async () => {
    const result = await streamBackupFile(sshConfig, VALID_VOLID);

    expect(result.stream).toBeInstanceOf(EventEmitter);
    expect(result.conn).toBeInstanceOf(FakeClient);
    expect(result.conn.lastCommand).toBe(`cat-backup ${VALID_VOLID}`);
  });

  it("rejects for a volid that doesn't match the expected vzdump filename shape", async () => {
    await expect(streamBackupFile(sshConfig, "local:backup/../../etc/passwd")).rejects.toThrow(
      "Refusing to stream unsafe backup path",
    );
  });

  it("rejects for a volid with no storage prefix", async () => {
    await expect(streamBackupFile(sshConfig, "not-a-volid")).rejects.toThrow("Refusing to stream unsafe backup path");
  });

  it("rejects when the SSH connection itself errors", async () => {
    connectBehavior = "error";

    await expect(streamBackupFile(sshConfig, VALID_VOLID)).rejects.toThrow("connection refused");
  });

  it("rejects when exec itself fails", async () => {
    execBehavior = "exec-error";

    await expect(streamBackupFile(sshConfig, VALID_VOLID)).rejects.toThrow("exec failed");
  });

  it("rejects if the SSH connection never becomes ready, within the configured timeout", async () => {
    vi.useFakeTimers();
    connectBehavior = "hang";

    const promise = streamBackupFile(sshConfig, VALID_VOLID);
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(SSH_CONNECT_TIMEOUT_MS);
    await assertion;
  });

  it("cleans up the connection when the SSH connection itself errors", async () => {
    connectBehavior = "error";
    const endSpy = vi.spyOn(FakeClient.prototype, "end");

    await expect(streamBackupFile(sshConfig, VALID_VOLID)).rejects.toThrow("connection refused");
    expect(endSpy).toHaveBeenCalled();

    endSpy.mockRestore();
  });
});
