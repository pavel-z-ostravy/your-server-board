import { beforeEach, describe, expect, it, vi } from "vitest";

const { debugMock, errorMock, nextAuthMock, warnMock } = vi.hoisted(() => ({
  debugMock: vi.fn(),
  errorMock: vi.fn(),
  nextAuthMock: vi.fn((options) => ({ options })),
  warnMock: vi.fn(),
}));

const { verifyPasswordMock, isTotpEnabledMock, verifyTokenMock } = vi.hoisted(() => ({
  verifyPasswordMock: vi.fn(),
  isTotpEnabledMock: vi.fn(() => false),
  verifyTokenMock: vi.fn(() => false),
}));

vi.mock("next-auth", () => ({
  default: nextAuthMock,
}));

vi.mock("utils/logger", () => ({
  default: vi.fn(() => ({ debug: debugMock, error: errorMock, warn: warnMock })),
}));

vi.mock("utils/auth/secret", () => ({ ensureAuthSecret: () => "x".repeat(44) }));

vi.mock("utils/auth/credentials", () => ({
  verifyPassword: verifyPasswordMock,
  logFailedPasswordSignIn: () => warnMock("Failed password sign-in attempt"),
}));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled: isTotpEnabledMock }));
vi.mock("utils/auth/totp", () => ({ verifyToken: verifyTokenMock }));

describe("pages/api/auth/[...nextauth]", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    debugMock.mockClear();
    errorMock.mockClear();
    nextAuthMock.mockClear();
    warnMock.mockClear();
    verifyPasswordMock.mockReset();
    isTotpEnabledMock.mockReset().mockReturnValue(false);
    verifyTokenMock.mockReset().mockReturnValue(false);
    process.env = { ...originalEnv };
    delete process.env.HOMEPAGE_AUTH_ENABLED;
    delete process.env.HOMEPAGE_AUTH_SECRET;
    delete process.env.HOMEPAGE_EXTERNAL_URL;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_URL;
    delete process.env.HOMEPAGE_AUTH_USERNAME;
    delete process.env.HOMEPAGE_AUTH_PASSWORD;
    delete process.env.HOMEPAGE_OIDC_ISSUER;
    delete process.env.HOMEPAGE_OIDC_CLIENT_ID;
    delete process.env.HOMEPAGE_OIDC_CLIENT_SECRET;
    delete process.env.HOMEPAGE_OIDC_NAME;
    delete process.env.HOMEPAGE_OIDC_SCOPE;
  });

  it("configures no providers when auth is disabled", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "false";
    const mod = await import("pages/api/auth/[...nextauth]");

    expect(nextAuthMock).toHaveBeenCalledTimes(1);
    expect(mod.authOptions.providers).toEqual([]);
    expect(mod.authOptions.pages?.signIn).toBe("/auth/signin");
  });

  it("answers the session endpoint with an empty session when auth is disabled", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "false";
    const mod = await import("pages/api/auth/[...nextauth]");
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json, end: vi.fn() })) };

    await mod.default({ query: { nextauth: ["session"] } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({});
    expect(nextAuthMock).toHaveBeenCalledTimes(1); // built at import, never invoked per-request
  });

  it.each([["providers"], ["csrf"], ["signin"]])(
    "answers the %s endpoint with parseable JSON when auth is disabled",
    async (endpoint) => {
      process.env.HOMEPAGE_AUTH_ENABLED = "false";
      const mod = await import("pages/api/auth/[...nextauth]");
      const json = vi.fn();
      const res = { status: vi.fn(() => ({ json, end: vi.fn() })) };

      await mod.default({ query: { nextauth: [endpoint] } }, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({});
    },
  );

  it("does not enable NextAuth's raw debug logger", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "false";
    const mod = await import("pages/api/auth/[...nextauth]");

    expect(mod.authOptions).not.toHaveProperty("debug");
  });

  it("routes sanitized NextAuth logs through the Homepage logger", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "false";
    const mod = await import("pages/api/auth/[...nextauth]");
    const sensitiveMetadata = {
      clientSecret: "sensitive-client-secret",
      access_token: "sensitive-access-token",
      id_token: "sensitive-id-token",
    };

    mod.authOptions.logger.error("OAUTH_CALLBACK_ERROR", sensitiveMetadata);
    mod.authOptions.logger.warn("NEXTAUTH_URL", sensitiveMetadata);
    mod.authOptions.logger.debug("OAUTH_CALLBACK_RESPONSE", sensitiveMetadata);

    expect(errorMock).toHaveBeenCalledWith("%s", "OAUTH_CALLBACK_ERROR");
    expect(warnMock).toHaveBeenCalledWith("%s", "NEXTAUTH_URL");
    expect(debugMock).toHaveBeenCalledWith("%s", "OAUTH_CALLBACK_RESPONSE");
    expect(JSON.stringify([...errorMock.mock.calls, ...warnMock.mock.calls, ...debugMock.mock.calls])).not.toContain(
      "sensitive",
    );
  });

  it("logs only sanitized authentication lifecycle events", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "false";
    const mod = await import("pages/api/auth/[...nextauth]");

    await mod.authOptions.events.signIn({
      account: {
        provider: "homepage-oidc",
        access_token: "sensitive-access-token",
        id_token: "sensitive-id-token",
      },
      user: { email: "sensitive@example.com" },
    });
    await mod.authOptions.events.signOut({ token: { sub: "sensitive-user-id" } });

    expect(debugMock).toHaveBeenNthCalledWith(1, "Sign in via provider '%s'", "homepage-oidc");
    expect(debugMock).toHaveBeenNthCalledWith(2, "Sign out");
    expect(JSON.stringify(debugMock.mock.calls)).not.toContain("sensitive");
  });

  it("maps HOMEPAGE_EXTERNAL_URL to NEXTAUTH_URL and uses the ensured signing secret", async () => {
    process.env.HOMEPAGE_EXTERNAL_URL = "https://homepage.example";

    const mod = await import("pages/api/auth/[...nextauth]");

    expect(process.env.NEXTAUTH_URL).toBe("https://homepage.example");
    expect(process.env.NEXTAUTH_SECRET).toBe("x".repeat(44));
    expect(mod.authOptions.secret).toBe("x".repeat(44));
  });

  it("does not override an explicitly provided NEXTAUTH_SECRET", async () => {
    process.env.NEXTAUTH_SECRET = "explicit-secret-value";
    process.env.HOMEPAGE_EXTERNAL_URL = "https://homepage.example";

    await import("pages/api/auth/[...nextauth]");

    expect(process.env.NEXTAUTH_SECRET).toBe("explicit-secret-value");
  });

  it("throws when OIDC is configured without an external URL", async () => {
    process.env.HOMEPAGE_OIDC_ISSUER = "https://issuer.example";
    process.env.HOMEPAGE_OIDC_CLIENT_ID = "client-id";
    process.env.HOMEPAGE_OIDC_CLIENT_SECRET = "client-secret";

    await expect(import("pages/api/auth/[...nextauth]")).rejects.toThrow(/OIDC auth requires HOMEPAGE_EXTERNAL_URL/i);
  });

  it.each([
    "homepage.example",
    "ftp://homepage.example",
    "https://user:password@homepage.example",
    "https://homepage.example/?unexpected=true",
    "https://homepage.example/#unexpected",
  ])("rejects invalid external URL %s", async (externalUrl) => {
    process.env.HOMEPAGE_EXTERNAL_URL = externalUrl;

    await expect(import("pages/api/auth/[...nextauth]")).rejects.toThrow(/absolute HTTP\(S\) URL/i);
  });

  it("warns when only one of HOMEPAGE_AUTH_USERNAME / PASSWORD is set", async () => {
    process.env.HOMEPAGE_AUTH_USERNAME = "admin";
    // no HOMEPAGE_AUTH_PASSWORD

    await import("pages/api/auth/[...nextauth]");

    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("one is set without the other"));
  });

  it("does not warn when both HOMEPAGE_AUTH_USERNAME and PASSWORD are set", async () => {
    process.env.HOMEPAGE_AUTH_USERNAME = "admin";
    process.env.HOMEPAGE_AUTH_PASSWORD = "secret";

    await import("pages/api/auth/[...nextauth]");

    expect(warnMock).not.toHaveBeenCalledWith(expect.stringContaining("one is set without the other"));
  });

  it("builds a password provider when auth is enabled without OIDC config", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    process.env.HOMEPAGE_EXTERNAL_URL = "https://homepage.example";

    const mod = await import("pages/api/auth/[...nextauth]");
    const [provider] = mod.authOptions.providers;

    expect(provider.id).toBe("credentials");
    expect(provider.name).toBe("Credentials");
    expect(provider.type).toBe("credentials");
    expect(typeof provider.authorize).toBe("function");
    expect(mod.authOptions.useSecureCookies).toBe(true);
  });

  it("builds a password provider when HOMEPAGE_AUTH_ENABLED is unset (on by default)", async () => {
    const mod = await import("pages/api/auth/[...nextauth]");

    expect(mod.authOptions.providers).toHaveLength(1);
    expect(mod.authOptions.providers[0].type).toBe("credentials");
  });

  it("declares username, password, and token credential fields", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";

    const mod = await import("pages/api/auth/[...nextauth]");
    const [provider] = mod.authOptions.providers;

    expect(Object.keys(provider.options.credentials)).toEqual(["username", "password", "token"]);
  });

  it("configures no providers and no secret enforcement when auth is disabled", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "false";

    const mod = await import("pages/api/auth/[...nextauth]");

    expect(mod.authOptions.providers).toEqual([]);
    expect(mod.authOptions.secret).toBeUndefined();
  });

  it("authorizes when the password is correct and 2FA is off", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    verifyPasswordMock.mockResolvedValue(true);

    const mod = await import("pages/api/auth/[...nextauth]");
    const [provider] = mod.authOptions.providers;

    await expect(provider.options.authorize({ username: "admin", password: "secret" })).resolves.toEqual({
      id: "homepage",
      name: "admin",
    });
  });

  it("rejects a bad password and logs a sanitized warning", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    verifyPasswordMock.mockResolvedValue(false);

    const mod = await import("pages/api/auth/[...nextauth]");
    const [provider] = mod.authOptions.providers;

    await expect(provider.options.authorize({ username: "admin", password: "wrong" })).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith("Failed password sign-in attempt");
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain("wrong");
  });

  it("requires a valid TOTP token when 2FA is enabled", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    verifyPasswordMock.mockResolvedValue(true);
    isTotpEnabledMock.mockReturnValue(true);

    const mod = await import("pages/api/auth/[...nextauth]");
    const [provider] = mod.authOptions.providers;

    verifyTokenMock.mockReturnValue(false);
    await expect(
      provider.options.authorize({ username: "admin", password: "secret", token: "000000" }),
    ).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith("Failed password sign-in attempt");

    verifyTokenMock.mockReturnValue(true);
    await expect(
      provider.options.authorize({ username: "admin", password: "secret", token: "123456" }),
    ).resolves.toEqual({ id: "homepage", name: "admin" });
  });

  it("supports trusted HTTP deployments without Secure cookies", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    process.env.HOMEPAGE_EXTERNAL_URL = "http://192.168.1.20:3000";

    const mod = await import("pages/api/auth/[...nextauth]");

    expect(process.env.NEXTAUTH_URL).toBe("http://192.168.1.20:3000");
    expect(mod.authOptions.useSecureCookies).toBe(false);
  });

  it("accepts an explicitly configured NEXTAUTH_URL", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    process.env.NEXTAUTH_URL = "https://homepage.example";

    const mod = await import("pages/api/auth/[...nextauth]");

    expect(mod.authOptions.useSecureCookies).toBe(true);
  });

  it("builds an OIDC provider when enabled and maps profile fields", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    process.env.HOMEPAGE_OIDC_ISSUER = "https://issuer.example/";
    process.env.HOMEPAGE_OIDC_CLIENT_ID = "client-id";
    process.env.HOMEPAGE_OIDC_CLIENT_SECRET = "client-secret";
    process.env.HOMEPAGE_EXTERNAL_URL = "https://homepage.example";
    process.env.HOMEPAGE_OIDC_NAME = "My OIDC";
    process.env.HOMEPAGE_OIDC_SCOPE = "openid email";

    const mod = await import("pages/api/auth/[...nextauth]");
    const [provider] = mod.authOptions.providers;

    expect(provider).toMatchObject({
      id: "homepage-oidc",
      name: "My OIDC",
      type: "oauth",
      idToken: true,
      checks: ["pkce", "state", "nonce"],
      issuer: "https://issuer.example",
      wellKnown: "https://issuer.example/.well-known/openid-configuration",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    expect(provider.authorization.params.scope).toBe("openid email");

    expect(
      provider.profile({
        sub: "sub",
        preferred_username: "user",
        email: "user@example.com",
        picture: "https://example.com/p.png",
      }),
    ).toEqual({
      id: "sub",
      name: "user",
      email: "user@example.com",
      image: "https://example.com/p.png",
    });

    expect(
      provider.profile({
        id: "id",
        name: "name",
      }),
    ).toEqual({
      id: "id",
      name: "name",
      email: null,
      image: null,
    });
  });

  it("throttles after 5 consecutive wrong passwords", async () => {
    vi.useFakeTimers();
    try {
      process.env.HOMEPAGE_AUTH_ENABLED = "true";
      verifyPasswordMock.mockResolvedValue(false);
      const mod = await import("pages/api/auth/[...nextauth]");
      const authorize = mod.authOptions.providers[0].options.authorize;

      for (let i = 0; i < 5; i += 1) {
        await authorize({ username: "admin", password: "x" });
      }
      verifyPasswordMock.mockClear();
      warnMock.mockClear();
      await authorize({ username: "admin", password: "x" }); // blocked
      expect(verifyPasswordMock).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled(); // blocked path does not log

      vi.advanceTimersByTime(1100);
      verifyPasswordMock.mockResolvedValue(true);
      isTotpEnabledMock.mockReturnValue(false);
      await expect(authorize({ username: "admin", password: "ok" })).resolves.toEqual({
        id: "homepage",
        name: "admin",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a wrong 2FA code does not advance the throttle", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    verifyPasswordMock.mockResolvedValue(true);
    isTotpEnabledMock.mockReturnValue(true);
    verifyTokenMock.mockReturnValue(false);
    const mod = await import("pages/api/auth/[...nextauth]");
    const authorize = mod.authOptions.providers[0].options.authorize;
    for (let i = 0; i < 8; i += 1) {
      expect(await authorize({ username: "admin", password: "ok", token: "000000" })).toBeNull();
    }
    // still evaluating (not blocked) — verifyPassword called every time
    expect(verifyPasswordMock).toHaveBeenCalledTimes(8);
  });

  it("throws when only partial OIDC settings are provided", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "true";
    process.env.HOMEPAGE_OIDC_ISSUER = "https://issuer.example";
    process.env.HOMEPAGE_EXTERNAL_URL = "https://homepage.example";

    await expect(import("pages/api/auth/[...nextauth]")).rejects.toThrow(
      /OIDC auth is enabled but required settings are missing/i,
    );
  });
});
