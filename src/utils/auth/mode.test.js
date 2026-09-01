import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasOidcConfig, passwordAuthActive } from "utils/auth/mode";

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

  describe("hasOidcConfig", () => {
    it("exposes hasOidcConfig", () => {
      process.env.HOMEPAGE_OIDC_ISSUER = "x";
      process.env.HOMEPAGE_OIDC_CLIENT_ID = "x";
      process.env.HOMEPAGE_OIDC_CLIENT_SECRET = "x";
      expect(hasOidcConfig()).toBe(true);
    });
  });

  describe("passwordAuthActive", () => {
    it("is true when auth is enabled and no OIDC config", () => {
      process.env.HOMEPAGE_AUTH_ENABLED = "true";
      expect(passwordAuthActive()).toBe(true);
    });

    it("passwordAuthActive ignores HOMEPAGE_AUTH_PASSWORD", () => {
      process.env.HOMEPAGE_AUTH_ENABLED = "true";
      delete process.env.HOMEPAGE_AUTH_PASSWORD;
      delete process.env.HOMEPAGE_OIDC_ISSUER;
      expect(passwordAuthActive()).toBe(true);
    });

    it("is false when auth is disabled", () => {
      process.env.HOMEPAGE_AUTH_ENABLED = "false";
      expect(passwordAuthActive()).toBe(false);
    });

    it("is false when OIDC is fully configured", () => {
      process.env.HOMEPAGE_AUTH_ENABLED = "true";
      Object.assign(process.env, OIDC_ENV);
      expect(passwordAuthActive()).toBe(false);
    });

    it("stays true when OIDC config is only partial", () => {
      process.env.HOMEPAGE_AUTH_ENABLED = "true";
      process.env.HOMEPAGE_OIDC_ISSUER = OIDC_ENV.HOMEPAGE_OIDC_ISSUER;
      process.env.HOMEPAGE_OIDC_CLIENT_ID = OIDC_ENV.HOMEPAGE_OIDC_CLIENT_ID;
      expect(passwordAuthActive()).toBe(true);
    });
  });
});
