import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensureAuthSecret, ensureInitialUser, isAuthEnabled } = vi.hoisted(() => ({
  ensureAuthSecret: vi.fn(),
  ensureInitialUser: vi.fn(),
  isAuthEnabled: vi.fn(),
}));
vi.mock("utils/auth/secret", () => ({ ensureAuthSecret }));
vi.mock("utils/auth/credentials-store", () => ({ ensureInitialUser }));
vi.mock("utils/env", () => ({ isAuthEnabled }));

beforeEach(() => {
  vi.clearAllMocks();
  isAuthEnabled.mockReturnValue(true);
  ensureInitialUser.mockResolvedValue({ created: false, reason: "exists" });
  process.env.NEXT_RUNTIME = "nodejs";
});
afterEach(() => { delete process.env.NEXT_RUNTIME; });

const register = async () => (await import("./instrumentation")).register(); // test sits next to the module

describe("instrumentation.register", () => {
  it("no-ops outside the nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(ensureAuthSecret).not.toHaveBeenCalled();
  });

  it("ensures secret + user when auth is on", async () => {
    await register();
    expect(ensureAuthSecret).toHaveBeenCalled();
    expect(ensureInitialUser).toHaveBeenCalled();
  });

  it("skips ensureAuthSecret when auth is off", async () => {
    isAuthEnabled.mockReturnValue(false);
    await register();
    expect(ensureAuthSecret).not.toHaveBeenCalled();
  });

  it("prints the box when a user was created", async () => {
    ensureInitialUser.mockResolvedValue({ created: true });
    const w = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await register();
    expect(w.mock.calls.join("")).toMatch(/password: admin/);
  });

  it("throws on reason:readonly", async () => {
    ensureInitialUser.mockResolvedValue({ created: false, reason: "readonly" });
    await expect(register()).rejects.toThrow(/not writable/i);
  });
});
