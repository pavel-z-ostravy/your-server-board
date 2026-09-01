import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";

import { allowAllHosts, allowedHostSet } from "utils/auth/allowed-hosts";
import { ensureAuthSecret } from "utils/auth/secret";
import { isAuthEnabled } from "utils/env";

const authEnabled = isAuthEnabled();
if (!process.env.NEXTAUTH_URL && process.env.HOMEPAGE_EXTERNAL_URL) {
  process.env.NEXTAUTH_URL = process.env.HOMEPAGE_EXTERNAL_URL;
}
const authSecret = authEnabled ? ensureAuthSecret() : undefined;

// Prerendered pages carry `s-maxage`, and the dashboard HTML embeds the service and
// bookmark inventory. Without this, a CDN or caching reverse proxy in front of Homepage
// would store an authenticated response and serve it to anonymous visitors.
function withPrivateCache(res) {
  if (authEnabled) {
    res.headers.set("Cache-Control", "private, no-store");
  }
  return res;
}

export async function middleware(req) {
  // Check the Host header against the shared allow-list (loopback + every
  // HOMEPAGE_ALLOWED_HOSTS entry, or `*` for any).
  const host = req.headers.get("host");
  if (!allowAllHosts() && (!host || !allowedHostSet().has(host))) {
    console.error(
      `Host validation failed for: ${host}. Hint: Set the HOMEPAGE_ALLOWED_HOSTS environment variable to allow requests from this host / port.`,
    );
    return NextResponse.json({ error: "Host validation failed. See logs for more details." }, { status: 400 });
  }

  const pathname = new URL(req.url).pathname;
  if (authEnabled && !pathname.startsWith("/api/healthcheck")) {
    // The MCP API handler authorizes both bearer tokens and Homepage sessions.
    if (pathname === "/api/mcp") {
      return withPrivateCache(NextResponse.next());
    }

    const token = await getToken({ req, secret: authSecret });
    if (!token) {
      // JSON API routes expect a JSON body they can parse - a redirect to an HTML signin
      // page just breaks their `res.json()` call. Pages still get redirected to signin.
      if (pathname.startsWith("/api/")) {
        return withPrivateCache(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
      }

      const signInUrl = new URL("/auth/signin", req.url);
      signInUrl.searchParams.set("callbackUrl", "/");
      return withPrivateCache(NextResponse.redirect(signInUrl));
    }
  }

  return withPrivateCache(NextResponse.next());
}

export const config = {
  // Task 0 ruling: middleware.js compiles to the Edge runtime by default in Next 16, which
  // cannot use node:fs — force Node so ensureAuthSecret() can read config/auth.json.
  runtime: "nodejs",
  // Protect all app and API routes; allow Next.js internals, public assets, auth pages, and NextAuth endpoints.
  matcher: [
    "/",
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|manifest.json|sitemap.xml|icons/|api/auth|auth/).*)",
  ],
};
