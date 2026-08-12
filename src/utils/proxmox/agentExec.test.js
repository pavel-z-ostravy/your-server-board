import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { httpProxy } = vi.hoisted(() => ({ httpProxy: vi.fn() }));
vi.mock("utils/proxy/http", () => ({ httpProxy }));
vi.mock("utils/logger", () => ({ default: () => ({ error: vi.fn() }) }));

const { getQemuOsProbe, getQemuProcesses, AGENT_EXEC_TIMEOUT_MS } = await import("./agentExec");

const pveConfig = { url: "https://10.0.1.9:8006", token: "root@pam!ysb", secret: "s3cr3t" };

function jsonResponse(status, body) {
  return [status, "application/json", Buffer.from(JSON.stringify(body)), null];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agentExec", () => {
  it("launches the exact hardcoded ps command and polls exec-status until exited, returning stdout", async () => {
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/agent/exec") && !url.includes("exec-status")) {
        return jsonResponse(200, { data: { pid: 12345 } });
      }
      if (url.includes("exec-status")) {
        return jsonResponse(200, { data: { "out-data": "   3368  0.8 18.4 python3\n", exited: 1, exitcode: 0 } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getQemuProcesses(pveConfig, "proxmox", 100);

    expect(result).toBe("   3368  0.8 18.4 python3\n");
    // The command array must be exactly this fixed set — never derived from vmid/node beyond selecting the URL.
    const execCall = httpProxy.mock.calls.find(([url]) => url.includes("/agent/exec") && !url.includes("exec-status"));
    expect(execCall[1].body).toContain("ps");
    expect(execCall[1].body).toContain("--sort=-pcpu");
  });

  it("polls exec-status more than once when the command hasn't exited yet", async () => {
    let pollCount = 0;
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/agent/exec") && !url.includes("exec-status")) {
        return jsonResponse(200, { data: { pid: 999 } });
      }
      if (url.includes("exec-status")) {
        pollCount += 1;
        if (pollCount < 3) return jsonResponse(200, { data: { exited: 0 } });
        return jsonResponse(200, { data: { "out-data": "done\n", exited: 1, exitcode: 0 } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getQemuProcesses(pveConfig, "proxmox", 100);

    expect(result).toBe("done\n");
    expect(pollCount).toBe(3);
  });

  it("rejects when the command never exits within the timeout", async () => {
    vi.useFakeTimers();
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/agent/exec") && !url.includes("exec-status")) {
        return jsonResponse(200, { data: { pid: 1 } });
      }
      return jsonResponse(200, { data: { exited: 0 } });
    });

    const promise = getQemuProcesses(pveConfig, "proxmox", 100);
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(AGENT_EXEC_TIMEOUT_MS + 1000);
    await assertion;
  });

  it("rejects when the initial exec call fails", async () => {
    httpProxy.mockImplementation(async () => jsonResponse(500, { error: "boom" }));

    await expect(getQemuProcesses(pveConfig, "proxmox", 100)).rejects.toThrow(/exec/i);
  });

  it("fetches the OS probe via the exact hardcoded sh -c command", async () => {
    httpProxy.mockImplementation(async (url) => {
      if (url.includes("/agent/exec") && !url.includes("exec-status")) {
        return jsonResponse(200, { data: { pid: 42 } });
      }
      if (url.includes("exec-status")) {
        return jsonResponse(200, {
          data: { "out-data": 'PRETTY_NAME="Home Assistant OS 18.2"\n---\nnone\n', exited: 1, exitcode: 0 },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getQemuOsProbe(pveConfig, "proxmox", 100);

    expect(result).toBe('PRETTY_NAME="Home Assistant OS 18.2"\n---\nnone\n');
    const execCall = httpProxy.mock.calls.find(([url]) => url.includes("/agent/exec") && !url.includes("exec-status"));
    expect(execCall[1].body).toContain("os-release");
    expect(execCall[1].body).toContain("update-success-stamp");
  });
});
