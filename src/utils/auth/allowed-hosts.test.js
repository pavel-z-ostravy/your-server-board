import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allowAllHosts, allowedHostSet, isAllowedHost } from "utils/auth/allowed-hosts";

const KEYS = ["HOMEPAGE_ALLOWED_HOSTS", "PORT"];
const saved = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("allowedHostSet", () => {
  it("always contains the loopback hosts for the configured port", () => {
    delete process.env.HOMEPAGE_ALLOWED_HOSTS;
    process.env.PORT = "3000";
    const set = allowedHostSet();
    expect(set.has("localhost:3000")).toBe(true);
    expect(set.has("127.0.0.1:3000")).toBe(true);
    expect(set.has("[::1]:3000")).toBe(true);
  });

  it("defaults the port to 3000 when PORT is unset", () => {
    delete process.env.HOMEPAGE_ALLOWED_HOSTS;
    delete process.env.PORT;
    expect(allowedHostSet().has("localhost:3000")).toBe(true);
  });

  it("adds each comma-separated entry, trimming whitespace, ignoring blanks", () => {
    process.env.HOMEPAGE_ALLOWED_HOSTS = "example.com:3050, homelab.vault1922.xyz ,,";
    const set = allowedHostSet();
    expect(set.has("example.com:3050")).toBe(true);
    expect(set.has("homelab.vault1922.xyz")).toBe(true);
    expect(set.has("")).toBe(false);
  });

  it("does not treat '*' as a literal host entry", () => {
    process.env.HOMEPAGE_ALLOWED_HOSTS = "*";
    expect(allowedHostSet().has("*")).toBe(false);
  });
});

describe("allowAllHosts", () => {
  it("is true only for the exact '*' value", () => {
    process.env.HOMEPAGE_ALLOWED_HOSTS = "*";
    expect(allowAllHosts()).toBe(true);
    process.env.HOMEPAGE_ALLOWED_HOSTS = "*,example.com";
    expect(allowAllHosts()).toBe(false);
    delete process.env.HOMEPAGE_ALLOWED_HOSTS;
    expect(allowAllHosts()).toBe(false);
  });
});

describe("isAllowedHost", () => {
  it("honours the wildcard", () => {
    process.env.HOMEPAGE_ALLOWED_HOSTS = "*";
    expect(isAllowedHost("anything.example")).toBe(true);
  });

  it("matches an explicitly listed host", () => {
    process.env.HOMEPAGE_ALLOWED_HOSTS = "homelab.vault1922.xyz";
    expect(isAllowedHost("homelab.vault1922.xyz")).toBe(true);
    expect(isAllowedHost("evil.example")).toBe(false);
  });

  it("matches the loopback hosts without configuration", () => {
    delete process.env.HOMEPAGE_ALLOWED_HOSTS;
    process.env.PORT = "3050";
    expect(isAllowedHost("localhost:3050")).toBe(true);
  });

  it("rejects an empty or missing host unless the wildcard is set", () => {
    process.env.HOMEPAGE_ALLOWED_HOSTS = "example.com";
    expect(isAllowedHost("")).toBe(false);
    expect(isAllowedHost(null)).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    // '*' short-circuits before the host is even looked at — matches the
    // existing middleware behaviour (`if (!allowAll && (!host || ...))`).
    process.env.HOMEPAGE_ALLOWED_HOSTS = "*";
    expect(isAllowedHost("")).toBe(true);
  });
});
