import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

import { logFailedPasswordSignIn, verifyPassword } from "utils/auth/credentials";
import { ensureAuthSecret } from "utils/auth/secret";
import { verifyToken } from "utils/auth/totp";
import { isTotpEnabled } from "utils/auth/totp-store";
import { isAuthEnabled } from "utils/env";
import createLogger from "utils/logger";

const MIN_AUTH_SECRET_LENGTH = 32;

const FAIL_THRESHOLD = 5;
let consecutiveFailures = 0;
let blockedUntil = 0;

const authEnabled = isAuthEnabled();
const issuer = process.env.HOMEPAGE_OIDC_ISSUER;
const clientId = process.env.HOMEPAGE_OIDC_CLIENT_ID;
const clientSecret = process.env.HOMEPAGE_OIDC_CLIENT_SECRET;
const homepageExternalUrl = process.env.HOMEPAGE_EXTERNAL_URL;
const homepageAuthPassword = process.env.HOMEPAGE_AUTH_PASSWORD;
const homepageAuthUsername = process.env.HOMEPAGE_AUTH_USERNAME;

// Map HOMEPAGE_* envs to what NextAuth expects. The signing secret is generated and
// persisted to config/auth.json when neither NEXTAUTH_SECRET nor HOMEPAGE_AUTH_SECRET is set.
const NEXTAUTH_SECRET = authEnabled ? ensureAuthSecret() : undefined;
if (authEnabled && !process.env.NEXTAUTH_SECRET) process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET;
if (!process.env.NEXTAUTH_URL && homepageExternalUrl) {
  process.env.NEXTAUTH_URL = homepageExternalUrl;
}

const defaultScope = process.env.HOMEPAGE_OIDC_SCOPE || "openid email profile";
const cleanedIssuer = issuer ? issuer.replace(/\/+$/, "") : issuer;
const hasOidcConfig = Boolean(issuer && clientId && clientSecret);
const hasAnyOidcConfig = Boolean(issuer || clientId || clientSecret);
let parsedAuthUrl;

if (authEnabled) {
  if (process.env.NEXTAUTH_URL) {
    try {
      parsedAuthUrl = new URL(process.env.NEXTAUTH_URL);
    } catch {
      throw new Error("HOMEPAGE_EXTERNAL_URL (or NEXTAUTH_URL) must be an absolute HTTP(S) URL.");
    }

    if (
      !["http:", "https:"].includes(parsedAuthUrl.protocol) ||
      parsedAuthUrl.username ||
      parsedAuthUrl.password ||
      parsedAuthUrl.search ||
      parsedAuthUrl.hash
    ) {
      throw new Error(
        "HOMEPAGE_EXTERNAL_URL (or NEXTAUTH_URL) must be an absolute HTTP(S) URL without credentials, query, or fragment.",
      );
    }
  }

  if (hasOidcConfig && !process.env.NEXTAUTH_URL) {
    throw new Error("OIDC auth requires HOMEPAGE_EXTERNAL_URL.");
  }

  if (!hasOidcConfig && hasAnyOidcConfig) {
    throw new Error("OIDC auth is enabled but required settings are missing.");
  }

  // Safety net: ensureAuthSecret() always returns a value, so this should never fire.
  if (!NEXTAUTH_SECRET) {
    throw new Error("Homepage auth is enabled but no signing secret could be determined.");
  }

  if (NEXTAUTH_SECRET.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `HOMEPAGE_AUTH_SECRET (or NEXTAUTH_SECRET) must be at least ${MIN_AUTH_SECRET_LENGTH} characters. Generate one with: openssl rand -base64 32`,
    );
  }

  if (Boolean(homepageAuthUsername) !== Boolean(homepageAuthPassword)) {
    createLogger("nextauth").warn(
      "HOMEPAGE_AUTH_USERNAME / HOMEPAGE_AUTH_PASSWORD: one is set without the other — " +
        "ignoring both; using stored / default credentials",
    );
  }
}

let providers = [];
if (authEnabled) {
  if (hasOidcConfig) {
    providers = [
      {
        id: "homepage-oidc",
        name: process.env.HOMEPAGE_OIDC_NAME || "Homepage OIDC",
        type: "oauth",
        idToken: true,
        checks: ["pkce", "state", "nonce"],
        issuer: cleanedIssuer,
        wellKnown: `${cleanedIssuer}/.well-known/openid-configuration`,
        clientId,
        clientSecret,
        authorization: {
          params: {
            scope: defaultScope,
          },
        },
        profile(profile) {
          return {
            id: profile.sub ?? profile.id ?? profile.user_id ?? profile.uid ?? profile.email,
            name: profile.name ?? profile.preferred_username ?? profile.nickname ?? profile.email,
            email: profile.email ?? null,
            image: profile.picture ?? null,
          };
        },
      },
    ];
  } else {
    providers = [
      CredentialsProvider({
        name: "Password",
        credentials: {
          username: { label: "Username", type: "text" },
          password: { label: "Password", type: "password" },
          token: { label: "Authentication code", type: "text" },
        },
        async authorize(credentials) {
          if (Date.now() < blockedUntil) return null;
          const { username, password, token } = credentials ?? {};

          if (!(await verifyPassword(username, password))) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= FAIL_THRESHOLD) {
              const over = consecutiveFailures - FAIL_THRESHOLD;
              blockedUntil = Date.now() + Math.min(1000 * 2 ** over, 30_000);
            }
            logFailedPasswordSignIn();
            return null;
          }
          if (isTotpEnabled() && !verifyToken(token)) {
            logFailedPasswordSignIn();
            return null;
          }
          consecutiveFailures = 0;
          blockedUntil = 0;
          return { id: "homepage", name: username };
        },
      }),
    ];
  }
}

export const authOptions = {
  providers,
  session: {
    strategy: "jwt",
  },
  secret: NEXTAUTH_SECRET,
  useSecureCookies: parsedAuthUrl?.protocol === "https:",
  pages: {
    signIn: "/auth/signin",
  },
  logger: {
    error: (code) => createLogger("nextauth").error("%s", code),
    warn: (code) => createLogger("nextauth").warn("%s", code),
    debug: (code) => createLogger("nextauth").debug("%s", code),
  },
  events: {
    signIn: async ({ account }) =>
      createLogger("nextauth").debug("Sign in via provider '%s'", account?.provider ?? "unknown"),
    signOut: async () => createLogger("nextauth").debug("Sign out"),
  },
};

const nextAuthHandler = NextAuth(authOptions);

export default async function handler(req, res) {
  // Just pass empty session if auth not enabled
  if (!authEnabled) {
    return res.status(200).json({});
  }

  return nextAuthHandler(req, res);
}
