import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "ysb-credstore-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
  for (const k of [
    "HOMEPAGE_AUTH_ENABLED",
    "HOMEPAGE_AUTH_USERNAME",
    "HOMEPAGE_AUTH_PASSWORD",
    "HOMEPAGE_OIDC_ISSUER",
    "HOMEPAGE_OIDC_CLIENT_ID",
    "HOMEPAGE_OIDC_CLIENT_SECRET",
  ])
    delete process.env[k];
});
afterEach(() => {
  delete process.env.HOMEPAGE_CONFIG_DIR;
});

const load = () => import("utils/auth/credentials-store");

describe("utils/auth/credentials-store", () => {
  it("ensureInitialUser: skips when auth disabled", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "false";
    expect(await (await load()).ensureInitialUser()).toEqual({ created: false, reason: "disabled" });
  });

  it("ensureInitialUser: skips when env-managed / OIDC / already exists", async () => {
    process.env.HOMEPAGE_AUTH_USERNAME = "u";
    process.env.HOMEPAGE_AUTH_PASSWORD = "p";
    expect((await (await load()).ensureInitialUser()).reason).toBe("env");
    vi.resetModules();
    delete process.env.HOMEPAGE_AUTH_USERNAME;
    delete process.env.HOMEPAGE_AUTH_PASSWORD;
    process.env.HOMEPAGE_OIDC_ISSUER = "x";
    process.env.HOMEPAGE_OIDC_CLIENT_ID = "x";
    process.env.HOMEPAGE_OIDC_CLIENT_SECRET = "x";
    expect((await (await load()).ensureInitialUser()).reason).toBe("oidc");
  });

  it("ensureInitialUser: creates {username:'admin'} with no hash", async () => {
    const cs = await load();
    expect(await cs.ensureInitialUser()).toEqual({ created: true });
    expect(cs.readUser()).toEqual({ username: "admin" });
    expect(cs.usingDefaultCredentials()).toBe(true);
    expect(cs.currentUsername()).toBe("admin");
  });

  it("ensureInitialUser: refuses to bootstrap over a corrupt auth.json", async () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, '{"secret":"s1","user":{"passwordHash"'); // truncated
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = readFileSync(path, "utf8");
    const cs = await load();
    expect(await cs.ensureInitialUser()).toEqual({ created: false, reason: "corrupt" });
    expect(readFileSync(path, "utf8")).toBe(before); // untouched
  });

  it("writeUser adds a verifiable hash, clears default, preserves other keys", async () => {
    const cs = await load();
    const { writeAuthFile } = await import("utils/auth/auth-file");
    const { verifyHash } = await import("utils/auth/password-hash");
    writeAuthFile({ secret: "s1", totp: { secret: "T" } });
    await cs.writeUser({ username: "pavel", password: "hunter2!!" });
    const stored = (await import("utils/auth/auth-file")).readAuthFile();
    expect(stored.secret).toBe("s1");
    expect(stored.totp).toEqual({ secret: "T" });
    expect(await verifyHash("hunter2!!", stored.user.passwordHash)).toBe(true);
    expect(cs.usingDefaultCredentials()).toBe(false);
    expect(cs.currentUsername()).toBe("pavel");
  });

  it("currentUsername: env wins only when both env vars set", async () => {
    const cs = await load();
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ user: { username: "stored" } });
    expect(cs.currentUsername()).toBe("stored");
    process.env.HOMEPAGE_AUTH_USERNAME = "envuser"; // password not set
    expect(cs.currentUsername()).toBe("stored");
    process.env.HOMEPAGE_AUTH_PASSWORD = "envpass";
    expect(cs.currentUsername()).toBe("envuser");
  });

  it("managedByEnv: empty-string env vars behave as unset", async () => {
    const cs = await load();
    process.env.HOMEPAGE_AUTH_USERNAME = "";
    process.env.HOMEPAGE_AUTH_PASSWORD = "";
    expect(cs.managedByEnv()).toBe(false);
  });
});
