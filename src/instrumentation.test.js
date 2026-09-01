import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensureAuthSecret, ensureInitialUser, isAuthEnabled, readAuthFile } = vi.hoisted(() => ({
  ensureAuthSecret: vi.fn(),
  ensureInitialUser: vi.fn(),
  isAuthEnabled: vi.fn(),
  readAuthFile: vi.fn(),
}));
vi.mock("utils/auth/secret", () => ({ ensureAuthSecret }));
vi.mock("utils/auth/credentials-store", () => ({ ensureInitialUser }));
vi.mock("utils/env", () => ({ isAuthEnabled }));
vi.mock("utils/auth/auth-file", () => ({ readAuthFile }));

beforeEach(() => {
  vi.clearAllMocks();
  isAuthEnabled.mockReturnValue(true);
  ensureInitialUser.mockResolvedValue({ created: false, reason: "exists" });
  ensureAuthSecret.mockReturnValue("S");
  readAuthFile.mockReturnValue({ secret: "S" });
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.HOMEPAGE_AUTH_SECRET;
});
afterEach(() => {
  delete process.env.NEXT_RUNTIME;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.HOMEPAGE_AUTH_SECRET;
});

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

  it("throws on reason:corrupt", async () => {
    ensureInitialUser.mockResolvedValue({ created: false, reason: "corrupt" });
    await expect(register()).rejects.toThrow(/could not be parsed/i);
  });

  it("throws when the signing secret could not be persisted (no env secret)", async () => {
    ensureAuthSecret.mockReturnValue("S");
    readAuthFile.mockReturnValue({}); // write failed → file has no secret
    await expect(register()).rejects.toThrow(/different secrets|could not persist/i);
  });

  it("resolves when the persisted secret matches the returned one", async () => {
    ensureAuthSecret.mockReturnValue("S");
    readAuthFile.mockReturnValue({ secret: "S" });
    await expect(register()).resolves.toBeUndefined();
  });

  it("skips the persistence check when HOMEPAGE_AUTH_SECRET is set", async () => {
    process.env.HOMEPAGE_AUTH_SECRET = "env-secret";
    ensureAuthSecret.mockReturnValue("env-secret");
    readAuthFile.mockReturnValue({}); // would fail the check, but env path skips it
    await expect(register()).resolves.toBeUndefined();
  });
});
