import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("utils/logger", () => ({ default: vi.fn(() => ({ warn: warnMock })) }));

let dir;
beforeEach(() => {
  vi.resetModules();
  warnMock.mockClear();
  dir = mkdtempSync(join(tmpdir(), "ysb-cred-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
  for (const k of ["HOMEPAGE_AUTH_USERNAME", "HOMEPAGE_AUTH_PASSWORD"]) delete process.env[k];
});
afterEach(() => { delete process.env.HOMEPAGE_CONFIG_DIR; });

const load = () => import("utils/auth/credentials");

describe("verifyPassword", () => {
  it("env override wins and ignores a stored user", async () => {
    process.env.HOMEPAGE_AUTH_USERNAME = "admin";
    process.env.HOMEPAGE_AUTH_PASSWORD = "envpw";
    const { writeAuthFile } = await import("utils/auth/auth-file");
    const { hashPassword } = await import("utils/auth/password-hash");
    writeAuthFile({ user: { username: "admin", passwordHash: await hashPassword("stored") } });
    const { verifyPassword } = await load();
    expect(await verifyPassword("admin", "envpw")).toBe(true);
    expect(await verifyPassword("admin", "stored")).toBe(false);
    expect(await verifyPassword("wrong", "envpw")).toBe(false);
  });

  it("stored user WITH hash → scrypt; wrong username fails", async () => {
    const { writeUser } = await import("utils/auth/credentials-store");
    await writeUser({ username: "pavel", password: "hunter2!!" });
    const { verifyPassword } = await load();
    expect(await verifyPassword("pavel", "hunter2!!")).toBe(true);
    expect(await verifyPassword("nope", "hunter2!!")).toBe(false);
    expect(await verifyPassword("pavel", "x")).toBe(false);
  });

  it("stored user WITHOUT hash → literal admin/admin", async () => {
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ user: { username: "admin" } });
    const { verifyPassword } = await load();
    expect(await verifyPassword("admin", "admin")).toBe(true);
    expect(await verifyPassword("admin", "wrong")).toBe(false);
  });

  it("stored user with no username → rejects 'undefined'/'admin'", async () => {
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ user: {} });
    const { verifyPassword } = await load();
    expect(await verifyPassword("undefined", "admin")).toBe(false);
    expect(await verifyPassword("", "admin")).toBe(false);
  });

  it("stored user with an empty passwordHash → rejects, no admin fall-through", async () => {
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ user: { username: "admin", passwordHash: "" } });
    const { verifyPassword } = await load();
    expect(await verifyPassword("admin", "admin")).toBe(false);
  });

  it("stored user with a null passwordHash → rejects, no admin fall-through", async () => {
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ user: { username: "admin", passwordHash: null } });
    const { verifyPassword } = await load();
    expect(await verifyPassword("admin", "admin")).toBe(false);
  });

  it("no user, no env → false; non-string → false", async () => {
    const { verifyPassword } = await load();
    expect(await verifyPassword("admin", "admin")).toBe(false);
    expect(await verifyPassword(1, 2)).toBe(false);
  });
});

describe("logFailedPasswordSignIn", () => {
  it("warns with the fail2ban-filter message", async () => {
    const { logFailedPasswordSignIn } = await load();
    logFailedPasswordSignIn();
    expect(warnMock).toHaveBeenCalledWith("Failed password sign-in attempt");
  });
});
