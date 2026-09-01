# Default admin + in-app credential & 2FA wizard — design

**Date:** 2026-09-01 (rev. 6)
**Status:** Draft for review
**Builds on:** `docs/superpowers/specs/2026-08-31-dashboard-2fa-login-design.md` (username + password + TOTP 2FA, shipped on `dev`)

## Summary

Today: auth is opt-in (`HOMEPAGE_AUTH_ENABLED=true`); credentials come **only** from
`HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD` (startup throws without them);
TOTP is enrolled on `/security`.

This change:

- **Login is on by default.** `isAuthEnabled()` is true unless `HOMEPAGE_AUTH_ENABLED=false`.
- **A first-run bootstrap** (`instrumentation.js` `register()`) makes sure
  `config/auth.json` has a NextAuth signing secret **and** an initial account
  **`admin` / `admin`**, and logs a reminder once. No env vars, no startup crash.
- **Credentials are editable in-app** and persist to `config/auth.json`
  (password scrypt-hashed). `HOMEPAGE_AUTH_USERNAME` + `HOMEPAGE_AUTH_PASSWORD`,
  when both set, remain an override that locks the in-app editor.
- **A persistent warning banner** shows on every page until the password is
  changed away from the default.
- **A two-step wizard on `/security`**: step 1 changes username + password
  (verifying the current password); step 2 optionally sets up 2FA.
- **`/api/auth/2fa-check` is deleted.** For a single user, "is 2FA enabled" is a
  global fact the sign-in page reads in `getServerSideProps`, so no
  unauthenticated endpoint verifies a password. `authorize()` is the only
  credential chokepoint and gains a **progressive-delay brute-force throttle**.
- **OIDC mode is unchanged** and, when active, suppresses the bootstrap account,
  the banner, and the wizard.

### Next 16: middleware runs on the Node.js runtime

Verified against the installed docs
(`node_modules/next/dist/docs/.../proxy.md`): *"v16.0.0 — Middleware is
deprecated and renamed to Proxy. Proxy defaults to the Node.js runtime"* and
*"The `runtime` config option is not available in Proxy files"*. The current
`src/middleware.js` (kept as the deprecated alias for `proxy.js`, functionally
identical) therefore runs on **Node.js** in this project's Next 16.3.0 — it can
`readFileSync`.

That collapses the whole "how does the secret reach the Edge sandbox" problem
from earlier drafts. **`config/auth.json` is the single source of truth for the
signing secret; middleware, the NextAuth route, and `instrumentation.js` all read
it directly** via one shared helper. No `spawn` wrapper, no `--print-secret`, no
`.env.local`, no entrypoint changes, no `.mjs` gymnastics.

### Default credentials `admin` / `admin` — the exposure this accepts

Decided by the project owner. "Always-on login" means every deployment that
upgrades gets a login gate immediately; a literal `admin` / `admin` default is
online-guessable. On a deployment reachable from the internet (reverse proxy /
Cloudflare tunnel — the reference `YSB_ALLOWED_HOSTS` includes one) the window
between first start and changing the credentials is a real exposure.

Mitigations the design carries:

- The `authorize()` brute-force throttle (below).
- The non-dismissible red banner on every page until the password is changed.
- `docs/installation/index.md` prominent callout: **change the credentials
  before exposing the dashboard publicly, or pin them with
  `HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD`.**
- `HOMEPAGE_AUTH_ENABLED=false` for a trusted-LAN-only deployment that wants no
  login at all.

Recovery if the changed password is forgotten: `rm config/auth.json` (or delete
just the `user` key) and restart — first run recreates `admin` / `admin`.

### Breaking changes

1. Any deployment that did **not** set `HOMEPAGE_AUTH_ENABLED` now shows a login
   screen. To keep no login: `HOMEPAGE_AUTH_ENABLED=false`.
2. `src/pages/api/mcp/index.js` gates its session check on `isAuthEnabled()`;
   with auth default-on, MCP now requires a bearer token **or** a session unless
   `HOMEPAGE_AUTH_ENABLED=false`. The `HOMEPAGE_MCP_TOKEN` path is unaffected.

Both go in the changelog, `README.md`, and `docs/installation/index.md`.

## Goals / non-goals

**Goals**
- Zero-config, secure-by-default: a fresh deployment has a login gate the
  operator is pushed to secure.
- Credentials changeable without env / redeploy; sessions survive restarts.
- One flow to change credentials and (optionally) enable 2FA.
- No regression to OIDC mode or to env-driven credential management.
- Verified end-to-end with a real run before merge.

**Non-goals**
- Multiple users / roles.
- Password reset via email; 2FA recovery codes (unchanged: delete `config/auth.json`).
- Distributed / per-IP rate limiting (the in-app throttle is global + in-memory;
  reverse-proxy + fail2ban stay the recommendation for internet-exposed setups).
- Renaming `middleware.js` → `proxy.js` (Next 16 deprecation; separate task).
- Argon2 (needs a native dep; scrypt is built in and sufficient).

## Plan task 0 — spike (~2 h, before any other task)

One load-bearing unknown: **confirm `src/middleware.js` on this Next 16.3.0 build
runs on the Node.js runtime and can `readFileSync`.** The docs say yes; verify by
adding `import { readFileSync } from "node:fs"` + a real `readFileSync` call at
middleware module scope, running `pnpm build && pnpm start`, and hitting a
protected route. If it fails (Edge after all), fall back to: require
`HOMEPAGE_AUTH_SECRET` in the environment (documented), keep `instrumentation.js`
generating it into `config/auth.json` for the routes, and have the Docker
entrypoint `export` it from the file — i.e. resurrect the rev-5 secret plumbing
for middleware only.

Also confirm `instrumentation.js` `register()` runs (and can throw to fail
startup) for this pages-router standalone build.

## Current state (post-2026-08-31 merge, verified against `dev`)

- `next@16.3.0`, `output: "standalone"`, no `instrumentation` file.
- **Middleware runtime: Node.js** (Next 16 default for middleware/proxy; the
  `runtime` config option is rejected). `src/middleware.js` currently imports
  only `next-auth/jwt`, `next/server`, `utils/env` — all Node-and-Edge safe; it
  emits the "middleware is deprecated, use proxy" warning at dev start.
- `Dockerfile`: two stages `builder` / `runner` (`node:22-slim` → `node:22-alpine`).
  `runner` copies `/app/.next/standalone/` and `/app/.next/static/` with
  `--link --chown=1000:1000`. `ENTRYPOINT ["docker-entrypoint.sh"]`,
  `CMD ["node", "server.js"]`, `ENV NODE_ENV=production PORT=3000 HOSTNAME=::`,
  runs as root then `exec su-exec $PUID:$PGID "$@"`. `docker-entrypoint.sh`
  `chown -R "$PUID:$PGID" /app/config` (~line 33) before the `su-exec`.
- `.gitignore` already ignores `.env*.local` and `config/auth.json`.
- `src/utils/env.js` — `isAuthEnabled()` = `process.env.HOMEPAGE_AUTH_ENABLED === "true"`.
- `src/utils/auth/credentials.js` — **sync** `verifyPassword(u,p)` reads the two
  env vars, `sha256`+`timingSafeEqual` (hash-first so length never throws),
  `false` if unset/non-string; `logFailedPasswordSignIn()` →
  `createLogger("nextauth").warn("Failed password sign-in attempt")`.
- `src/utils/auth/totp-store.js` — reads/writes `config/auth.json`
  (`{ totp: { secret, enabledAt } }`), `writeFileSync {mode:0o600}` + `chmodSync`,
  corrupt file → `{}` + warn. `readTotpState` / `writeTotpState` /
  `clearTotpState` / `isTotpEnabled`.
- `src/utils/auth/totp.js` — `generateEnrollment` / `qrDataUrl` / **sync**
  `verifyToken` (`authenticator.options = { window: 1 }`).
- `src/utils/auth/mode.js` — `passwordAuthActive()` =
  `isAuthEnabled() && !hasOidcConfig && Boolean(HOMEPAGE_AUTH_PASSWORD)`.
- `src/pages/api/auth/[...nextauth].js` — module-load validation **throws**
  without `NEXTAUTH_URL`, without a ≥32-char secret, and (password mode) without
  username+password+secret. `NEXTAUTH_SECRET`/`NEXTAUTH_URL` are mapped from
  `HOMEPAGE_AUTH_SECRET`/`HOMEPAGE_EXTERNAL_URL` at the top. `authorize({username,
  password,token})` → `verifyPassword` then (if `isTotpEnabled()`) `verifyToken`.
  `useSecureCookies: parsedAuthUrl?.protocol === "https:"`. `session.strategy = "jwt"`.
- `src/pages/api/auth/2fa-check.js` — `404` when `!passwordAuthActive()`, else a
  password pre-check; `signin.jsx` step 1 `fetch`es it. **All deleted here.**
- `src/pages/auth/signin.jsx` — two visual steps; `getServerSideProps` returns
  `getProviders()` output + a whitelist of public settings; the component
  sanitizes `router.query.callbackUrl` to a `/`-relative path and
  `window.location.assign`es it after `signIn(..., { redirect:false })`.
- `src/pages/api/security/totp/{enroll,confirm,disable}.js` — session-guarded
  (middleware + defensive `getServerSession`).
- `src/pages/security.jsx` — one card; `passwordAuthEnabled` prop; phases
  `idle | enrolling | disabling`; a single `error` / `busy` state; error `<p>`
  has `role="alert"`.
- `src/middleware.js` — `const authEnabled = isAuthEnabled();` and
  `const authSecret = process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET;`
  at module load; when `authEnabled` and no token → redirect `/auth/signin`
  (pages) / `401 {error:"Unauthorized"}` (`/api/`). Host-header check runs first,
  unconditionally. Matcher exempts `_next/*`, static, `api/auth`, `auth/`.
- `src/pages/_app.jsx` — `<SessionProvider>` → `<SWRConfig value={{fetcher: (r,i)
  => fetch(r,i).then(x => x.json())}}>` → Color/Theme/Settings/Tab providers →
  `<NavHeader />` + `<Component />`.
- `src/components/layout/NavHeader.jsx` — `NAV_ITEMS` includes
  `{ href:"/security", label:"Security", icon:BiLockAlt }`.
- `src/pages/api/mcp/index.js` — `hasHomepageSession()` returns `false` when `!isAuthEnabled()`.
- Deploy: Docker on lxc200, `/opt/stacks/your-server-board`, `./config` volume →
  `/app/config`, `YSB_ALLOWED_HOSTS=10.0.1.104:3050,dashboard.vault1922.xyz`.

## Architecture

### `config/auth.json` — one file

```json
{
  "secret": "<base64url, 43 chars — present only when auto-generated; env HOMEPAGE_AUTH_SECRET wins and is not copied here>",
  "user": { "username": "admin", "passwordHash": "scrypt$16384$8$1$<saltB64>$<hashB64>", "updatedAt": "2026-09-01T…Z" },
  "totp":  { "secret": "<base32>", "enabledAt": "2026-09-01T…Z" }
}
```

- Any of `secret` / `user` / `totp` may be absent.
- **A `user` with no `passwordHash` means the default `admin` / `admin`** — the
  bootstrap writes `{ "username": "admin" }`; the wizard's `writeUser` adds the
  hash. No separate `mustChange` flag: "has a `passwordHash`" *is* the "has been
  changed" signal.
- **`src/utils/auth/auth-file.js`** — the single file layer, `node:fs` /
  `node:path` only, **no imports from `src/`** (so it stays cheap to pull into
  the middleware bundle). It inlines the config dir:
  `process.env.HOMEPAGE_CONFIG_DIR || join(process.cwd(), "config")` — 1 line,
  kept in sync with `CONF_DIR` in `utils/config/config.js` (comment on both).
  - `readAuthFile()` → parsed object. **Cached**: module-level `{ value, at }`;
    re-reads from disk only when older than 5 s (safety net for hand edits /
    other replicas). Corrupt/unreadable → `{}` + a one-time `console.warn`
    (stderr).
  - `writeAuthFile(patch)` → **fully synchronous** (`readFileSync` +
    `writeFileSync` + `chmodSync`, no `await` inside) → atomic w.r.t. other JS in
    the process. Reads the file **fresh from disk** (not the cache), merges
    `next = { ...current, ...patch }`, then `delete next[k]` for every key with
    `patch[k] === undefined` (a writer removes a section without touching the
    rest), writes `{ mode: 0o600 }`, `chmodSync(path, 0o600)`, updates the cache
    to `next`. Slow work (`await hashPassword(...)`) happens in callers *before*
    the call.
- `totp-store.js` becomes thin wrappers over `auth-file`:
  - `readTotpState()` → `readAuthFile()`; `isTotpEnabled()` unchanged.
  - `writeTotpState(state)` → `writeAuthFile({ totp: state.totp })`.
  - **`clearTotpState()` → `writeAuthFile({ totp: undefined })`** — deletes only
    `totp`. **Bug fixed:** today `clearTotpState()` = `writeTotpState({})` rewrites
    the whole file as `{}` (harmless with only `totp`, but would wipe
    `secret`+`user`). `totp-store.test.js`'s "`clearTotpState` leaves `{}`"
    assertion is reworked to "leaves `secret`/`user`, drops `totp`".

### `src/utils/auth/password-hash.js`

`node:crypto` builtins only; promisified `scrypt`, `N=16384, r=8, p=1` (memory
≈ 16 MiB < Node's 32 MiB `maxmem` default), 64-byte output:

- `async hashPassword(pw)` → `salt = randomBytes(16)`; `key = await scrypt(pw,
  salt, 64, { N, r, p })`; return `scrypt$16384$8$1$<salt b64>$<key b64>`.
- `async verifyHash(pw, stored)` → parse format; recompute; `timingSafeEqual`.
  Unknown / truncated / empty `stored` → `false`. Never throws.

### `src/utils/auth/secret.js`

`node:crypto` + `auth-file` only.

- `ensureAuthSecret()` (sync) → `process.env.NEXTAUTH_SECRET ||
  process.env.HOMEPAGE_AUTH_SECRET || readAuthFile().secret`; if none, generate
  `randomBytes(32).toString("base64url")` (43 url-safe chars, no `+/=`),
  `writeAuthFile({ secret })`, return it. If the write throws (read-only
  `config/`), return the in-memory value + `console.warn` "secret not persisted;
  set HOMEPAGE_AUTH_SECRET or make config/ writable — sessions won't survive a
  restart".
- Called at module load by `src/middleware.js`, `src/pages/api/auth/[...nextauth].js`,
  and `src/instrumentation.js`. Node module init is sequential within a process
  → whichever loads first generates + persists, the rest read it back. A
  multi-*process* first-boot race is a microsecond window and is closed by
  setting `HOMEPAGE_AUTH_SECRET` (documented for multi-replica).

### `src/utils/auth/credentials-store.js`

`auth-file` + `password-hash` only.

- `managedByEnv()` = `Boolean(process.env.HOMEPAGE_AUTH_USERNAME && process.env.HOMEPAGE_AUTH_PASSWORD)`.
- `readUser()` = `readAuthFile().user ?? null`.
- `usingDefaultCredentials()` = `!managedByEnv() && !!readUser() && !readUser().passwordHash`.
- `currentUsername()` = `managedByEnv() ? process.env.HOMEPAGE_AUTH_USERNAME :
  (readUser()?.username ?? "admin")` — aligned with `verifyPassword`'s branch
  selection.
- `async writeUser({ username, password })` → `const passwordHash = await
  hashPassword(password)` **then** `writeAuthFile({ user: { username,
  passwordHash, updatedAt: new Date().toISOString() } })`.
- `async ensureInitialUser()` (used by `instrumentation.js`):
  - `!isAuthEnabled()` → `{ created: false, reason: "disabled" }` (no user, no log box).
  - `managedByEnv()` → `{ reason: "env" }`.
  - `hasOidcConfig()` → `{ reason: "oidc" }`.
  - `readAuthFile().user` → `{ reason: "exists" }`.
  - else `writeAuthFile({ user: { username: "admin" } })` → `{ created: true }`.
    If the write throws → `{ created: false, reason: "readonly" }`.
  (`isAuthEnabled` / `hasOidcConfig` imported from `env.js` / `mode.js`.)

### Credential resolution — `verifyPassword` (now async)

`async verifyPassword(username, password): Promise<boolean>` — checks in order,
**no fall-through**:

1. **Env override** — `managedByEnv()` → hash-first constant-time compare of
   username *and* password against the env values (today's `sha256` path).
2. **Stored user** — else `readAuthFile().user` present:
   - `user.passwordHash` present → compute **both** without short-circuiting:
     `usernameOk = constEq(username, user.username)` and `passwordOk = await
     verifyHash(password, user.passwordHash)`; `return usernameOk && passwordOk`.
   - no `passwordHash` (default) → hash-first constant-time compare of `username`
     vs `user.username` **and** `password` vs `"admin"`.
3. Neither → `false`.

`constEq` is the existing hash-first helper (never throws on length). Non-string
input → `false`; never throws. Callers `authorize` and the new
`/api/security/credentials` route `await` it.

### `src/instrumentation.js` (new)

```js
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureAuthSecret } = await import("./utils/auth/secret");
  const { ensureInitialUser } = await import("./utils/auth/credentials-store");
  if (process.env.HOMEPAGE_AUTH_ENABLED !== "false") ensureAuthSecret();
  const init = await ensureInitialUser();
  if (init.created) {
    process.stderr.write(
      "\n┌─ Login enabled with default credentials ─────\n" +
      "│  username: admin\n" +
      "│  password: admin\n" +
      "│  Change them now at /security — do not expose\n" +
      "│  this dashboard publicly until you have.\n" +
      "└─────────────────────────────────────────────\n\n",
    );
  }
  if (init.reason === "readonly") {
    throw new Error(
      "config/ is not writable and no HOMEPAGE_AUTH_USERNAME / HOMEPAGE_AUTH_PASSWORD " +
      "is set — cannot create a login. Make config/ writable or set the env vars.",
    );
  }
}
```

- `instrumentation` is **stable since Next 15** — no `experimental` flag.
  `register()` runs once, before the server accepts requests; a throw surfaces
  as a startup error. Traced into `output: "standalone"`. Located at
  `src/instrumentation.js` because this project uses `src/`.
- Dynamic `import()` (not top-level) so the Edge invocation of `register()`
  never even loads the `node:fs` modules.
- It runs as the **app user** inside the container (post-`su-exec`), in an
  already-chowned `/app/config` → it can create `auth.json`. **No entrypoint
  change, no root-writes, no `scripts/` directory.**

### `src/utils/env.js` / `src/utils/auth/mode.js`

- `isAuthEnabled()` → `process.env.HOMEPAGE_AUTH_ENABLED !== "false"`. Only the
  exact string `"false"` disables.
- `mode.js` **extracts and exports `hasOidcConfig()`** (`Boolean(issuer &&
  clientId && clientSecret)`, reading env at call time) — used by both
  `passwordAuthActive()` and `credentials-store.ensureInitialUser()`.
- `passwordAuthActive()` → `isAuthEnabled() && !hasOidcConfig()` (drop the
  `HOMEPAGE_AUTH_PASSWORD` clause — a password source always exists now).

### `src/middleware.js`

- `const authEnabled = isAuthEnabled();` — unchanged in form, now default-true.
- `const authSecret = ensureAuthSecret();` (import from `utils/auth/secret`) —
  replaces the `process.env.NEXTAUTH_SECRET || …` line. Node runtime, `fs` fine.
- Everything else — matcher, host check, redirect/401 logic — unchanged.

### `src/pages/api/auth/[...nextauth].js`

- `const NEXTAUTH_SECRET = ensureAuthSecret();` near the top; use it for
  `authOptions.secret` and drop the old `HOMEPAGE_AUTH_SECRET → NEXTAUTH_SECRET`
  env mapping (the helper covers env + file).
- `NEXTAUTH_URL` mapping from `HOMEPAGE_EXTERNAL_URL` unchanged.
- In `if (authEnabled)`:
  - Parse + validate the URL **only when `process.env.NEXTAUTH_URL` is set**
    (keep the "absolute http(s), no creds/query/fragment" throw for a provided URL).
  - Keep `if (hasOidcConfig && !process.env.NEXTAUTH_URL) throw` ("OIDC requires
    HOMEPAGE_EXTERNAL_URL").
  - Password branch: drop `!homepageAuthPassword || !homepageAuthUsername` from
    the throw (bootstrap / env override cover credentials). Keep the ≥32-char
    check on `NEXTAUTH_SECRET` (a generated one is 43 base64url chars).
  - **Partial env** (`HOMEPAGE_AUTH_USERNAME` xor `HOMEPAGE_AUTH_PASSWORD`) →
    a startup `warn` "one of HOMEPAGE_AUTH_USERNAME / HOMEPAGE_AUTH_PASSWORD is
    set without the other — ignoring both; using stored / default credentials",
    then proceed (`managedByEnv()` is already `false`, so it falls through
    cleanly). No throw — a half-set env should not brick the login.
- `useSecureCookies: parsedAuthUrl?.protocol === "https:"` — **unchanged**
  (already shipped). `false` when no URL → plain-http LAN cookies work; `true`
  when `HOMEPAGE_EXTERNAL_URL` is https → `__Secure-` prefix. `getToken` in
  middleware derives the same expectation from `NEXTAUTH_URL`, so the two agree.
  (next-auth v4 keys `useSecureCookies` off the URL protocol, not `NODE_ENV`;
  the explicit setting just removes any ambiguity when `NEXTAUTH_URL` is unset.)
- `authorize` — `await verifyPassword(...)` **and a progressive-delay
  brute-force throttle** (module scope):

  ```js
  const FAIL_THRESHOLD = 5;
  let consecutiveFailures = 0;
  let blockedUntil = 0;

  async authorize(credentials) {
    if (Date.now() < blockedUntil) { logFailedPasswordSignIn(); return null; }
    const { username, password, token } = credentials ?? {};

    if (!(await verifyPassword(username, password))) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= FAIL_THRESHOLD) {
        const over = consecutiveFailures - FAIL_THRESHOLD;              // 0,1,2,…
        blockedUntil = Date.now() + Math.min(1000 * 2 ** over, 30_000); // 1s…30s
      }
      logFailedPasswordSignIn();
      return null;
    }
    if (isTotpEnabled() && !verifyToken(token)) {
      logFailedPasswordSignIn();                // wrong 2FA code — NOT a password
      return null;                              // brute-force; counter untouched
    }
    consecutiveFailures = 0;
    blockedUntil = 0;
    return { id: "homepage", name: username };
  }
  ```

  Global (single-user), in-memory, resets on a fully-successful sign-in.
  Rejects immediately while blocked (no held connection). Topology-independent —
  no `X-Forwarded-For` / client-IP trust. 5th consecutive wrong password → 1 s
  block, doubling to a 30 s cap. A legitimate user who mistypes waits a few
  seconds and sees the generic "invalid" error.

### Delete `/api/auth/2fa-check`; move the flag into the sign-in page

- **Delete** `src/pages/api/auth/2fa-check.js` and its test.
- `src/pages/auth/signin.jsx` `getServerSideProps` adds
  `twoFactorEnabled: passwordAuthActive() ? isTotpEnabled() : false` (one cached
  file read; it already reads settings).
- `signin.jsx` form, driven only by that prop — **no client fetch**:
  - `twoFactorEnabled === false` → single step (username + password) →
    `signIn("credentials", { redirect:false, username, password })`.
  - `twoFactorEnabled === true` → step 1 (username + password), "Continue"
    reveals step 2 (6-digit field), submit → `signIn("credentials", {
    redirect:false, username, password, token })`.
  - The old pre-check `fetch` and its step-1 "Invalid username or password" go
    away. Errors come from `signIn`'s `{ ok, error }`: a failed `signIn` shows
    "Invalid username or password" (2FA off) or "Invalid username, password, or
    code" (2FA on). Sanitized-`callbackUrl` + `window.location.assign` on
    success unchanged.
- Net: **no unauthenticated endpoint verifies a password.** `authorize()` (with
  its throttle) is the single chokepoint. `twoFactorEnabled` is visible to
  anyone who loads `/auth/signin` — a config fact, arguably a deterrent.

### `src/pages/api/security/credentials.js` (new)

- `POST` only → `405`. Session required (middleware + defensive `getServerSession` → `401`).
- `managedByEnv()` → `409 { error: "Credentials are managed by environment variables." }`.
- Body `{ currentPassword, username, password }`.
- `!(await verifyPassword(currentUsername(), currentPassword))` →
  `400 { error: "Current password is incorrect." }` + `logFailedPasswordSignIn()`.
- Validation → `400 { error: <specific> }`: `password.length < 8` → "Password
  must be at least 8 characters."; `username.trim()` not `/^[A-Za-z0-9._-]{1,64}$/`
  → "Username may only contain letters, digits, dots, underscores and dashes."
- Success → `await writeUser({ username: username.trim(), password })` →
  `200 { username }`. Write failure → `500` + `createLogger("auth").error(...)`.
- (No throttle here — it is session-gated, so the exposure is a stolen session,
  which is already a full compromise. It still logs failed attempts for fail2ban.)

### `src/pages/api/security/credentials-status.js` (new)

- `GET` only → `405`. Session required → `401`.
- `200 { usingDefaultCredentials, managedByEnv, username: currentUsername() }`.

### `src/components/layout/CredentialsWarning.jsx` (new)

- `const { status } = useSession();`
- `const { data } = useSWR(status === "authenticated" ? "/api/security/credentials-status" : null);`
  — conditional key: no request unless authenticated (so none when auth is off).
- Render `null` unless `data?.usingDefaultCredentials`.
- Otherwise a full-width bar: `role="alert"`, `bg-red-600 text-white text-sm`,
  `px-4 py-2 pl-14 sm:pl-16` (left padding clears the absolutely-positioned nav
  hamburger). Text: **"You're signed in with the default admin / admin
  credentials — anyone who can reach this page can log in."** +
  `<Link href="/security" className="underline font-medium">` **"Change them
  now"**. Not dismissible.
- In `_app.jsx` immediately after `<NavHeader />`, before `<Component />` (inside
  `SessionProvider` + `SWRConfig`). Known minor: a one-frame layout shift while
  `useSession` resolves — acceptable for a security nag.

### `src/pages/security.jsx`

`getServerSideProps` adds `managedByEnv` and `currentUsername` (alongside
`passwordAuthEnabled`, `twoFactorEnabled`).

New **Account** card above the existing 2FA card, **with its own state**
(`wizardStep: "summary" | "credentials" | "twofa"`, `wizardError`, `wizardBusy`,
`wizardEnrollment`, `wizardCode`) — does **not** touch the 2FA card's
`phase`/`error`/`busy`:

- **summary:** "Signed in as **`<currentUsername>`**." `managedByEnv` →
  "Credentials are managed by `HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD`."
  and no button. Else a **"Change username & password"** button → `credentials`.
- **credentials:** `Current password`, `New username` (default = `currentUsername`),
  `New password`, `Confirm new password`. Client checks `password === confirm`
  before POST. Submit → `POST /api/security/credentials`. `400`/`409`/`500` →
  inline `wizardError`. `200` → update the displayed username; `import { mutate }
  from "swr"` then `mutate("/api/security/credentials-status")` (the banner
  shares that key → it re-fetches and disappears); then → `twofa` (or straight
  to `summary` if `twoFactorEnabled` is already true).
- **twofa:** "Add two-factor authentication?" + **"Set up 2FA"** / **"Not now"**.
  "Not now" → `summary`. "Set up 2FA" → `POST /api/security/totp/enroll`, show QR
  + secret + a 6-digit field (same `CODE_INPUT_PROPS`), **"Confirm"** → `POST
  /api/security/totp/confirm { secret, token }` → `400` "Invalid code, try
  again." / `200` → `summary`.
- **State coupling:** lift the 2FA card's `enabled` boolean to the page component
  (init from the `twoFactorEnabled` prop). Wizard confirm and the standalone
  card's enable/disable call the same `setEnabled`. No `router.replace` / SSR
  re-fetch. The 2FA card keeps its own `phase`/`error`/`busy`.

### `src/pages/api/mcp/index.js`

No code change — the session-now-required shift is intentional (breaking change #2),
covered by a changelog note + test updates.

### `docker-compose.yml` / `.env.example`

`docker-compose.yml` `environment:` gains, all optional:

```yaml
      - HOMEPAGE_AUTH_ENABLED=${YSB_AUTH_ENABLED:-}
      - HOMEPAGE_EXTERNAL_URL=${YSB_EXTERNAL_URL:-}
      - HOMEPAGE_AUTH_SECRET=${YSB_AUTH_SECRET:-}
      - HOMEPAGE_AUTH_USERNAME=${YSB_AUTH_USERNAME:-}
      - HOMEPAGE_AUTH_PASSWORD=${YSB_AUTH_PASSWORD:-}
      - HOMEPAGE_OIDC_ISSUER=${YSB_OIDC_ISSUER:-}
      - HOMEPAGE_OIDC_CLIENT_ID=${YSB_OIDC_CLIENT_ID:-}
      - HOMEPAGE_OIDC_CLIENT_SECRET=${YSB_OIDC_CLIENT_SECRET:-}
      - HOMEPAGE_OIDC_NAME=${YSB_OIDC_NAME:-}
      - HOMEPAGE_OIDC_SCOPE=${YSB_OIDC_SCOPE:-}
```

`${VAR:-}` sets the container var to an **empty string** when unset. Every
consumer uses truthiness (`Boolean(x)` / `if (!x)`), never `x !== undefined` —
audit `[...nextauth].js`, `mode.js`, `credentials.js`, `credentials-store.js`,
`secret.js`, `env.js` (all already truthiness). One test asserts empty-string
env vars behave as unset. `.env.example` documents every `YSB_*` knob and the
default-on behaviour.

**No `Dockerfile` change, no `package.json` script change, no
`docker-entrypoint.sh` change** — `instrumentation.js` handles bootstrap
in-process, and `secret.js` / `credentials-store.js` / `auth-file.js` /
`password-hash.js` are all traced into `output: "standalone"` (imported by the
NextAuth route, the security routes, *and* now middleware).

## Data flow

```
Fresh Docker deploy, nothing configured:
  entrypoint → chown /app/config → su-exec node server.js
  instrumentation.register() (nodejs runtime)
      ensureAuthSecret()   → generate randomBytes(32) → writeAuthFile({secret})
      ensureInitialUser()  → writeAuthFile({user:{username:"admin"}})   (no hash)
      stderr: "username: admin / password: admin — change at /security"
  middleware module load → ensureAuthSecret() → reads config/auth.json .secret
  [...nextauth] load     → ensureAuthSecret() → same value
  GET /  → middleware: no token → redirect /auth/signin
  GET /auth/signin → getServerSideProps: twoFactorEnabled = isTotpEnabled() = false
         → single-step form → signIn("credentials",{redirect:false,admin,admin})
         → authorize → throttle ok → verifyPassword: env? no. user w/ hash? no.
                                     user w/o hash → compare "admin"/"admin" ok
                     → JWT signed with the same secret
  GET /  → middleware getToken(secret) → ok
         → CredentialsWarning SWR /api/security/credentials-status
                → {usingDefaultCredentials:true}  (user exists, no passwordHash)
                → red banner

Change credentials:
  /security → Account card → credentials step
  POST /api/security/credentials {currentPassword:"admin", username:"pavel", password:"<8+>"}
      → verifyPassword("admin","admin") ok → writeUser (adds passwordHash) → 200
      → mutate(credentials-status) → {usingDefaultCredentials:false} → banner gone
      → twofa step → Set up 2FA → enroll → confirm → totp saved
  next sign-in: verifyPassword → stored-user branch WITH hash (username "pavel"); 2FA code required
```

## Error handling

| Situation | Behaviour |
|-----------|-----------|
| Fresh start, `config/` writable | `instrumentation` generates + persists secret + user; middleware & routes read the file |
| `config/` read-only, no env creds/secret | `instrumentation.register()` throws → server does not start (there would be no way to log in) |
| `config/` read-only, full `HOMEPAGE_AUTH_USERNAME`/`PASSWORD`/`SECRET` | `ensureInitialUser` → `reason:"env"`, `ensureAuthSecret` → env value → starts normally |
| Multi-replica, **shared** `config/` volume | First to init persists `secret`; the rest read it → consistent |
| Multi-replica, **unshared** volumes | Each may generate its own → sessions bounce. Documented: set `HOMEPAGE_AUTH_SECRET` |
| `config/auth.json` corrupt | `readAuthFile()` → `{}` + warn; next `writeAuthFile` overwrites |
| `config/auth.json` cache staleness (other replica changed a password) | ≤ 5 s window where the old password still verifies. Acceptable for homelab; documented |
| `HOMEPAGE_AUTH_ENABLED=false` | No gate, no banner, no bootstrap user, `/security` → "authentication disabled" state, MCP session check off |
| OIDC configured, no `HOMEPAGE_EXTERNAL_URL` | Startup throw (OIDC-scoped) |
| Provided `HOMEPAGE_EXTERNAL_URL` malformed | Startup throw (unchanged) |
| `HOMEPAGE_AUTH_USERNAME` + `HOMEPAGE_AUTH_PASSWORD` set | `verifyPassword` env-only; bootstrap skips the user; `/api/security/credentials` → `409`; wizard hidden; no banner |
| Wrong current password in wizard | `400` + `logFailedPasswordSignIn()`; nothing written |
| New password `< 8` / bad username chars | `400` with a specific message; nothing written |
| `writeUser` OK, then step-2 enroll fails | Credentials already changed (banner gone); user retries from the standalone 2FA card |
| Online password brute-force on `/api/auth/callback/credentials` | After 5 consecutive password failures `authorize()` rejects immediately for an exponential window (1 s → 30 s cap); resets on success. Not IP-based. Reverse-proxy rate-limiting + fail2ban still recommended for internet-exposed deployments |
| Legit user mistypes 6+ times | Same throttle — waits seconds; generic "invalid" error |
| Wrong 2FA code (valid password) | `authorize()` returns null; the brute-force counter is **not** advanced |

## Testing (Vitest)

Vitest's `include` glob is `src/**/*.test.{js,jsx}` — all new tests are
`*.test.js` / `.jsx`.

New / reworked:

- `src/utils/auth/auth-file.test.js` — `readAuthFile` caching (2nd call < 5 s no
  re-read; > 5 s re-reads); `writeAuthFile` merge preserves other keys, `0o600`,
  updates cache; `writeAuthFile({ totp: undefined })` deletes only `totp`; corrupt
  → `{}` + one warn.
- `src/utils/auth/password-hash.test.js` — `hashPassword`/`verifyHash` round trip;
  wrong password → `false`; unknown / truncated / empty `stored` → `false`, no throw.
- `src/utils/auth/secret.test.js` — `ensureAuthSecret`: env → `HOMEPAGE_AUTH_SECRET`
  → file → generate(43-char base64url, persisted). Idempotent on a 2nd call.
  Read-only dir → returns a value + warn, no throw.
- `src/utils/auth/credentials-store.test.js` — `ensureInitialUser`: `disabled` /
  `env` / `oidc` / `exists` → not created; clean → writes `{username:"admin"}`
  (no hash); read-only → `{reason:"readonly"}`. `writeUser` adds a `passwordHash`
  that `verifyHash` accepts and preserves `secret`/`totp`. `usingDefaultCredentials`
  = user-without-hash (and false once a hash exists / when `managedByEnv`).
  `currentUsername` truth table.
- `src/utils/auth/credentials.test.js` (rework) — **async** `verifyPassword`:
  env override wins; stored user **with** hash → scrypt path (wrong username →
  `false`, both compared); stored user **without** hash → literal `admin`/`admin`;
  no user → `false`; non-string → `false`; no throw on length mismatch;
  empty-string env vars treated as unset.
- `src/utils/env.test.js` (new) — `isAuthEnabled`: unset / `""` / `"true"` / `"0"`
  → true; `"false"` → false.
- `src/utils/auth/mode.test.js` (update) — `passwordAuthActive` =
  `isAuthEnabled() && !hasOidcConfig`, independent of `HOMEPAGE_AUTH_PASSWORD`.
- `src/instrumentation.test.js` (new) — `register()`: no-op when `NEXT_RUNTIME !==
  "nodejs"`; calls `ensureAuthSecret` + `ensureInitialUser` (mocked); prints the
  box only when `created`; throws on `reason:"readonly"`; does not call
  `ensureAuthSecret` when `HOMEPAGE_AUTH_ENABLED="false"`.
- `src/__tests__/pages/api/auth/[...nextauth].test.js` (rework) — mock
  `utils/auth/secret` (`ensureAuthSecret → "<44 chars>"`), `utils/auth/credentials`
  (`verifyPassword` `mockResolvedValue`), `utils/auth/totp-store`, `utils/auth/totp`.
  `authEnabled` defaults true → the disabled-path tests set `HOMEPAGE_AUTH_ENABLED="false"`.
  The "throws without external URL" test becomes OIDC-scoped; the malformed-URL
  throw stays; `authorize` `await`s `verifyPassword`; `useSecureCookies` `false`
  without URL, `true` with https; credentials build no longer needs
  `HOMEPAGE_AUTH_USERNAME`/`PASSWORD`.
  **Throttle** (fake timers): the 5th consecutive wrong-password call sets a
  block; a call while blocked returns `null` without invoking `verifyPassword`;
  time past the window → a correct password logs in and resets; correct password
  + failing `verifyToken` returns `null` but leaves the counter untouched.
- `src/middleware.test.js` (**broad rework**) — mock `utils/auth/secret`
  (`ensureAuthSecret`). `isAuthEnabled()` now defaults true → **every existing
  test that assumed auth-off by absence changes**: those asserting unauthenticated
  pass-through set `HOMEPAGE_AUTH_ENABLED="false"`; add default-on cases (no env
  → redirect / `401`), `="false"` → pass-through, `getToken` called with the
  resolved secret, `/api/security/credentials` unauthenticated → `401`, host
  check still first.
- **Repo-wide audit:** grep every test that sets/omits `HOMEPAGE_AUTH_ENABLED`
  (`[...nextauth]`, `middleware`, `security/*`, `mcp/index`, `mode`). Any
  asserting an auth-*off* behaviour without `="false"` is now wrong.
- **Delete** `src/__tests__/pages/api/auth/2fa-check.test.js`.
- `src/__tests__/pages/api/security/credentials.test.js` (new) — `405`; `401` no
  session; `409` env-managed; `400` wrong current password (+ log, nothing
  written); `400` weak password / bad username; `200` writes user + returns
  username; `500` on write failure.
- `src/__tests__/pages/api/security/credentials-status.test.js` (new) — `405`
  non-GET; `401` no session; shape for default / changed / env-managed.
- `src/components/layout/CredentialsWarning.test.jsx` (new) — hidden when
  unauthenticated (**no** SWR request); hidden when `usingDefaultCredentials:false`;
  shown with the `/security` link when authenticated + default; `role="alert"`.
- `src/__tests__/pages/security.test.jsx` (rework) — Account summary shows the
  username; `managedByEnv` → explanatory text, no button; wizard step 1 validation
  + success → `mutate` called + advances (→ `twofa` when 2FA off, → `summary`
  when on); step 2 "Not now" → summary; step 2 "Set up 2FA" → enroll/confirm happy
  path; the standalone 2FA-card tests still pass and its state is untouched.
- `src/__tests__/pages/auth/signin.test.jsx` (**rework**) — no `2fa-check` fetch
  mock. `getServerSideProps` returns `twoFactorEnabled` from a mocked
  `isTotpEnabled` (`false` when `passwordAuthActive()` is false). `false` →
  single step → `signIn({redirect:false})` → success navigates, failure shows
  "Invalid username or password". `true` → step 1 → "Continue" reveals the code
  field → `signIn` with the token → failure shows "Invalid username, password,
  or code". The sanitized-`callbackUrl` tests are kept, now against the no-fetch
  flow.
- `src/pages/api/mcp/index.test.js` (update) — set `HOMEPAGE_AUTH_ENABLED="false"`
  where auth-off was assumed; add one asserting a session is required when unset.

## Verification (before merge — mandatory)

1. **Spike first** (plan task 0): confirm `middleware.js` on 16.3.0 can
   `readFileSync` at module scope over a real `pnpm build && pnpm start` + a
   protected-route request.
2. Fresh `config/` (no `auth.json`), no auth env vars. `pnpm build && pnpm start`
   over plain `http://localhost:3000`.
3. Console prints the default-credentials box once; `config/auth.json` has
   `secret` + `user:{username:"admin"}` (no `passwordHash`), mode `600`.
4. `/` → redirect to `/auth/signin`; log in `admin` / `admin` → land on the
   dashboard (**load-bearing:** middleware and the NextAuth route agreed on the
   secret). Repeat with `pnpm dev`, and once with `HOMEPAGE_EXTERNAL_URL=https://…`
   (exercises `__Secure-` cookies).
5. Red banner shows. `/security` → wizard step 1 → banner disappears without a
   reload. Step 2 → enable 2FA → confirm a code. `config/auth.json` `user` now
   has a `passwordHash`.
6. Sign out, sign in with the new username/password + a TOTP code.
7. Restart the server → the existing session cookie still works (secret persisted).
8. `HOMEPAGE_AUTH_ENABLED=false`, restart → no gate, no banner, `config/auth.json`
   has no `user`.
9. Repeat 2–4 in the Docker image (`docker compose up --build`); the box appears
   in `docker compose logs`; `config/auth.json` is owned by the app user.
10. **Throttle:** 5 wrong passwords, then more within the window → rejected with
    no hash evaluation; wait past the window → a correct password logs in and
    resets. `curl` hammering `/api/auth/callback/credentials` cannot beat the
    growing window.
11. `config/` made read-only + no env secret → `instrumentation` aborts startup
    with the clear message (not a redirect loop).

## Documentation

- `docs/installation/index.md` — rewrite Security & Authentication: **login on
  by default with `admin` / `admin`**; prominent **warning** — change or pin the
  credentials **before exposing publicly**; disable with
  `HOMEPAGE_AUTH_ENABLED=false`; `NEXTAUTH_SECRET` auto-generated into
  `config/auth.json` (set `HOMEPAGE_AUTH_SECRET` for multi-replica / read-only
  `config/`); `HOMEPAGE_EXTERNAL_URL` optional for password mode, required for
  OIDC and for `Secure` cookies over HTTPS; document the in-app throttle **and**
  still recommend reverse-proxy rate-limiting + fail2ban/CrowdSec on
  `<nextauth> Failed password sign-in attempt` for `POST
  /api/auth/callback/credentials`; recovery = delete `config/auth.json`.
  Breaking-change admonition (#1, #2).
- `README.md` — auth bullet(s) + security note for default-on + `admin`/`admin`
  + "change before exposing publicly".
- `progress.md` — shipped entry; both breaking changes.
- `.env.example` — the new `YSB_*` knobs.
- Changelog note.

## Out-of-scope follow-ups

- `middleware.js` → `proxy.js` rename + the codemod (Next 16).
- Per-IP / distributed (Redis-backed) throttle for load-balanced deployments.
- Multi-user, roles, email password reset.
