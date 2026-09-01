// Shared Host-header allow-list, used by both `src/middleware.js` (rejects
// requests whose Host header is not listed) and the NextAuth `redirect`
// callback (only lets a post-sign-in/out redirect leave for a host we already
// trust). Keeping one implementation means the two cannot drift apart.

function loopbackHosts() {
  const port = process.env.PORT || 3000;
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

// The explicitly trusted hosts: the loopback set plus every comma-separated
// entry in HOMEPAGE_ALLOWED_HOSTS. The `*` wildcard is NOT expanded here — see
// `allowAllHosts()` — so callers that must not honour `*` (the redirect
// callback) can use this set directly.
export function allowedHostSet() {
  const set = new Set(loopbackHosts());
  const raw = process.env.HOMEPAGE_ALLOWED_HOSTS;
  if (raw && raw !== "*") {
    for (const entry of raw.split(",")) {
      const host = entry.trim();
      if (host) set.add(host);
    }
  }
  return set;
}

export function allowAllHosts() {
  return process.env.HOMEPAGE_ALLOWED_HOSTS === "*";
}

// True when `host` may be served / redirected to. Honours the `*` wildcard.
export function isAllowedHost(host) {
  if (allowAllHosts()) return true;
  return Boolean(host) && allowedHostSet().has(host);
}
