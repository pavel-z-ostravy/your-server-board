import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { passwordAuthActive } from "utils/auth/mode";

const OIDC_ENV = {
  HOMEPAGE_OIDC_ISSUER: "https://idp.example",
  HOMEPAGE_OIDC_CLIENT_ID: "client",
  HOMEPAGE_OIDC_CLIENT_SECRET: "secret",
};

describe("utils/auth/mode", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HOMEPAGE_AUTH_ENABLED;
    delete process.env.HOMEPAGE_AUTH_PASSWORD;
    delete process.env.HOMEPAGE_OIDC_ISSUER;
    delete process.env.HOMEPAGE_OIDC_CLIENT_ID;
    delete process.env.HOMEPAGE_OIDC_CLIENT_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("is true when auth is enabled, no OIDC config, and a password is set", () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    process.env.HOMEPAGE_AUTH_PASSWORD = "pw";
    expect(passwordAuthActive()).toBe(true);
  });

  it("is false when auth is disabled", () => {
    process.env.HOMEPAGE_AUTH_PASSWORD = "pw";
    expect(passwordAuthActive()).toBe(false);
  });

  it("is false when no password is set", () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    expect(passwordAuthActive()).toBe(false);
  });

  it("is false when OIDC is fully configured", () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    process.env.HOMEPAGE_AUTH_PASSWORD = "pw";
    Object.assign(process.env, OIDC_ENV);
    expect(passwordAuthActive()).toBe(false);
  });

  it("stays true when OIDC config is only partial", () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    process.env.HOMEPAGE_AUTH_PASSWORD = "pw";
    process.env.HOMEPAGE_OIDC_ISSUER = OIDC_ENV.HOMEPAGE_OIDC_ISSUER;
    process.env.HOMEPAGE_OIDC_CLIENT_ID = OIDC_ENV.HOMEPAGE_OIDC_CLIENT_ID;
    expect(passwordAuthActive()).toBe(true);
  });
});
