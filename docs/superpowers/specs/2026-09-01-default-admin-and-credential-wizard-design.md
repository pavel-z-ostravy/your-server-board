# Default admin + in-app credential & 2FA wizard — design

**Date:** 2026-09-01 (rev. 5)
**Status:** Draft for review
**Builds on:** `docs/superpowers/specs/2026-08-31-dashboard-2fa-login-design.md` (username + password + TOTP 2FA, shipped on `dev`)

## Summary

Today: auth is opt-in (`HOMEPAGE_AUTH_ENABLED=true`); credentials come **only** from
`HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD` (startup throws without them);
TOTP is enrolled on `/security`.

This change:

- **Login is on by default.** `isAuthEnabled()` is true unless `HOMEPAGE_AUTH_ENABLED=false`.
- **A first-run bootstrap** generates the NextAuth signing secret **and** an
  initial account **`admin` / `admin`**, persists both to `config/auth.json`
  (password scrypt-hashed, flagged `mustChange`), and logs a reminder once. No
  env vars, no startup crash.
- **Credentials are editable in-app** and persist to `config/auth.json`
  (scrypt-hashed). `HOMEPAGE_AUTH_USERNAME` + `HOMEPAGE_AUTH_PASSWORD`, when
  both set, remain an override that locks the in-app editor.
- **A persistent warning banner** shows on every page until the initial
  password is changed.
- **A two-step wizard on `/security`**: step 1 changes username + password
  (verifying the current password); step 2 optionally sets up 2FA in the same
  sitting.
- **`/api/auth/2fa-check` is deleted.** For a single user, "is 2FA enabled" is a
  global fact — the sign-in page reads it in `getServerSideProps`, so there is no
  unauthenticated endpoint that verifies a password. `authorize()` is the only
  place credentials are checked, and it gains a **progressive-delay brute-force
  throttle**.
- **OIDC mode is unchanged** and, when active, suppresses the bootstrap
  account, the banner, and the wizard.

### The signing secret — how it actually reaches every runtime

`middleware.js` runs on the **Edge runtime** (no `fs`) and must verify the JWT
with the **same** secret `[...nextauth].js` signed it with. Neither runtime
`process.env` mutation nor `.env.local` reliably reaches an Edge-runtime
middleware. The only mechanism the design relies on: **the secret is a real OS
environment variable, set on the process (or its parent) before `next`/`node`
starts.** Every launch path funnels through one wrapper — `scripts/prepare-auth.mjs`
— which resolves-or-creates the secret + the initial admin account, then either
exports the secret or spawns the real command with it in `env`:

| Launch path | Mechanism |
|-------------|-----------|
| `pnpm dev` | `"dev": "node scripts/prepare-auth.mjs -- next dev"` — the wrapper sets `process.env.HOMEPAGE_AUTH_SECRET`, then `spawn("next", ["dev"], { env: process.env, stdio: "inherit" })`. The child (and its middleware) inherit the real env var. |
| `pnpm start` | `"start": "node scripts/prepare-auth.mjs -- next start"` — identical wrapper. No `.env.local`, no build-time inlining question. |
| Docker | `docker-entrypoint.sh` runs `node /app/scripts/prepare-auth.mjs --print-secret` (side effects: persist + initial-user log; stdout: the secret), then `export HOMEPAGE_AUTH_SECRET=…` before `exec … node server.js`. **The `spawn` wrapper (mode B) is NOT used in Docker** — the CMD is `node server.js` (the standalone server), not `next start`. |
| `pnpm build` | Unchanged (`next build --webpack`) — no server, no secret needed. |
| `node server.js` raw (no entrypoint, no env var) | **`instrumentation.js` throws at startup** (`register()` runs once, Node runtime, before serving — a throw there aborts the process). This is the real startup gate for every launch path. |

`middleware.js` and `[...nextauth].js` are **unchanged in how they read the
secret** — `process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET`,
at module load. Neither imports any auth-file / bootstrap module. Cross-platform:
the wrapper uses `node:child_process` `spawn`, not shell syntax.

**`src/instrumentation.js`** (new, ~8 lines):

```js
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const authEnabled = process.env.HOMEPAGE_AUTH_ENABLED !== "false";
  const secret = process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET;
  if (authEnabled && !secret) {
    throw new Error(
      "Auth is enabled but no signing secret is set. Start via the container " +
      "entrypoint or `pnpm start` / `pnpm dev`, or set HOMEPAGE_AUTH_SECRET.",
    );
  }
}
```

No `experimental` flag needed in Next 16; it is traced into `output: "standalone"`.
It does not touch `fs` and does not need to reach middleware — it just aborts.

### Default credentials `admin` / `admin` — the exposure this accepts

Decided by the project owner. "Always-on login" means every deployment that
upgrades gets a login gate immediately; a literal `admin` / `admin` default is
online-guessable, and there is no app-level rate limiting. On a deployment
reachable from the internet (reverse proxy / Cloudflare tunnel — the reference
`YSB_ALLOWED_HOSTS` includes one) the window between first start and changing
the credentials is a real exposure.

Mitigations the design carries:
- The non-dismissible red banner on every page until the password is changed.
- `docs/installation/index.md` gets a prominent callout: **change the
  credentials before exposing the dashboard publicly, or pin them with
  `HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD`.**
- `HOMEPAGE_AUTH_ENABLED=false` for a trusted-LAN-only deployment that wants no
  login at all.

Recovery if the stored credentials are forgotten: `rm config/auth.json` (or
delete just the `user` key) and restart — first run recreates `admin` / `admin`.

### Breaking changes

1. Any deployment that did **not** set `HOMEPAGE_AUTH_ENABLED` now shows a
   login screen. To keep no login: `HOMEPAGE_AUTH_ENABLED=false`.
2. `src/pages/api/mcp/index.js` gates its session check on `isAuthEnabled()`;
   with auth default-on, MCP now requires a bearer token **or** a session
   unless `HOMEPAGE_AUTH_ENABLED=false`. The `HOMEPAGE_MCP_TOKEN` path is
   unaffected.

Both go in the changelog, `README.md`, and `docs/installation/index.md`.

## Goals / non-goals

**Goals**
- Zero-config, secure-by-default: a fresh deployment has a login gate with a
  unique password the operator is pushed to change.
- Credentials changeable without env / redeploy.
- One flow to change credentials and (optionally) enable 2FA.
- Sessions survive restarts (persisted secret).
- No regression to OIDC mode or to env-driven credential management.
- Verified end-to-end with a real run before merge.

**Non-goals**
- Multiple users / roles.
- Password reset via email; 2FA recovery codes (unchanged: delete
  `config/auth.json`).
- App-level rate limiting (still the reverse proxy's job — doc note strengthened).
- Renaming `middleware.js` → `proxy.js` (Next 16 deprecation; separate task).
- Changing the two-step **sign-in** page (already shipped, untouched).
- Argon2 (needs a native dep; scrypt is built in and sufficient).

## Plan task 0 — spike (½ day, before any other task)

Two unknowns can invalidate the shape of this design. Resolve both with a
throwaway branch first:

1. **Wrapper spawn.** `scripts/prepare-auth.mjs -- next dev` — confirm `spawn`
   resolves `next` (`node_modules/.bin`, and `.cmd` on Windows if that matters),
   forwards `Ctrl-C`, exits with the child's code, and that `next dev`'s
   **middleware** sees `process.env.HOMEPAGE_AUTH_SECRET`. Do the same for
   `next start` after a `next build`. This is the load-bearing mechanism.
2. **`.mjs` resolution.** A `.js` runtime module `import`ing
   `utils/auth/auth-file` (file is `auth-file.mjs`) resolves under **both** Next
   16 and Vitest; and `node scripts/prepare-auth.mjs` importing
   `../src/utils/auth/bootstrap.mjs` → `./auth-file.mjs` runs with no loader.

If (1) fails, fall back to: require `HOMEPAGE_AUTH_SECRET` in the environment for
non-Docker, keep the Docker entrypoint export, and drop the wrapper. If (2)
fails, make `auth-file` / `bootstrap` plain `.js` and give the scripts a tiny
duplicated file-reader instead of importing them.

## Current state (post-2026-08-31 merge, verified against `dev`)

- `next@^16.2.12`, `output: "standalone"`, no `instrumentation` file, middleware
  has no `runtime` declaration → **Edge**.
- `Dockerfile`: `ENTRYPOINT ["docker-entrypoint.sh"]`, `CMD ["node", "server.js"]`,
  runs as root then `exec su-exec $PUID:$PGID "$@"`. `docker-entrypoint.sh`
  chowns `/app/config` to `$PUID:$PGID` around line 33.
- `.gitignore` already ignores `.env*.local` and `config/auth.json`.
- `src/utils/env.js` — `isAuthEnabled()` = `process.env.HOMEPAGE_AUTH_ENABLED === "true"`.
- `src/utils/auth/credentials.js` — **sync** `verifyPassword(u,p)` reads the two
  env vars, `sha256`+`timingSafeEqual`, `false` if unset/non-string;
  `logFailedPasswordSignIn()`.
- `src/utils/auth/totp-store.js` — reads/writes `config/auth.json`
  (`{ totp: { secret, enabledAt } }`), `writeFileSync {mode:0o600}` + `chmodSync`,
  corrupt file → `{}` + warn.
- `src/utils/auth/totp.js` — `generateEnrollment`/`qrDataUrl`/`verifyToken`
  (`authenticator.options = { window: 1 }`).
- `src/utils/auth/mode.js` — `passwordAuthActive()` =
  `isAuthEnabled() && !hasOidcConfig && Boolean(HOMEPAGE_AUTH_PASSWORD)`.
- `src/pages/api/auth/[...nextauth].js` — module-load validation **throws**
  without `NEXTAUTH_URL`, without a ≥32-char secret, and (password mode)
  without username+password+secret. `authorize({username,password,token})` →
  `verifyPassword` then (if `isTotpEnabled()`) `verifyToken`. `useSecureCookies:
  parsedAuthUrl?.protocol === "https:"`.
- `src/pages/api/auth/2fa-check.js` — `404` when `!passwordAuthActive()`, else
  pre-check; `401` + `logFailedPasswordSignIn()` on bad creds. **(This file, its
  test, and the `signin.jsx` fetch that calls it are deleted in this change.)**
- `src/pages/api/security/totp/{enroll,confirm,disable}.js` — session-guarded.
- `src/pages/security.jsx` — one card; `passwordAuthEnabled` prop; phases
  `idle | enrolling | disabling`; single `error`/`busy` state.
- `src/middleware.js` — `const authEnabled = isAuthEnabled();` and
  `const authSecret = process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET;`
  at module load; when `authEnabled`, `getToken` → redirect `/auth/signin`
  (pages) or `401` (`/api/`). Imports only `next-auth/jwt`, `next/server`,
  `utils/env`. Matcher exempts `_next/*`, static, `api/auth`, `auth/`.
- `src/pages/_app.jsx` — `<SessionProvider>` → `<SWRConfig>` → 4 providers →
  `<NavHeader />` + `<Component />`.
- `src/pages/api/mcp/index.js` — `hasHomepageSession()` returns `false` when
  `!isAuthEnabled()`.
- Deploy: Docker on lxc200, `/opt/stacks/your-server-board`, `./config` volume →
  `/app/config`, `YSB_ALLOWED_HOSTS=10.0.1.104:3050,dashboard.vault1922.xyz`.

## Architecture

### `config/auth.json` — one file, three writers

```json
{
  "secret": "<base64, 44 chars>",
  "user": {
    "username": "admin",
    "passwordHash": "scrypt$16384$8$1$<saltB64>$<hashB64>",
    "mustChange": true,
    "updatedAt": "2026-09-01T…Z"
  },
  "totp": { "secret": "<base32>", "enabledAt": "2026-09-01T…Z" }
}
```

- Any of `secret` / `user` / `totp` may be absent.
- **`src/utils/auth/auth-file.mjs`** is the single file layer, `node:` builtins only
  (`node:fs`, `node:path`), **no imports from `src/`** and no path aliases (it is
  loaded both by Next/Vitest *and* by raw `node scripts/*.mjs`, so every import in
  the `.mjs` chain is a bare `node:` specifier or a relative path):
  - `readAuthFile()` → parsed object. **Cached**: a module-level `{ value, at }`;
    re-reads from disk only when the cache is older than 5 s (safety net for
    out-of-band edits / other replicas) — otherwise returns the cached object.
    Corrupt/unreadable → `{}` + a one-time `warn`.
  - `writeAuthFile(patch)` → **fully synchronous** (`readFileSync` + `writeFileSync`,
    no `await` inside) so it is atomic w.r.t. other JS in the process — two
    handlers cannot interleave a read and a write. Steps: read the file **fresh
    from disk** (not the cache), merge `next = { ...current, ...patch }`, then for
    every key where `patch[k] === undefined` **`delete next[k]`** (a writer can
    remove a section without touching the others), `writeFileSync(path, JSON,
    {mode:0o600})`, `chmodSync(path, 0o600)`, set the cache to `next`. Callers do
    their slow work (`await hashPassword(...)`) **before** calling it, so the
    only thing between two writes is atomic. (Cross-process races —
    multi-replica — remain the documented "shared volume + set
    `HOMEPAGE_AUTH_SECRET`" territory.)
  - All warnings go to **`console.warn` (stderr)** — never `console.log` — so
    `prepare-auth.mjs --print-secret`'s stdout stays exactly the secret.
  - `authFilePath()` → `join(process.env.HOMEPAGE_CONFIG_DIR || join(process.cwd(), "config"), "auth.json")`.
  - Only ever imported by `.js`/`.mjs` in Node contexts (routes, `getServerSideProps`,
    `scripts/`, tests). **Never imported by `middleware.js`.** Vitest resolves the
    extensionless `utils/auth/auth-file` alias to `.mjs` (`.mjs` is first in Vite's
    default extension list); the plan verifies this resolves under both Next and Vitest.
- `totp-store.js` is refactored to thin wrappers over `auth-file`:
  - `readTotpState()` → `readAuthFile()`.
  - `writeTotpState(state)` → `writeAuthFile({ totp: state.totp })`.
  - **`clearTotpState()` → `writeAuthFile({ totp: undefined })`** — this deletes
    only the `totp` key. **Bug fixed here:** today `clearTotpState()` calls
    `writeTotpState({})` which rewrites the whole file as `{}`; harmless while the
    file holds only `totp`, but it would wipe `secret` + `user` once they live
    there. The existing `totp-store.test.js` assertion that `clearTotpState` leaves
    `{}` is reworked to assert it leaves `secret`/`user` intact and drops `totp`.
  - `isTotpEnabled()` unchanged in behaviour.

### Password hashing — `src/utils/auth/password-hash.mjs`

**One implementation, shared** — `.mjs`, `node:crypto` builtins only, imported
by `credentials-store.js` (alias) *and* `bootstrap.mjs` (relative). No
duplication. Promisified `scrypt`, `N=16384, r=8, p=1` (fits Node's 32 MB
`maxmem` default), 64-byte output:

- `async hashPassword(pw)` → `salt = randomBytes(16)`; `key = await scrypt(pw,
  salt, 64, {N,r,p})`; return `scrypt$16384$8$1$<salt b64>$<key b64>`.
- `async verifyHash(pw, stored)` → parse the format; recompute; `timingSafeEqual`.
  Unknown format / parse error → `false`. Never throws.
- **Async** so a slow hash never blocks the event loop.

### Credential resolution — `verifyPassword` (now async)

`async verifyPassword(username, password): Promise<boolean>` — checks, in order,
**no fall-through** once a source is authoritative:

1. **Env override** — if `Boolean(process.env.HOMEPAGE_AUTH_USERNAME) &&
   Boolean(process.env.HOMEPAGE_AUTH_PASSWORD)`: constant-time `sha256` compare
   of both (today's path). Return the result.
2. **Stored user** — else if `readAuthFile().user`: compute **both**
   `usernameOk = constantTimeEquals(username, user.username)` and
   `passwordOk = await verifyHash(password, user.passwordHash)` without
   short-circuiting (so a wrong username and a wrong password take the same time
   — the scrypt runs either way), then `return usernameOk && passwordOk`.
3. Neither → `false`. (There is no literal-default branch: the bootstrap always
   persists a `user`, or the deployment is misconfigured and login is expected
   to fail until the operator sets env creds.)

Non-string input → `false`; never throws. Callers: `authorize` (already async)
and the new `credentials.js` API route both `await` it.

Predicates in `src/utils/auth/credentials-store.js`:
- `managedByEnv()` = `Boolean(process.env.HOMEPAGE_AUTH_USERNAME && process.env.HOMEPAGE_AUTH_PASSWORD)`.
- `readUser()` = `readAuthFile().user ?? null`.
- `usingDefaultCredentials()` = `!managedByEnv() && readUser()?.mustChange === true`.
- `async writeUser({ username, password })` → `const passwordHash = await
  hashPassword(password)` **then** `writeAuthFile({ user: { username,
  passwordHash, mustChange: false, updatedAt: now } })` (slow work before the
  atomic write).
- `currentUsername()` = `managedByEnv() ? process.env.HOMEPAGE_AUTH_USERNAME :
  (readUser()?.username ?? "admin")` — **aligned with `verifyPassword`'s branch
  selection** (env only counts when *both* env vars are set).

Changing credentials does **not** invalidate the current JWT (single-user, JWT
strategy, no session store); `session.user.name` reflects the username at login
time and refreshes on the next sign-in. Documented; sign out manually to force it.

### Bootstrap — `src/utils/auth/bootstrap.mjs` + `scripts/prepare-auth.mjs`

**Only `prepare-auth.mjs` (a separate, pre-server process) ever generates or
persists the secret. The running server — `[...nextauth].js` and `middleware.js`
— reads the secret from `process.env` and nothing else.** This is the whole
reason the design works with an Edge middleware: the secret is a real OS env var
by the time `node server.js` starts.

**`bootstrap.mjs`** — `node:` builtins + relative import of `./auth-file.mjs`
only. It **inlines** the three env predicates it needs (it must not `import`
`env.js` / `mode.js` / `credentials-store.js`, which are ESM-syntax `.js` files
that raw `node` would fail to parse):

```js
const authEnabledFromEnv = () => process.env.HOMEPAGE_AUTH_ENABLED !== "false";
const hasOidcConfig = () => Boolean(process.env.HOMEPAGE_OIDC_ISSUER && process.env.HOMEPAGE_OIDC_CLIENT_ID && process.env.HOMEPAGE_OIDC_CLIENT_SECRET);
const managedByEnv = () => Boolean(process.env.HOMEPAGE_AUTH_USERNAME && process.env.HOMEPAGE_AUTH_PASSWORD);
```

`env.js` / `mode.js` / `credentials-store.js` keep their own copies of the
equivalent checks; each carries a `// mirror of bootstrap.mjs` comment, and
`bootstrap.test.js` + `mode.test.js` pin both to one truth table.

Exports:

- `resolveOrCreateSecret()` → returns `{ secret, source }` where `source ∈
  {"env","file","generated"}`:
  - `process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET` → `"env"`.
  - else `readAuthFile().secret` → `"file"`.
  - else generate `randomBytes(32).toString("base64")`, `writeAuthFile({ secret })`
    → `"generated"`. If the write throws (read-only `config/`), still return the
    value with `source: "generated"` and `warn` "secret not persisted; set
    HOMEPAGE_AUTH_SECRET or make config/ writable".
- `async ensureInitialUser()` →
  - `!authEnabledFromEnv()` → `{ created: false, reason: "disabled" }` (no user,
    no log box when `HOMEPAGE_AUTH_ENABLED=false`).
  - `managedByEnv()` → `{ created: false, reason: "env" }`.
  - `readAuthFile().user` → `{ created: false, reason: "exists" }`.
  - `hasOidcConfig()` → `{ created: false, reason: "oidc" }`.
  - else `const passwordHash = await hashPassword("admin")` then `writeAuthFile({
    user: { username: "admin", passwordHash, mustChange: true, updatedAt: now } })`,
    return `{ created: true }`. If the write throws: `{ created: false, reason: "readonly" }`.

`hashPassword` / `verifyHash` come from the shared `password-hash.mjs` — no
duplication.

**`scripts/prepare-auth.mjs`** — imports `bootstrap.mjs` **relatively**
(`../src/utils/auth/bootstrap.mjs`), top-level `await`. Two modes, dispatched on
argv:

Common preamble (both modes):
1. `const { secret } = resolveOrCreateSecret();`
2. `const init = await ensureInitialUser();`
3. If `init.created`: print to **stderr**:
   ```
   ┌─ Login enabled with default credentials ──────
   │  username: admin
   │  password: admin
   │  Change them now at /security — do not expose
   │  this dashboard publicly until you have.
   └──────────────────────────────────────────────
   ```
4. If `init.reason === "readonly"`: stderr `FATAL: config/ is not writable and
   no HOMEPAGE_AUTH_USERNAME / HOMEPAGE_AUTH_PASSWORD is set — cannot create a
   login.` then `process.exit(1)`.

**Mode A — `--print-secret`** (Docker entrypoint): `process.stdout.write(secret)`
— exactly the secret, nothing else on stdout — and exit `0`.

**Mode B — `-- <cmd> <args…>`** (npm scripts): `process.env.HOMEPAGE_AUTH_SECRET
= secret`, then `const child = spawn(cmd, args, { env: process.env, stdio:
"inherit" })`; forward `SIGINT`/`SIGTERM` to the child; `process.exit(child
status)` on close. Cross-platform (no shell).

**`docker-entrypoint.sh`** — insert, **before** the `chown -R "$PUID:$PGID"
/app/config` block. It runs **unconditionally** (even when the operator set
`HOMEPAGE_AUTH_SECRET`) so `ensureInitialUser()` always gets a chance to create
the admin account; it only *exports* a secret when one is not already set:

```sh
_ysb_secret="$(node /app/scripts/prepare-auth.mjs --print-secret)" || {
  echo "FATAL: could not prepare auth (see stderr above)"; exit 1; }
[ -z "$HOMEPAGE_AUTH_SECRET" ] && export HOMEPAGE_AUTH_SECRET="$_ysb_secret"
unset _ysb_secret
```

Running it before the chown means the `config/auth.json` it writes (as root) is
picked up by the subsequent `chown -R "$PUID:$PGID" /app/config` and ends up
readable by the app user. `su-exec` preserves the exported env, so
`HOMEPAGE_AUTH_SECRET` reaches `node server.js`. `ensureInitialUser()` runs here,
so the default-credentials box lands in `docker compose logs` on first start.

**`Dockerfile`** — `output: "standalone"` only bundles traced files.
`auth-file.mjs` and `password-hash.mjs` are traced (imported by the credential
routes), but `scripts/` and `bootstrap.mjs` are not. Add to the runner stage:

```dockerfile
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src/utils/auth/bootstrap.mjs ./src/utils/auth/bootstrap.mjs
```

`node` is already on `PATH` in the runner stage (it runs `node server.js`).
`prepare-auth.mjs` imports `../src/utils/auth/bootstrap.mjs` which imports
`./auth-file.mjs` — verify the relative paths line up with the standalone
layout (`/app/scripts/…`, `/app/src/utils/auth/…`), the real build-stage name,
and that `.dockerignore` does not exclude `scripts/`.

**`package.json`** — change `"dev"` → `"node scripts/prepare-auth.mjs -- next dev"`
and `"start"` → `"node scripts/prepare-auth.mjs -- next start"`. `"build"`
unchanged. (`spawn("next", …)` resolves `next` from `node_modules/.bin` — pass
`{ shell: false }` and resolve the bin path explicitly via
`require.resolve`/`import.meta` + `node_modules/.bin/next` for Windows `.cmd`
safety; the plan nails this down.)

### Always-on switch

- `src/utils/env.js`: `isAuthEnabled()` → `process.env.HOMEPAGE_AUTH_ENABLED !== "false"`.
  Only the exact string `"false"` disables. `""` / unset / `"true"` / anything
  else → enabled.
- `src/utils/auth/mode.js`: `passwordAuthActive()` → `isAuthEnabled() && !hasOidcConfig`
  (drop the `HOMEPAGE_AUTH_PASSWORD` clause — a password source always exists now).

### `src/pages/api/auth/[...nextauth].js` changes

- **Does not import `bootstrap.mjs` and never generates a secret.** It reads
  `process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET` exactly like
  `middleware.js` does. The startup gate for a missing secret is
  `instrumentation.js` (which aborts the whole process); `[...nextauth].js`
  keeps a defensive `!process.env.NEXTAUTH_SECRET` throw in its `if (authEnabled)`
  block as belt-and-braces (it only surfaces as `/api/auth/*` 500s if something
  bypassed `instrumentation`).
- `NEXTAUTH_URL` mapping unchanged (`HOMEPAGE_EXTERNAL_URL` → `NEXTAUTH_URL` when set).
- In `if (authEnabled)`:
  - Parse + validate the URL **only when `process.env.NEXTAUTH_URL` is set**
    (keep the "must be absolute http(s), no creds/query/fragment" throw for a
    *provided* URL).
  - Keep `if (hasOidcConfig && !process.env.NEXTAUTH_URL) throw new
    Error("OIDC auth requires HOMEPAGE_EXTERNAL_URL.")`.
  - Password branch: the throw condition becomes just `!process.env.NEXTAUTH_SECRET`
    (drop `!homepageAuthPassword || !homepageAuthUsername` — the bootstrap
    account / env override cover credentials).
  - Keep the ≥32-char check on the resolved secret.
- `authorize` — add `await` **and a progressive-delay brute-force throttle**:

  ```js
  // module scope
  const FAIL_THRESHOLD = 5;
  let consecutiveFailures = 0;
  let blockedUntil = 0;

  async authorize(credentials) {
    if (Date.now() < blockedUntil) { logFailedPasswordSignIn(); return null; }
    const { username, password, token } = credentials ?? {};

    if (!(await verifyPassword(username, password))) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= FAIL_THRESHOLD) {
        const over = consecutiveFailures - FAIL_THRESHOLD;          // 0,1,2,…
        blockedUntil = Date.now() + Math.min(1000 * 2 ** over, 30_000);  // 1s,2s,…,30s
      }
      logFailedPasswordSignIn();
      return null;
    }

    if (isTotpEnabled() && !verifyToken(token)) {
      // valid password, wrong 2FA code — NOT a password brute-force,
      // so consecutiveFailures is left untouched
      logFailedPasswordSignIn();
      return null;
    }

    consecutiveFailures = 0;
    blockedUntil = 0;
    return { id: "homepage", name: username };
  }
  ```

  Global counter (single user); rejects immediately while blocked (no held
  connection); resets on any fully-successful sign-in. In-memory — resets on a
  server restart, which an attacker cannot trigger. Topology-independent: no
  reliance on `X-Forwarded-For` / client IP. The 5th consecutive wrong password
  triggers a 1 s block; each further failure doubles it to a 30 s cap. A
  legitimate user who mistypes waits at most a few seconds; the sign-in page
  shows the generic "invalid" error during the block.
- `useSecureCookies: parsedAuthUrl?.protocol === "https:"` unchanged → `false`
  when no URL (LAN http), `true` when `HOMEPAGE_EXTERNAL_URL` is https. This is
  what lets the credentials flow work over plain http without a URL — next-auth
  otherwise defaults `Secure` cookies in production and the browser drops them.

> **Missing `NEXTAUTH_URL` in password mode is safe here specifically because:**
> (a) `useSecureCookies` is forced `false`; (b) the sign-in page uses
> `signIn(..., { redirect: false })` + a sanitized relative `window.location.assign`,
> so next-auth's URL-dependent redirect callback is never exercised;
> (c) the middleware builds its `/auth/signin` redirect from `req.url`.
> next-auth still logs one `[NEXTAUTH_URL]` warn through the sanitized logger.
> **The verification step must confirm a real end-to-end login over plain
> http with no URL set.**

### Delete `/api/auth/2fa-check`; move the flag into the sign-in page

- **Delete** `src/pages/api/auth/2fa-check.js` and `src/__tests__/pages/api/auth/2fa-check.test.js`.
- `src/pages/auth/signin.jsx` `getServerSideProps` adds
  `twoFactorEnabled: passwordAuthActive() ? isTotpEnabled() : false` to its props
  (it already returns providers + public settings; add one cached file read).
- `signin.jsx` form logic, driven entirely by that prop — **no client fetch**:
  - `twoFactorEnabled === false` → the current single step (username + password) →
    `signIn("credentials", { redirect: false, username, password })`.
  - `twoFactorEnabled === true` → two **client-side** steps: step 1 collects
    username + password, "Continue" reveals step 2 (the 6-digit field), submit →
    `signIn("credentials", { redirect: false, username, password, token })`.
  - The old step-1 pre-check `fetch` and its "Invalid username or password" at
    step 1 are removed. All credential errors now come from `signIn`'s result
    (`redirect: false` → `{ ok, error }`): a failed `signIn` shows the generic
    "Invalid username or password" (2FA off) or "Invalid username, password, or
    code" (2FA on). The sanitized-`callbackUrl` + `window.location.assign` on
    success is unchanged.
- Net effect: **no unauthenticated endpoint verifies a password.** `authorize()`
  (with its throttle) is the single credential chokepoint. `twoFactorEnabled` is
  visible to anyone who loads `/auth/signin` — a config fact, not a secret, and
  arguably a deterrent (an attacker sees a second factor is required).

### `src/middleware.js` changes

- `const authEnabled = isAuthEnabled();` — unchanged in form, now default-true.
- `authSecret` line unchanged (`process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET`).
  Guaranteed populated by `prepare-auth.mjs` — as a real env var on the spawned
  `next` child (npm scripts) or exported by the entrypoint (Docker) — before the
  process serves anything; if it were missing, `[...nextauth].js`'s startup throw
  already stopped the server.
- No import changes, no matcher changes, no `fs`, no Edge/Node runtime change.

### `src/pages/api/security/credentials.js` (new)

- `POST` only → `405`. Session required (middleware guards `/api/security/*`;
  defensive `getServerSession` → `401`).
- `managedByEnv()` → `409 { error: "Credentials are managed by environment variables." }`.
- Body `{ currentPassword, username, password }`.
- `!(await verifyPassword(currentUsername(), currentPassword))` →
  `400 { error: "Current password is incorrect." }` + `logFailedPasswordSignIn()`.
- Validation → `400 { error: <specific> }`:
  - `password` length `< 8` → "Password must be at least 8 characters."
  - `username` not `/^[A-Za-z0-9._-]{1,64}$/` (after `trim`) → "Username may only
    contain letters, digits, dots, underscores and dashes."
- On success: `await writeUser({ username: username.trim(), password })` →
  `200 { username }`. Write failure → `500 { error: "Could not save credentials." }`
  + `createLogger("auth").error(...)`.

### `src/pages/api/security/credentials-status.js` (new)

- `GET` only → `405`. Session required → `401`.
- `200 { usingDefaultCredentials: boolean, managedByEnv: boolean, username: string }`
  (`username` = `currentUsername()`).

### `src/components/layout/CredentialsWarning.jsx` (new)

- `const { status } = useSession();`
- `const { data } = useSWR(status === "authenticated" ? "/api/security/credentials-status" : null);`
  — **conditional key**: no request when unauthenticated / auth disabled.
- Render `null` unless `data?.usingDefaultCredentials`.
- Otherwise a full-width bar: `role="alert"`, `bg-red-600 text-white text-sm`,
  `px-4 py-2 pl-14 sm:pl-16` (left padding clears the absolutely-positioned
  NavHeader hamburger). Text: **"You're signed in with the default admin / admin
  credentials — anyone who can reach this page can log in."** +
  `<Link href="/security" className="underline font-medium">` **"Change them
  now"**. Not dismissible.
- Placed in `_app.jsx` immediately after `<NavHeader />`, before `<Component />`
  (inside `SessionProvider` + `SWRConfig`). Known minor: a one-frame layout
  shift on load while `useSession` resolves — acceptable for a security nag.

### `src/pages/security.jsx` changes

`getServerSideProps` adds `managedByEnv` and `currentUsername` to props
(alongside `passwordAuthEnabled`, `twoFactorEnabled`).

New **Account** card, rendered above the existing 2FA card, **with its own
state** (`wizardStep: "summary" | "credentials" | "twofa"`, `wizardError`,
`wizardBusy`, `wizardEnrollment`, `wizardCode`) — it does **not** touch the 2FA
card's `phase` / `error` / `busy`:

- **summary:** "Signed in as **`<currentUsername>`**." When `managedByEnv`:
  "Credentials are managed by `HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD`."
  and no button. Else: button **"Change username & password"** → `credentials`.
- **credentials:** fields `Current password`, `New username` (default =
  `currentUsername`), `New password`, `Confirm new password`. Client checks
  `New password === Confirm` before POST. Submit → `POST /api/security/credentials`.
  `400`/`409`/`500` → inline `wizardError` with the server message. `200` →
  update the displayed username, and `import { mutate } from "swr"` then
  `mutate("/api/security/credentials-status")` — the banner shares that SWR key,
  so it re-fetches and disappears. Then: if `twoFactorEnabled` → back to
  `summary`; else → `twofa`.
- **twofa:** "Add two-factor authentication?" + **"Set up 2FA"** /
  **"Not now"**.
  - "Not now" → `summary`.
  - "Set up 2FA" → `POST /api/security/totp/enroll`, show QR + secret + a
    6-digit field (same `CODE_INPUT_PROPS`), **"Confirm"** →
    `POST /api/security/totp/confirm { secret, token }`. `400` →
    "Invalid code, try again."; `200` → close the wizard to `summary`.
- **2FA-card / wizard state coupling:** lift the 2FA card's `enabled` boolean to
  the page component (initialised from the `twoFactorEnabled` prop). Both the
  wizard's confirm and the standalone card's enable/disable call the same
  `setEnabled(...)`. No `router.replace` / SSR re-fetch — one source of truth in
  page state.
- The existing **Two-factor authentication** card keeps its own `phase` /
  `error` / `busy`; only `enabled` is lifted.

### `src/pages/api/mcp/index.js`

No code change. Its behaviour shift (session now required when auth default-on)
is intentional; covered by a changelog note and by updating its tests to set
`HOMEPAGE_AUTH_ENABLED=false` where they assumed "no auth".

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

`${VAR:-}` passes an **empty string** when unset. Every consumer must use
truthiness (`Boolean(x)` / `if (!x)`), never `x !== undefined`. Audit:
`[...nextauth].js` (`homepageAuthSecret`, `homepageExternalUrl`, `issuer`,
`clientId`, `clientSecret`, `homepageAuthPassword`, `homepageAuthUsername` — all
already truthiness), `mode.js`, `credentials.js`, `credentials-store.js`,
`bootstrap.mjs`. Add one test asserting empty-string env vars behave as unset.

`.env.example` documents every `YSB_*` knob and the default-on behaviour.

## CONF_DIR / cwd

`auth-file.mjs` uses `process.env.HOMEPAGE_CONFIG_DIR || join(process.cwd(),
"config")`. It is only ever loaded in Node contexts whose cwd is the app root
(`/app` in the image, repo root in dev) — never in middleware — so
`process.cwd()` is consistent. `docs/installation/index.md` recommends an
absolute `HOMEPAGE_CONFIG_DIR` for non-standard launchers.

## Data flow

```
Fresh Docker deploy, nothing configured:
  entrypoint → prepare-auth.mjs --print-secret
      resolveOrCreateSecret() → generate, writeAuthFile({secret})
      ensureInitialUser()     → writeAuthFile({user:{username:"admin", passwordHash:scrypt("admin"), mustChange:true}})
      stdout: <secret> ; stderr: "username: admin / password: admin — change at /security"
  entrypoint → export HOMEPAGE_AUTH_SECRET=<secret> ; chown config ; su-exec node server.js
  GET /  → middleware: authEnabled, no token → redirect /auth/signin
  GET /auth/signin → getServerSideProps: twoFactorEnabled = isTotpEnabled() = false
         → single-step form → signIn("credentials",{redirect:false,username:"admin",password:"admin"})
         → authorize → throttle ok → verifyPassword (stored user, scrypt) ok
                     → JWT signed with process.env.NEXTAUTH_SECRET
  GET /  → middleware: getToken(secret=same) → ok
         → CredentialsWarning: SWR /api/security/credentials-status
         → {usingDefaultCredentials:true} → red banner

Change credentials:
  /security → Account card → "credentials" step
  POST /api/security/credentials {currentPassword:"admin", username:"pavel", password:"<8+>"}
      → verifyPassword("admin","admin") ok → writeUser → mustChange:false → 200
      → mutate(credentials-status) → {usingDefaultCredentials:false} → banner gone
      → "twofa" step → "Set up 2FA" → enroll → confirm → totp saved
  next sign-in: verifyPassword → stored-user branch (username "pavel"); 2FA code required
```

## Error handling

| Situation | Behaviour |
|-----------|-----------|
| No secret, `config/` writable | `prepare-auth.mjs` generates + persists + puts it in the child's `env` (or exports for Docker); both runtimes read it from `process.env` |
| No secret, `config/` read-only, no env creds | `prepare-auth.mjs` hits `reason:"readonly"` → FATAL + `exit 1` in **both** modes; the app does not start (there would be no way to log in) |
| No secret, `config/` read-only, full `HOMEPAGE_AUTH_USERNAME`/`PASSWORD`/`SECRET` set | `ensureInitialUser` → `reason:"env"`, `resolveOrCreateSecret` → `source:"env"` → starts normally, no persistence needed |
| No secret, multi-replica, **shared** `config/` volume | First replica persists `secret`; the rest read `source:"file"` → consistent |
| No secret, multi-replica, **unshared** volumes | Each generates its own → sessions bounce between replicas. Documented: set `HOMEPAGE_AUTH_SECRET` |
| `config/auth.json` corrupt | `readAuthFile()` → `{}` + warn; next `writeAuthFile` overwrites |
| `config/auth.json` cache staleness (other replica changed a password) | Up to 5 s window where the old password still verifies. Acceptable for homelab; documented |
| `HOMEPAGE_AUTH_ENABLED=false` | No gate, no banner, no bootstrap user, `/security` → "authentication disabled" state, MCP session check off |
| OIDC configured, no `HOMEPAGE_EXTERNAL_URL` | Startup throw (OIDC-scoped) |
| Provided `HOMEPAGE_EXTERNAL_URL` malformed | Startup throw (unchanged) |
| `HOMEPAGE_AUTH_USERNAME` + `HOMEPAGE_AUTH_PASSWORD` set | `verifyPassword` uses env only; bootstrap skips the user; `/api/security/credentials` → `409`; wizard hidden; no banner |
| Wrong current password in wizard | `400` + `logFailedPasswordSignIn()`; nothing written |
| New password `< 8` / bad username chars | `400` with a specific message; nothing written |
| `writeUser` OK, then step-2 enroll fails | Credentials already changed (banner gone); user retries from the standalone 2FA card |
| Online password brute-force against `/api/auth/callback/credentials` | After 5 consecutive password failures `authorize()` rejects immediately for an exponential window (1 s → … → 30 s cap); resets on success. Not IP-based. Reverse-proxy rate-limiting + fail2ban on the log line still recommended for internet-exposed deployments |
| Legit user mistypes password 6+ times | Same throttle applies — waits a few seconds; the sign-in page shows the generic "invalid" error until the window passes |
| Wrong 2FA code (valid password) | `authorize()` returns null but **does not** advance the brute-force counter (it is not a password guess) |

## Testing (Vitest)

**Vitest's `include` glob is `src/**/*.test.{js,jsx}` — `.test.mjs` is NOT
collected.** Every new test file is `*.test.js` (or `.jsx`); a `.test.js` file
importing a `.mjs` module under test works (Vitest transforms both to ESM).

New / reworked:

- `src/utils/auth/auth-file.test.js` — `readAuthFile` caching (2nd call within
  5 s does not re-read; after 5 s it does); `writeAuthFile` merge preserves other
  keys, sets `0o600`, updates the cache; **`writeAuthFile({ totp: undefined })`
  deletes only `totp`, leaving `secret`/`user`**; corrupt file → `{}` + one warn.
- `src/utils/auth/password-hash.test.js` — `hashPassword`/`verifyHash` round
  trip; a hash from `bootstrap`'s use verifies and vice-versa (they import the
  same module — trivially true, but assert the format string); unknown / truncated
  / empty `stored` → `false`, no throw; `verifyHash` on a valid-format hash with
  the wrong password → `false`.
- `src/utils/auth/bootstrap.test.js` — `resolveOrCreateSecret`: `source` is
  `"env"` / `"file"` / `"generated"` accordingly; generated is ≥32-char and
  persisted; read-only dir → value returned with `source:"generated"` + warn (on
  **stderr**), no throw. `ensureInitialUser`: `disabled` (`HOMEPAGE_AUTH_ENABLED=false`)
  / `managedByEnv` / existing user / OIDC → not created; clean → creates
  `{username:"admin", passwordHash, mustChange:true}` whose hash `verifyHash`
  accepts for `"admin"`; read-only → `{created:false, reason:"readonly"}`. The
  inlined `authEnabledFromEnv` / `hasOidcConfig` / `managedByEnv` are pinned
  against `env.js` / `mode.js` on the same inputs.
- `src/instrumentation.test.js` — `register()`: no-op when `NEXT_RUNTIME !==
  "nodejs"`; throws (clear message) when auth on + no secret; returns when a
  secret is present; returns when `HOMEPAGE_AUTH_ENABLED="false"`.
- `src/utils/auth/credentials-store.test.js` — `writeUser` sets `mustChange:false`,
  preserves `secret`/`totp`; `usingDefaultCredentials` / `managedByEnv` truth
  tables; **`currentUsername()` returns the env name only when both env vars are
  set, else the stored name, else `"admin"`** (the M2 alignment).
- `src/utils/auth/credentials.test.js` (rework) — **async** `verifyPassword`
  now returns `Promise<boolean>`; existing sync assertions become `await`.
  Branches: env override wins and the stored user is ignored even if it would
  also match; env absent + stored user → scrypt path, wrong username → `false`;
  neither env nor stored user → `false`; non-string → `false`; constant-time (no
  throw on unequal byte length); empty-string env vars treated as unset. Callers
  (`authorize`, `credentials.js`) `await` it — the existing `[...nextauth].test.js`
  mock of `verifyPassword` switches to `mockResolvedValue`.
- `src/utils/env.test.js` (new) — `isAuthEnabled`: unset → true, `""` → true,
  `"true"` → true, `"false"` → false, `"0"` / `"no"` → true.
- `src/utils/auth/mode.test.js` (update) — `passwordAuthActive` =
  `isAuthEnabled() && !hasOidcConfig`, independent of `HOMEPAGE_AUTH_PASSWORD`.
- `src/__tests__/pages/api/auth/[...nextauth].test.js` (rework) — the module no
  longer imports bootstrap; it reads `process.env.NEXTAUTH_SECRET ||
  HOMEPAGE_AUTH_SECRET` and keeps a defensive throw when `authEnabled` and
  neither is set. So: `authEnabled` defaults true (tests for the disabled path
  now set `HOMEPAGE_AUTH_ENABLED="false"`); the defensive-throw test explicitly
  `delete`s both `NEXTAUTH_SECRET` and `HOMEPAGE_AUTH_SECRET` (so a value in the
  developer's shell can't mask it); every other auth-on test sets a valid
  `HOMEPAGE_AUTH_SECRET`; the "throws without external URL" test becomes
  OIDC-scoped (password mode with no URL no longer throws); the malformed-URL
  throw stays (URL provided); `authorize` `await`s the mocked
  `verifyPassword` (`mockResolvedValue`); `useSecureCookies` is `false` with no
  URL and `true` with an https `HOMEPAGE_EXTERNAL_URL`; the credentials-provider
  build no longer requires `HOMEPAGE_AUTH_USERNAME`/`PASSWORD`.
  **Throttle** (fake timers): the 5th consecutive wrong-password `authorize`
  call sets a block; a call while blocked returns `null` **without** invoking
  `verifyPassword`; advancing time past the window lets a correct password
  through and resets `consecutiveFailures`/`blockedUntil`; a correct password +
  wrong `verifyToken` returns `null` but leaves the counter untouched (a 6th
  wrong-*password* call is still needed to grow the block).
- `src/middleware.test.js` (**broad rework**, not a tweak) — `isAuthEnabled()`
  now defaults true, so **every existing test that relied on auth being off by
  the absence of `HOMEPAGE_AUTH_ENABLED` changes behaviour**. Audit each case:
  those that assert unauthenticated pass-through must now set
  `HOMEPAGE_AUTH_ENABLED="false"`; add the default-on cases (no env var →
  redirect for pages, `401` for `/api/`), `="false"` → pass-through, `getToken`
  called with `process.env.NEXTAUTH_SECRET`, `/api/security/credentials`
  unauthenticated → `401`, host-check still runs first regardless.
- **Delete `src/__tests__/pages/api/auth/2fa-check.test.js`** with the endpoint.
- **Repo-wide audit:** grep every test that sets or omits `HOMEPAGE_AUTH_ENABLED`
  (`[...nextauth].test.js`, `middleware.test.js`, `security/*` tests,
  `mcp/index.test.js`, `mode.test.js`). Any that assert an auth-*off* behaviour
  without setting `="false"` is now wrong and must be fixed.
- `src/__tests__/pages/api/security/credentials.test.js` (new) — `405`; `401`
  no session; `409` env-managed; `400` wrong current password (+ log, nothing
  written); `400` weak password / bad username; `200` writes user + returns
  username; `500` on write failure.
- `src/__tests__/pages/api/security/credentials-status.test.js` (new) — `405`
  non-GET; `401` no session; shape for default / changed / env-managed.
- `src/components/layout/CredentialsWarning.test.jsx` (new) — hidden when
  unauthenticated (and **no** SWR request fired); hidden when
  `usingDefaultCredentials:false`; shown with the `/security` link when
  authenticated + default; `role="alert"`.
- `src/__tests__/pages/security.test.jsx` (rework) — Account summary shows the
  username; `managedByEnv` → explanatory text, no button; wizard step 1
  validation + success → `mutate` called + advances (to `twofa` when 2FA off,
  to `summary` when already on); step 2 "Not now" → summary; step 2 "Set up 2FA"
  → enroll/confirm happy path; the standalone 2FA-card tests still pass and its
  state is not disturbed by the wizard.
- `src/__tests__/pages/auth/signin.test.jsx` (**rework**) — no more
  `/api/auth/2fa-check` fetch mock. `getServerSideProps` returns
  `twoFactorEnabled` from a mocked `isTotpEnabled` (and `false` when
  `passwordAuthActive()` is false). Form: `twoFactorEnabled=false` → single step
  → `signIn` with `{redirect:false}` → success navigates, failure shows "Invalid
  username or password". `twoFactorEnabled=true` → step 1 → "Continue" reveals
  the code field → `signIn` with the token → failure shows "Invalid username,
  password, or code". The sanitized-`callbackUrl` tests from the 2026-08-31 work
  are kept (they now run against the no-fetch flow).
- `src/pages/api/mcp/index.test.js` (update) — set `HOMEPAGE_AUTH_ENABLED="false"`
  in the cases that assumed auth-off; add one asserting a session is required
  when it is unset.
- `scripts/prepare-auth.test.js` — `execFileSync("node", ["scripts/prepare-auth.mjs",
  "--print-secret"], { env: { ...process.env, HOMEPAGE_CONFIG_DIR: <tmp> } })`:
  stdout is exactly the secret (44 base64 chars, no trailing newline), stderr
  carries the default-credentials box on first run and is quiet on the second
  run, and the `config/auth.json` in the tmp dir is valid + `0600` + has `secret`
  and `user` (`username:"admin"`, `mustChange:true`).

## Verification (before merge — mandatory)

A real run, not just green unit tests:

1. Fresh `config/` (no `auth.json`), no auth env vars. `pnpm build && pnpm start`
   over plain `http://localhost:3000`.
2. Confirm the wrapper prints the default-credentials box once (stderr); confirm
   `config/auth.json` has `secret` + `user` with `username:"admin"` +
   `mustChange:true`, mode `600`.
3. Browse to `/` → redirected to `/auth/signin`. Log in with `admin` / `admin`.
   Confirm you land on the dashboard — this is the load-bearing check that the
   secret reached **both** the Node route runtime and the Edge middleware runtime
   (a mismatch shows as an immediate redirect back to signin). Repeat with
   `pnpm dev`, **and once with `HOMEPAGE_EXTERNAL_URL=https://…` set** (exercises
   the `__Secure-` cookie-prefix path in both `authOptions` and `getToken`).
3a. Start with `HOMEPAGE_AUTH_ENABLED` unset but no writable `config/` and no
    `HOMEPAGE_AUTH_SECRET` → confirm `instrumentation.js` aborts the process with
    the clear message (not a redirect loop).
4. Confirm the red banner shows. Open `/security`, run the wizard step 1 → banner
   disappears without a reload. Continue to step 2, enable 2FA, confirm a code.
5. Sign out, sign in again with the new username/password + a TOTP code.
6. Restart the server → confirm the existing session cookie still works (secret
   persisted).
7. Set `HOMEPAGE_AUTH_ENABLED=false`, restart → no login gate, no banner,
   `config/auth.json` has no `user` key.
8. Re-run steps 1–3 inside the Docker image (`docker compose up --build`) and
   confirm the default-credentials box appears in `docker compose logs`.
9. **Throttle:** submit a wrong password 5×, then a 6th within ~1 s → still
   rejected without delay from the client's view but the server no longer
   evaluates the hash; wait ~2 s → a correct password logs in and the counter
   resets. Confirm `curl` hammering `/api/auth/callback/credentials` cannot
   exceed roughly one attempt per the growing window.

## Documentation

- `docs/installation/index.md` — rewrite Security & Authentication: **login is
  on by default with `admin` / `admin`**; a prominent **warning** callout —
  change the credentials from the Security page (or pin `HOMEPAGE_AUTH_USERNAME`
  + `HOMEPAGE_AUTH_PASSWORD`) **before exposing the dashboard to the internet**;
  disable entirely with `HOMEPAGE_AUTH_ENABLED=false`; `NEXTAUTH_SECRET`
  auto-generated to `config/auth.json` (set `HOMEPAGE_AUTH_SECRET` for
  multi-replica or read-only `config/`); `HOMEPAGE_EXTERNAL_URL` optional for
  password mode, required for OIDC and for `Secure` cookies over HTTPS;
  document the in-app sign-in throttle **and** still recommend reverse-proxy
  rate-limiting + `fail2ban`/CrowdSec on `<nextauth> Failed password sign-in
  attempt` for `POST /api/auth/callback/credentials` on internet-exposed
  deployments (the throttle is a backstop, not a replacement); recovery = delete
  `config/auth.json`. Breaking-change admonition (#1 and #2).
- `README.md` — update the auth bullet(s) and the security note for default-on
  + `admin`/`admin`, with the "change before exposing publicly" warning.
- `progress.md` — shipped entry; both breaking changes.
- `.env.example` — the new `YSB_*` knobs.
- Changelog note.

## Resolved: no unauthenticated password endpoint (rev 5)

The 2026-08-31 `/api/auth/2fa-check` pre-check verified username+password
unauthenticated. With always-on auth that becomes a scrypt-per-guess DoS lever
and a clean password oracle on every non-OIDC deployment. **Resolution (see
"Delete `/api/auth/2fa-check`" above):** delete it; `twoFactorEnabled` is a
single-user global fact the sign-in page reads in `getServerSideProps`.
Combined with the `authorize()` throttle, the **only** unauthenticated
password-checking surface is next-auth's own `/api/auth/callback/credentials`,
which is the login endpoint and inherently must check — and it is now throttled.

## Out-of-scope follow-ups

- `middleware.js` → `proxy.js` (Next 16).
- Per-IP / distributed throttle (the in-app one is global + in-memory; fine for
  single-replica homelab, but a load-balanced deployment would want Redis-backed
  or proxy-level rate limiting).
- Multi-user, roles, email password reset.
