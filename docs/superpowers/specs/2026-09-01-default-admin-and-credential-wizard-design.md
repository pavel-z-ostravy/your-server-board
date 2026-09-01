# Default admin/admin + in-app credential & 2FA wizard — design

**Date:** 2026-09-01
**Status:** Draft for review
**Builds on:** `docs/superpowers/specs/2026-08-31-dashboard-2fa-login-design.md` (username + password + TOTP 2FA, already shipped on `dev`)

## Summary

The dashboard currently: auth is opt-in (`HOMEPAGE_AUTH_ENABLED=true`), credentials come **only** from `HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD` env vars (startup throws without them), TOTP 2FA is enrolled on `/security`.

This change:

- **Login is on by default.** `isAuthEnabled()` returns true unless `HOMEPAGE_AUTH_ENABLED=false`.
- **Built-in default credentials `admin` / `admin`** when nothing else is configured — no startup crash, no env required.
- **Credentials become editable in-app** and persist to `config/auth.json` (scrypt-hashed password). Env vars, when set, remain an override that locks the in-app editor.
- **A persistent warning banner** shows on every page while the effective credentials are still the built-in default.
- **A two-step wizard on `/security`**: step 1 changes username + password (verifying the current password); step 2 optionally sets up 2FA in the same sitting.
- **`NEXTAUTH_SECRET` is auto-generated and persisted** to `config/auth.json` when not supplied, so the always-on gate works with zero configuration.
- **OIDC mode is unchanged** and, when active, suppresses all of the above (default creds, banner, wizard).

### Breaking change

Any existing deployment that did **not** set `HOMEPAGE_AUTH_ENABLED` will, after this upgrade, present a login screen accepting `admin` / `admin`. Operators who want no login must set `HOMEPAGE_AUTH_ENABLED=false`. Called out in the changelog, `README.md`, and `docs/installation/index.md`.

## Goals / non-goals

**Goals**
- Zero-config secure-by-default: a fresh deployment has a login gate with obvious-but-flagged default credentials the operator is pushed to change.
- Credentials changeable without touching env / redeploying.
- One flow to change credentials and (optionally) turn on 2FA.
- Session survival across restarts (persisted secret).
- No regression to OIDC mode or to env-var-driven credential management.

**Non-goals**
- Multiple users / roles.
- Password reset via email, recovery codes (unchanged: 2FA recovery is deleting `config/auth.json`).
- Rate limiting (still delegated to the reverse proxy).
- Renaming `middleware.js` → `proxy.js` (Next 16 deprecation; separate task).
- Changing the two-step **sign-in** page (username+password → optional code) — it already works and is untouched here.

## Current state (post-2026-08-31 merge, for context)

- `src/utils/env.js` — `isAuthEnabled()` = `process.env.HOMEPAGE_AUTH_ENABLED === "true"`.
- `src/utils/auth/credentials.js` — `verifyPassword(u,p)` reads the two env vars, `sha256` + `timingSafeEqual`, returns `false` if unset / non-string; `logFailedPasswordSignIn()`.
- `src/utils/auth/totp-store.js` — reads/writes `config/auth.json` (`{ totp: { secret, enabledAt } }`), `0600` + `chmodSync`, `readTotpState` / `writeTotpState` / `clearTotpState` / `isTotpEnabled`.
- `src/utils/auth/totp.js` — `generateEnrollment` / `qrDataUrl` / `verifyToken` (`authenticator.options = { window: 1 }`).
- `src/utils/auth/mode.js` — `passwordAuthActive()` = `isAuthEnabled() && !hasOidcConfig && Boolean(HOMEPAGE_AUTH_PASSWORD)`.
- `src/pages/api/auth/[...nextauth].js` — module-load startup validation **throws** without `NEXTAUTH_URL`, without a ≥32-char secret, and (password mode) without username+password+secret. `authorize({username,password,token})` → `verifyPassword` then (if `isTotpEnabled()`) `verifyToken`. `useSecureCookies: parsedAuthUrl?.protocol === "https:"`.
- `src/pages/api/auth/2fa-check.js` — `404` when `!passwordAuthActive()`, else pre-check.
- `src/pages/api/security/totp/{enroll,confirm,disable}.js` — session-protected (middleware + defensive `getServerSession`).
- `src/pages/security.jsx` — one card, `passwordAuthEnabled` prop gates it; enable/enrolling/disable phases.
- `src/middleware.js` — `authEnabled` + `authSecret` computed at module load; when `authEnabled`, `getToken` → redirect `/auth/signin` (pages) or `401` (`/api/`). Matcher exempts `_next/*`, static, `api/auth`, `auth/`.
- `src/pages/_app.jsx` — `<SessionProvider>` → `<SWRConfig>` → providers → `<NavHeader />` + `<Component />`.
- `src/components/layout/NavHeader.jsx` — `NAV_ITEMS` incl. `{ href: "/security", label: "Security", icon: BiLockAlt }`.
- Deploy: Docker on lxc200, `/opt/stacks/your-server-board`, `docker compose up -d --build`, `./config` volume → `/app/config`, `docker-entrypoint.sh` runs as root then drops to a non-root user via `su-exec`.

## Architecture

### Credential resolution — one function, three sources

`verifyPassword(username, password): boolean` (rewritten) checks, in order, and **does not fall through** once a source is authoritative:

1. **Env override** — if BOTH `HOMEPAGE_AUTH_USERNAME` and `HOMEPAGE_AUTH_PASSWORD` are set: constant-time compare against them (today's `sha256`+`timingSafeEqual` path). Return the result.
2. **Stored user** — else if `config/auth.json` has a `user` object: `scrypt`-verify `password` against `user.passwordHash` **and** constant-time compare `username` against `user.username`. Return the result.
3. **Built-in default** — else: constant-time compare against `"admin"` / `"admin"`.

Never throws; non-string input → `false`.

Two companion predicates (in `mode.js` or a new `credentials-store.js`, see units):
- `managedByEnv()` = `Boolean(process.env.HOMEPAGE_AUTH_USERNAME && process.env.HOMEPAGE_AUTH_PASSWORD)`.
- `usingDefaultCredentials()` = `!managedByEnv() && !readUser()` — i.e. the effective credentials are the built-in `admin`/`admin`.

### Always-on, and the secret

- `isAuthEnabled()` → `process.env.HOMEPAGE_AUTH_ENABLED !== "false"`. Only the exact string `"false"` disables. (`""`, unset, `"true"`, anything else → enabled.)
- `passwordAuthActive()` → `isAuthEnabled() && !hasOidcConfig`. (The password source is always available now — at minimum the default — so the `HOMEPAGE_AUTH_PASSWORD` clause is dropped.)
- **`NEXTAUTH_SECRET`**: a new lean module `src/utils/auth/secret.js` (imports only `node:fs`, `node:path`, `node:crypto`) exposes:
  - `resolveAuthSecret()` → `process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET || <config/auth.json .secret>` or `undefined`.
  - `ensureAuthSecret()` → `resolveAuthSecret()`; if none, generate `randomBytes(32).toString("base64")`, merge `{ secret }` into `config/auth.json` (preserving `user`/`totp`), `chmodSync 0600`, set `process.env.NEXTAUTH_SECRET`, return it.
  - It replicates `CONF_DIR` inline (`process.env.HOMEPAGE_CONFIG_DIR || join(process.cwd(), "config")`) to avoid importing the heavy `utils/config/config` into the middleware bundle.
  - Both `src/pages/api/auth/[...nextauth].js` and `src/middleware.js` call `ensureAuthSecret()` at module load. Within one Node process (the normal `next start` / `next dev` / single container case) the first module to initialise generates + persists + sets `process.env`; the second reads it back. **Multi-process / multi-replica deployments must set `HOMEPAGE_AUTH_SECRET` explicitly** (documented) — otherwise each process could generate a different secret. `docker-entrypoint.sh` also gets a pre-generate step (below) so the Docker path never races.
- **`NEXTAUTH_URL`**: use `HOMEPAGE_EXTERNAL_URL` when set (still validated: absolute http(s), no creds/query/fragment). When **not** set in password mode, leave `NEXTAUTH_URL` unset — next-auth v4 derives the origin from request headers, which is fine for the credentials provider (no external redirects). The "NEXTAUTH_URL missing" warning routes through the sanitized logger.
- **OIDC mode still requires `HOMEPAGE_EXTERNAL_URL`** (registered redirect URIs) — the startup throw for a missing URL is kept, but scoped to `hasOidcConfig`.
- `useSecureCookies`: `parsedAuthUrl?.protocol === "https:"` — unchanged; `false` when no URL (LAN http), `true` when `HOMEPAGE_EXTERNAL_URL` is https.
- The ≥32-char secret-length check stays but applies to the resolved/generated secret (generated is 44 chars).

### Units

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `src/utils/auth/secret.js` | `resolveAuthSecret()`, `ensureAuthSecret()` — the JWT signing secret, lean deps only | `node:fs/path/crypto` |
| `src/utils/auth/credentials-store.js` | `readUser()`, `writeUser({username,password})` (scrypt), `clearUser()`, `usingDefaultCredentials()`, `managedByEnv()` — the `user` section of `config/auth.json` | `node:fs/path/crypto`, `CONF_DIR` |
| `src/utils/auth/credentials.js` | `verifyPassword` (3-source), `logFailedPasswordSignIn` (unchanged) | `credentials-store`, `node:crypto` |
| `src/utils/env.js` | `isAuthEnabled()` — default true | — |
| `src/utils/auth/mode.js` | `passwordAuthActive()` — drop the password clause | `env` |
| `src/pages/api/auth/[...nextauth].js` | `ensureAuthSecret()` at load; relax URL/secret throws; OIDC-only URL throw; `authorize` unchanged | `secret`, `credentials`, `totp*` |
| `src/middleware.js` | `ensureAuthSecret()` at load for `getToken`; `authEnabled` now default-true | `secret`, `env` |
| `src/pages/api/security/credentials.js` | `POST` — session; change username+password after verifying current; `409` if `managedByEnv()` | `credentials`, `credentials-store` |
| `src/pages/api/security/credentials-status.js` | `GET` — session; `{ usingDefaultCredentials, managedByEnv, username }` for the banner | `credentials-store` |
| `src/components/layout/CredentialsWarning.jsx` | Full-width banner; SWR on `credentials-status`; shows iff authenticated + `usingDefaultCredentials` | `next-auth/react`, `swr` |
| `src/pages/security.jsx` | Add an **Account** card with the 2-step wizard; keep the 2FA card | the two new endpoints + existing totp endpoints |
| `src/pages/_app.jsx` | Render `<CredentialsWarning />` after `<NavHeader />` | — |
| `docker-entrypoint.sh` | Pre-generate `HOMEPAGE_AUTH_SECRET` into `config/auth.json` + env if absent | — |
| `docker-compose.yml`, `.env.example` | Pass through all `HOMEPAGE_AUTH_*` / OIDC vars (optional) | — |

### Storage: `config/auth.json`

```json
{
  "secret": "<base64, 44 chars>",
  "user": { "username": "myname", "passwordHash": "scrypt$16384$8$1$<saltB64>$<hashB64>", "updatedAt": "2026-09-01T…Z" },
  "totp": { "secret": "<base32>", "enabledAt": "2026-09-01T…Z" }
}
```

- Any of `secret` / `user` / `totp` may be absent.
- All writers (`secret.js`, `credentials-store.js`, `totp-store.js`) **read-modify-write the whole object** so they never clobber each other's keys, and each `chmodSync(path, 0o600)` after writing.
- `writeTotpState` is refactored to a shared `readAuthFile()` / `writeAuthFile(obj)` helper (either exported from `totp-store.js` or a new `auth-file.js`) that the three modules share. Corrupt/unreadable file → treated as `{}` + a `warn` (existing behaviour), and a subsequent write overwrites it.

### Password hashing

`scrypt` from `node:crypto` (no dependency):

- `writeUser`: `salt = randomBytes(16)`; `hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })`; store `scrypt$16384$8$1$<salt base64>$<hash base64>`.
- verify: parse params + salt, recompute, `timingSafeEqual`. Unknown format / parse failure → `false`.
- Password rules on change: **min 8 characters**; new `username` trimmed, non-empty, `[A-Za-z0-9._-]{1,64}`; the pair may not be `admin`/`admin`.

## Component details

### `src/pages/api/security/credentials.js`

- `POST` only → `405`. Session required (middleware guards `/api/security/*`; defensive `getServerSession` → `401`).
- `managedByEnv()` → `409 { error: "Credentials are managed by environment variables." }`.
- Body `{ currentPassword, username, password }`.
- `!verifyPassword(effectiveUsername, currentPassword)` → `400 { error: "Current password is incorrect." }` + `logFailedPasswordSignIn()`. (`effectiveUsername` = stored `user.username` or `"admin"`.)
- Validation failures → `400 { error: "<specific message>" }` (weak password, bad username chars, unchanged defaults).
- On success: `writeUser({ username, password })` → `200 { username }`. Write failure → `500 { error: "Could not save credentials." }` + `createLogger("auth").error(...)`.

### `src/pages/api/security/credentials-status.js`

- `GET` only → `405`. Session required → `401`.
- `200 { usingDefaultCredentials: boolean, managedByEnv: boolean, username: string }` where `username` = stored / env / `"admin"`.

### `src/components/layout/CredentialsWarning.jsx`

- `const { status } = useSession();` — render nothing unless `status === "authenticated"`.
- `useSWR("/api/security/credentials-status")` — render nothing unless `data?.usingDefaultCredentials`.
- Renders a full-width bar: `bg-red-600 text-white text-sm`, `px-4 py-2 pl-14 sm:pl-16` (left padding clears the absolutely-positioned NavHeader hamburger), text **"You're signed in with the default admin / admin credentials."** + a `<Link href="/security">` styled as an underlined button: **"Change them now"**. Not dismissible. `role="alert"`.
- Placed in `_app.jsx` immediately after `<NavHeader />`, before `<Component />`, so it sits at the top of every page and pushes content down.

### `src/pages/security.jsx` — Account card + wizard

New **Account** card above the existing 2FA card:

- **Summary (idle):** "Signed in as **`<username>`**." + button **"Change username & password"**. When `managedByEnv` (new prop from `getServerSideProps`): instead show "Credentials are managed by environment variables (`HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD`)." and no button.
- **Wizard step 1 (`account-credentials`):** fields — `Current password`, `New username` (prefilled with current), `New password`, `Confirm new password`. Submit → `POST /api/security/credentials`. On `400` show the returned message inline. On `200`: update the displayed username, `mutate("/api/security/credentials-status")` (drops the banner), advance to step 2.
- **Wizard step 2 (`account-2fa`):** heading "Add two-factor authentication?" + two buttons: **"Set up 2FA"** and **"Not now"**.
  - **"Not now"** → wizard closes, card returns to summary.
  - **"Set up 2FA"** → reuse the existing `enrolling` phase (calls `/api/security/totp/enroll` then `/confirm`). On confirm success → `enabled = true`, wizard closes. (If 2FA is already on, step 2 is skipped and the wizard closes after step 1.)
- The existing **Two-factor authentication** card stays exactly as it is for later standalone enable/disable.
- `getServerSideProps` adds `managedByEnv` and `currentUsername` to props (alongside `passwordAuthEnabled`, `twoFactorEnabled`).

### `src/pages/api/auth/[...nextauth].js` changes

- At module load, before the validation block: `const resolvedSecret = ensureAuthSecret();` and `if (!process.env.NEXTAUTH_SECRET) process.env.NEXTAUTH_SECRET = resolvedSecret;`.
- `NEXTAUTH_URL` mapping unchanged (`HOMEPAGE_EXTERNAL_URL` → `NEXTAUTH_URL` if set).
- In the `if (authEnabled)` block:
  - Only `parse + validate` the URL **when `process.env.NEXTAUTH_URL` is set**; skip the "missing" throw for password mode.
  - Keep a `if (hasOidcConfig && !process.env.NEXTAUTH_URL) throw` (OIDC needs an absolute external URL).
  - Password-mode branch: drop `!homepageAuthPassword || !homepageAuthUsername` from the throw condition (defaults cover it); keep `!process.env.NEXTAUTH_SECRET` as a safety net (should never fire after `ensureAuthSecret`).
  - Keep the ≥32-char check on `process.env.NEXTAUTH_SECRET`.
- `authorize`, `useSecureCookies`, logger, events, the `!authEnabled → res.json({})` handler: unchanged.

### `src/middleware.js` changes

- Replace `const authSecret = process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET;` with `const authSecret = ensureAuthSecret();` (import from `utils/auth/secret`).
- `const authEnabled = isAuthEnabled();` unchanged in form; its value now defaults true.
- No matcher change. `/api/security/credentials` and `/api/security/credentials-status` are covered by the existing matcher (not under `api/auth`).

### `docker-entrypoint.sh`

Add, before dropping privileges: if `HOMEPAGE_AUTH_SECRET` is unset **and** `config/auth.json` has no `.secret`, generate one and both (a) write `{ "secret": "…" }` merged into `config/auth.json` (via a `node -e` one-liner using the built image's node, or `python3`/`jq` already present — pick what the base image has; Alpine has neither `jq` nor python by default, so `node -e`), and (b) `export HOMEPAGE_AUTH_SECRET`. This makes the Docker path deterministic and race-free. If the file write fails (read-only volume), log a warning and continue with just the exported env var (sessions won't survive a restart, but the app runs).

### `docker-compose.yml` / `.env.example`

`docker-compose.yml` `environment:` gains (all optional, `${VAR:-}` form so unset = absent, not empty-string-set):

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

`${VAR:-}` yields an empty string when unset, which the app must treat as "not set" — so `[...nextauth].js` / `mode.js` / `credentials.js` must use **truthiness** checks (`Boolean(x)` / `if (!x)`), not `x !== undefined`. Audit the existing reads; they already use truthiness. `.env.example` documents all `YSB_*` knobs with the default-on note.

## Data flow

```
First run (Docker, nothing configured):
  entrypoint → no HOMEPAGE_AUTH_SECRET, no .secret → generate, write config/auth.json, export
  [...nextauth] load → ensureAuthSecret() reads env → authEnabled=true, password mode
  GET /  → middleware: no token → redirect /auth/signin
  signin → POST /api/auth/2fa-check {admin,admin} → verifyPassword: default branch → 200 {twoFactorEnabled:false}
        → signIn("credentials",{admin,admin}) → authorize → verifyPassword ok → session
  GET /  → CredentialsWarning: SWR /api/security/credentials-status → {usingDefaultCredentials:true} → banner

Change credentials:
  /security → wizard step 1 → POST /api/security/credentials {currentPassword:"admin", username:"me", password:"…"}
            → verifyPassword("admin","admin") ok → writeUser → 200
            → mutate(credentials-status) → {usingDefaultCredentials:false} → banner gone
            → step 2 "Set up 2FA" → /api/security/totp/enroll → /confirm → totp saved
  next sign-in: verifyPassword → stored-user branch (scrypt); 2FA code required
```

## Error handling

| Situation | Behaviour |
|-----------|-----------|
| No secret anywhere, single process | `ensureAuthSecret()` generates + persists on first module load; second module reads it |
| No secret, multi-process, `HOMEPAGE_AUTH_SECRET` unset | Each process may generate its own → sessions inconsistent. Documented: set `HOMEPAGE_AUTH_SECRET`. Entrypoint mitigates for Docker |
| `config/auth.json` unwritable (read-only volume) | `ensureAuthSecret` / `writeUser` throw is caught by callers: secret falls back to an in-memory value + `warn` (sessions don't survive restart); `writeUser` → API `500` |
| `config/auth.json` corrupt | Treated as `{}` + `warn`; next write overwrites |
| `HOMEPAGE_AUTH_ENABLED=false` | `isAuthEnabled()` false → no gate, no banner, `/security` shows the "authentication disabled" state, `2fa-check` → `404` |
| OIDC configured but no `HOMEPAGE_EXTERNAL_URL` | Startup throw (unchanged intent, now OIDC-scoped) |
| `HOMEPAGE_EXTERNAL_URL` malformed | Startup throw (unchanged) |
| Env username+password set | `verifyPassword` uses env only; `/api/security/credentials` → `409`; no banner; wizard step 1 hidden |
| Wrong current password in wizard | `400` + `logFailedPasswordSignIn()`; nothing written |
| New password < 8 chars / bad username / still admin/admin | `400` with a specific message; nothing written |
| `writeUser` succeeds, step 2 enroll fails | Credentials are already changed (banner gone); user retries 2FA from the standalone card |

## Testing (Vitest)

New / reworked:

- `src/utils/auth/secret.test.js` — `resolveAuthSecret` precedence (env → HOMEPAGE_AUTH_SECRET → file → undefined); `ensureAuthSecret` generates ≥32-char base64, persists to `config/auth.json` preserving `user`/`totp`, sets `process.env.NEXTAUTH_SECRET`, is idempotent on a second call; unwritable dir → returns a value + warns, no throw.
- `src/utils/auth/credentials-store.test.js` — `writeUser`/`readUser` round-trip; scrypt hash format + verify; `clearUser`; `usingDefaultCredentials` / `managedByEnv` truth table; whole-object preservation when `totp`/`secret` already present; `0600`.
- `src/utils/auth/credentials.test.js` (extend) — `verifyPassword` all three branches and their precedence: env set → env only (stored/default ignored); stored user → scrypt path; neither → `admin`/`admin`; wrong username with correct stored password → false; non-string → false; still constant-time (no throw on length mismatch).
- `src/utils/env.test.js` (new) — `isAuthEnabled`: unset → true, `""` → true, `"true"` → true, `"false"` → false, `"0"` → true.
- `src/utils/auth/mode.test.js` (update) — `passwordAuthActive` = `isAuthEnabled() && !hasOidcConfig` regardless of `HOMEPAGE_AUTH_PASSWORD`.
- `src/__tests__/pages/api/auth/[...nextauth].test.js` (rework) — does **not** throw with auth on and no secret/URL/creds (generates secret, password mode from defaults); still throws for OIDC config without `HOMEPAGE_EXTERNAL_URL`; still throws for malformed `HOMEPAGE_EXTERNAL_URL`; `authEnabled` true by default, false only for `HOMEPAGE_AUTH_ENABLED=false`; `authorize` with default `admin`/`admin` → user; with stored user → user; `useSecureCookies` false without URL, true with https URL.
- `src/middleware.test.js` (update) — default-on: no `HOMEPAGE_AUTH_ENABLED` → protected (redirect / `401`); `=false` → pass-through; `getToken` called with the resolved secret; `/api/security/credentials` unauthenticated → `401`.
- `src/__tests__/pages/api/security/credentials.test.js` (new) — `405`; `401` no session; `409` when env-managed; `400` wrong current password (+ log); `400` weak password / bad username / unchanged-default; `200` writes user + returns username; `500` on write failure.
- `src/__tests__/pages/api/security/credentials-status.test.js` (new) — `405` non-GET; `401` no session; response shape for default / stored / env cases.
- `src/components/layout/CredentialsWarning.test.jsx` (new) — hidden when unauthenticated; hidden when `usingDefaultCredentials:false`; shown (with the `/security` link) when authenticated + default; `role="alert"`.
- `src/__tests__/pages/security.test.jsx` (rework) — Account card summary shows username; `managedByEnv` → no change button, explanatory text; wizard step 1 validation + success advances to step 2 + `mutate` called; step 2 "Not now" closes; step 2 "Set up 2FA" runs enroll/confirm; existing 2FA-card tests still pass.
- `src/__tests__/pages/auth/signin.test.jsx` (light) — a default `admin`/`admin` sign-in still completes (pre-check `200`, `signIn` ok, navigates).
- `src/pages/api/mcp/index.test.js` — audit for the `isAuthEnabled` default flip (tests that assumed auth-off by absence of the env var must now set `HOMEPAGE_AUTH_ENABLED=false`).

## Documentation

- `docs/installation/index.md` — rewrite Security & Authentication: **login is on by default**, accepts `admin` / `admin`, change it immediately from the Security page (or set `HOMEPAGE_AUTH_USERNAME`/`HOMEPAGE_AUTH_PASSWORD`); disable entirely with `HOMEPAGE_AUTH_ENABLED=false`; `NEXTAUTH_SECRET` auto-generated to `config/auth.json` (set `HOMEPAGE_AUTH_SECRET` for multi-replica); `HOMEPAGE_EXTERNAL_URL` optional for password mode, required for OIDC and for `Secure` cookies over HTTPS; recovery unchanged (delete `config/auth.json`). Breaking-change admonition.
- `README.md` — update the auth bullet(s) and the security note for default-on + `admin`/`admin`.
- `progress.md` — shipped entry; breaking change (auth on by default).
- `.env.example` — the new `YSB_*` knobs.
- Changelog note.

## Out-of-scope follow-ups

- `middleware.js` → `proxy.js` rename (Next 16).
- Multi-user.
- Password reset flow / email.
- Argon2 (would add a native dependency; scrypt is sufficient and built in).
