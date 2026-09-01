# Dashboard login: username + password + TOTP 2FA — design

**Date:** 2026-08-31
**Status:** Approved for planning

## Summary

The dashboard already ships an optional authentication gate (next-auth v4)
with two mutually exclusive modes: a single shared **password** (no
username) or **OIDC**. This work extends the password mode into a
**username + password + optional TOTP 2FA** flow for a single user.

- Username becomes **required** for password auth (breaking change for
  existing `HOMEPAGE_AUTH_PASSWORD`-only deployments).
- 2FA is **opt-in**, enabled from a new in-app **Security** page that
  shows a QR code for an authenticator app.
- Sign-in becomes **two-step**: username + password, then (if 2FA is on)
  a 6-digit code.
- OIDC mode is untouched.

## Goals / non-goals

**Goals**

- Single-user credential login hardened with a second factor.
- 2FA enrollment entirely in-app (scan QR, confirm code) — no manual
  secret generation.
- Backward-compatible sign-in page shell (same glass card, background,
  theme sync) and same middleware protection model.
- Identical failure logging so the existing fail2ban / CrowdSec filter
  (`<nextauth> Failed password sign-in attempt`) keeps working.

**Non-goals**

- Multiple users / a user database.
- Recovery codes. Losing the authenticator is recovered by deleting the
  server-side state file (`config/auth.json`).
- Application-level rate limiting (still delegated to the reverse proxy,
  as documented today).
- WebAuthn / passkeys, email or SMS factors.
- Any change to OIDC mode.

## Current state (for context)

- `src/utils/env.js` — `isAuthEnabled()` reads `HOMEPAGE_AUTH_ENABLED === "true"`.
- `src/pages/api/auth/[...nextauth].js` — startup env validation; builds
  either an OIDC provider or a `CredentialsProvider` that checks one
  password with `createHash("sha256")` + `timingSafeEqual`. Returns
  `{}` (empty) when auth is disabled. `session.strategy = "jwt"`.
- `src/pages/auth/signin.jsx` — single password field; `getServerSideProps`
  exposes `getProviders()` output plus a whitelist of public settings
  (`theme`, `color`, `title`, `background`, `backgroundOpacity`).
- `src/middleware.js` — when auth is on, every page and every `/api/*`
  route except `/api/healthcheck` requires a JWT; pages redirect to
  `/auth/signin`, API routes get `401 { error: "Unauthorized" }`.
  Matcher negative-lookahead already exempts `api/auth` and `auth/`.
- `src/components/layout/NavHeader.jsx` — `NAV_ITEMS` array
  (Dashboard / Backups / Widgets); adding a page = adding an entry.
- `src/components/toggles/signout.jsx` — sign-out button, shown when
  `useSession()` status is `authenticated`.
- `src/utils/config/config.js` — `CONF_DIR` (`HOMEPAGE_CONFIG_DIR` or
  `<cwd>/config`), the mounted volume; fs helpers pattern to follow.
- `progress.md` lists "TOTP-based 2FA login" under _Not yet implemented_.

## Architecture

### Two-step verification approach

Chosen: **pre-check endpoint + one final `signIn`.**

1. Step 1 of the sign-in page calls a new session-less
   `POST /api/auth/2fa-check` with `{ username, password }`.
2. That endpoint verifies the credentials and responds
   `200 { twoFactorEnabled: boolean }` or `401`.
3. If `twoFactorEnabled` is false, the client immediately calls
   `signIn("credentials", { username, password })`.
4. If true, the client renders step 2 and then calls
   `signIn("credentials", { username, password, token })`.
5. `authorize()` in `[...nextauth].js` re-validates **everything** and is
   the only place a session is minted.

No server-side state is held between the two steps. The password crosses
TLS twice and is verified twice (a cheap SHA-256 + constant-time compare).

Rejected: a signed intermediate "password OK, awaiting 2FA" token with a
second credentials provider — more moving parts and a larger attack
surface than a single-user tool warrants.

### Units

| Unit                                     | Responsibility                                                                                 | Depends on                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `src/utils/auth/credentials.js`          | `verifyPassword(username, password)` — constant-time username + password check against env     | `node:crypto`, env                         |
| `src/utils/auth/totp-store.js`           | `readTotpState()`, `writeTotpState(state)`, `clearTotpState()` — read/write `config/auth.json` | `fs`, `CONF_DIR`                           |
| `src/utils/auth/totp.js`                 | `generateEnrollment(username)`, `qrDataUrl(otpauthUrl)`, `verifyToken(token)`                  | `otplib`, `qrcode`, `totp-store`, settings |
| `src/pages/api/auth/2fa-check.js`        | Session-less credential pre-check; returns `{ twoFactorEnabled }`                              | `credentials`, `totp-store`, logger        |
| `src/pages/api/auth/[...nextauth].js`    | `authorize()` = password + (conditional) TOTP; startup validation                              | `credentials`, `totp`                      |
| `src/pages/api/security/totp/enroll.js`  | Session-protected; returns `{ secret, otpauthUrl, qrDataUrl }`                                 | `totp`, `totp-store`                       |
| `src/pages/api/security/totp/confirm.js` | Session-protected; verifies `{ secret, token }`, then persists                                 | `totp`, `totp-store`                       |
| `src/pages/api/security/totp/disable.js` | Session-protected; verifies current `{ token }`, then clears                                   | `totp`, `totp-store`                       |
| `src/pages/security.jsx`                 | Security page — 2FA status + enable/disable UI                                                 | the `/api/security/totp/*` routes          |
| `src/pages/auth/signin.jsx`              | Two-step form (credentials → totp)                                                             | `/api/auth/2fa-check`, `signIn`            |
| `src/components/layout/NavHeader.jsx`    | + Security nav entry                                                                           | —                                          |

### Why the endpoints split across two path prefixes

- `/api/auth/2fa-check` — **must be reachable unauthenticated** (the user
  has no session yet). `/api/auth/*` is already exempt from the
  middleware matcher.
- `/api/security/totp/*` — **must require a session** (only a logged-in
  user manages their own 2FA). `/api/security/*` is covered by the
  middleware, so no per-route auth code is needed beyond a defensive
  `getToken`/`getServerSession` check.

## Configuration & storage

### Environment variables

| Var                          | Change                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOMEPAGE_AUTH_USERNAME`     | **New, required** when auth is enabled and OIDC is not configured. Startup throws if missing, same as the existing password/secret checks. |
| `HOMEPAGE_AUTH_PASSWORD`     | Unchanged — still required in password mode, still hashed with SHA-256 + `timingSafeEqual`.                                                |
| all OIDC / secret / URL vars | Unchanged.                                                                                                                                 |

Breaking change: existing password-only deployments must add
`HOMEPAGE_AUTH_USERNAME`. Called out in the changelog and install docs.

### State file: `config/auth.json`

App-managed, written to `join(CONF_DIR, "auth.json")` with mode `0600`.

```json
{ "totp": { "secret": "<base32>", "enabledAt": "2026-08-31T12:00:00.000Z" } }
```

- Absent file, `{}`, or a missing `totp` key ⇒ 2FA disabled.
- Unparseable / unreadable file ⇒ treated as disabled + a `warn` log; the
  app never crashes on it.
- `clearTotpState()` writes `{}` (rather than deleting) to keep the file's
  permissions and ownership stable.

## Component details

### `src/utils/auth/credentials.js`

```
verifyPassword(username, password) -> boolean
```

- Reads `HOMEPAGE_AUTH_USERNAME` / `HOMEPAGE_AUTH_PASSWORD` (or their
  pre-hashed digests, mirroring the current module-level digest).
- Compares username and password each with a constant-time comparison
  over SHA-256 digests, so a wrong username and a wrong password take the
  same time and neither short-circuits.
- Returns `false` (never throws) when either env var is unset or the
  input is not a string.
- Shared by `authorize()` and `2fa-check` so the two cannot drift.

### `src/utils/auth/totp-store.js`

- `readTotpState()` → parsed object or `{}` on any error (with a
  `createLogger("auth").warn(...)` on parse/read failure).
- `writeTotpState(state)` → `writeFileSync(path, JSON.stringify(state), { mode: 0o600 })`;
  throws on failure so callers can return `500`.
- `clearTotpState()` → `writeTotpState({})`.
- `isTotpEnabled()` helper → `Boolean(readTotpState().totp?.secret)`.

### `src/utils/auth/totp.js`

- `generateEnrollment(username)` → `{ secret, otpauthUrl }` using
  `authenticator.generateSecret()` and `authenticator.keyuri(username,
issuer, secret)`, where `issuer = getSettings().title || "Homepage"`.
- `qrDataUrl(otpauthUrl)` → `await QRCode.toDataURL(otpauthUrl)`.
- `verifyToken(token, secret?)` → `authenticator.check(token, secret ??
readTotpState().totp.secret)`. `otplib` default step 30s, window ±1.
  Returns `false` for a malformed token or when no secret is available.

### `src/pages/api/auth/2fa-check.js`

- `POST` only; any other method → `405`.
- Body `{ username, password }`.
- `verifyPassword` false → `logFailedPasswordSignIn()` (imported/shared
  with `[...nextauth].js`, same message string) → `401 { error: "Invalid
credentials" }`.
- `verifyPassword` true → `200 { twoFactorEnabled: isTotpEnabled() }`.
- Never reveals `twoFactorEnabled` on the `401` path.
- No body / not JSON → `400`.

### `src/pages/api/auth/[...nextauth].js` changes

- `CredentialsProvider.credentials` becomes
  `{ username: {...}, password: {...}, token: {...} }`.
- `authorize({ username, password, token })`:
  1. `verifyPassword(username, password)` false → log + `return null`.
  2. `isTotpEnabled()` true → `verifyToken(token)` false → log +
     `return null`.
  3. `return { id: "homepage", name: username }`.
- Startup validation: in the password branch, additionally require
  `HOMEPAGE_AUTH_USERNAME`; extend the existing "Password auth is enabled
  but required settings are missing." throw.
- OIDC branch, logger, events, cookie config: unchanged.

### `src/pages/api/security/totp/*`

All three: `POST` only; defensively call `getToken({ req, secret })` and
`401` if absent (middleware already guarantees this, belt-and-braces).

- **`enroll`** — `isTotpEnabled()` true → `409 { error: "2FA already
enabled" }`. Else `generateEnrollment(session username)` →
  `200 { secret, otpauthUrl, qrDataUrl }`. Nothing is persisted.
- **`confirm`** — body `{ secret, token }`. `verifyToken(token, secret)`
  false → `400 { error: "Invalid code" }`. Else
  `writeTotpState({ totp: { secret, enabledAt: new Date().toISOString() } })`;
  write failure → `500`, state stays disabled. `200 { enabled: true }`.
- **`disable`** — body `{ token }`. Not enabled → `400`. `verifyToken(token)`
  false → `400 { error: "Invalid code" }`. Else `clearTotpState()` →
  `200 { enabled: false }`.

### `src/pages/security.jsx`

- `getServerSideProps` returns `{ initialSettings, twoFactorEnabled }`
  (reuse the `PageBackground` + `getSettings()` pattern from
  `backups.js`; read `isTotpEnabled()` server-side).
- Layout: `PageBackground` wrapper, `<h1>Security</h1>`, a card showing
  **Two-factor authentication: On / Off**.
- **Off** → "Enable 2FA" button:
  1. `POST /api/security/totp/enroll` → render `<img src={qrDataUrl}>`,
     the secret as selectable text, and a 6-digit input.
  2. Submit → `POST /api/security/totp/confirm { secret, token }`.
     Success → flip to "On" state; `400` → inline "Invalid code, try
     again", keep the QR.
  - The `secret` lives only in component state until confirmed.
- **On** → "Disable 2FA" button → prompts for a current 6-digit code →
  `POST /api/security/totp/disable { token }`.
- Styling follows the existing pages/forms (same input and button
  classes as `signin.jsx` / the backups components).

### `src/pages/auth/signin.jsx` changes

- New state: `step` (`"credentials"` | `"totp"`), `username`, `token`
  (keep `password`).
- Keep `getServerSideProps` as-is (providers + public settings). No need
  to expose `twoFactorEnabled` — the pre-check endpoint reports it.
- **Step 1** (`credentials`): username + password fields + "Next →".
  On submit:
  - `fetch("/api/auth/2fa-check", { method: "POST", body: JSON })`.
  - `401` → set an inline "Invalid username or password" error.
  - `200 && !twoFactorEnabled` → `signIn("credentials", { redirect:
true, callbackUrl, username, password })`.
  - `200 && twoFactorEnabled` → `setStep("totp")`.
- **Step 2** (`totp`): single 6-digit field
  (`inputMode="numeric"`, `autoComplete="one-time-code"`,
  `maxLength={6}`), "Verify" button, and a "← Back" link that returns to
  step 1 and clears `token`.
  - On submit: `signIn("credentials", { redirect: true, callbackUrl,
username, password, token })`.
  - `router.query.error` present → "Invalid code, please try again"
    while staying on step 2 (the page reloads with `?error` after a
    failed `signIn` redirect; guard so step 2 renders when `username`
    was lost by only showing the error and a "Start over" link if
    `username`/`password` state is empty).
- OIDC branch and "Authentication not configured" branch: unchanged.
- Existing background / theme / glass-card markup: unchanged.

### `src/components/layout/NavHeader.jsx`

Add `{ href: "/security", label: "Security", icon: BiLockAlt }` to
`NAV_ITEMS` (import `BiLockAlt` from `react-icons/bi`).

## Data flow

```
Sign-in (2FA on):
  browser  --POST /api/auth/2fa-check {username,password}-->  verifyPassword
           <--200 {twoFactorEnabled:true}--
  browser  renders step 2
  browser  --signIn("credentials",{username,password,token})-->  authorize()
                                                                  verifyPassword + verifyToken
           <--JWT session cookie--  (or ?error=CredentialsSignin)

Enable 2FA:
  security page --POST /api/security/totp/enroll-->  generateEnrollment
                <--{secret,otpauthUrl,qrDataUrl}--   (nothing persisted)
  user scans QR, enters code
  security page --POST /api/security/totp/confirm {secret,token}-->  verifyToken(token,secret)
                                                                     writeTotpState({totp:{...}})
                <--200 {enabled:true}--
```

## Error handling

| Situation                                                   | Behaviour                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `auth.json` missing / `{}` / no `totp`                      | 2FA disabled; normal flow                                                         |
| `auth.json` unparseable / unreadable                        | 2FA treated as disabled; `warn` log; no crash                                     |
| `HOMEPAGE_AUTH_USERNAME` missing at startup (password mode) | Startup throw with a clear message                                                |
| Wrong password at `2fa-check`                               | `401`; `Failed password sign-in attempt` logged; `twoFactorEnabled` not disclosed |
| Wrong TOTP at `signIn`                                      | next-auth redirect with `?error=CredentialsSignin`; step 2 shows "Invalid code"   |
| `enroll` while already enabled                              | `409`                                                                             |
| `confirm` with wrong code                                   | `400`; nothing persisted                                                          |
| `confirm` write failure                                     | `500`; 2FA stays disabled                                                         |
| `disable` without a valid code                              | `400`; state unchanged                                                            |
| Lost authenticator                                          | Operator deletes / empties `config/auth.json` (documented)                        |

## Testing (vitest, TDD)

Following `src/__tests__/` layout:

- `src/utils/auth/totp.test.js` — `verifyToken` with a fixed secret and
  mocked time; accepts the current step and ±1 window, rejects outside
  it and rejects malformed tokens. `generateEnrollment` shape + issuer
  from settings.
- `src/utils/auth/credentials.test.js` — correct pair → true; wrong
  username, wrong password, unset env, non-string input → false.
- `src/utils/auth/totp-store.test.js` — round-trip; corrupt file →
  `{}` + warn; write mode `0600`.
- `src/__tests__/pages/api/auth/2fa-check.test.js` — `405` non-POST;
  `401` + failure log on bad password; `200 { twoFactorEnabled }` shape
  for both enabled/disabled; `twoFactorEnabled` absent on `401`.
- `src/__tests__/pages/api/auth/[...nextauth].test.js` (extend) —
  `authorize`: good password + 2FA off → user; good password + 2FA on +
  no/bad token → null; good password + 2FA on + good token → user; bad
  password → null + log.
- `src/__tests__/pages/api/security/totp/{enroll,confirm,disable}.test.js`
  — method guard; `enroll` shape + `409`; `confirm` rejects bad code and
  persists on good; `disable` requires a valid code.
- `src/__tests__/pages/auth/signin.test.jsx` (extend) — step 1 → step 2
  transition when `twoFactorEnabled`; direct `signIn` when disabled;
  `401` shows credential error; `?error` shows code error; "Back"
  resets to step 1.
- `src/components/layout/NavHeader.test.jsx` (extend) — Security link
  rendered.
- `src/middleware.test.js` (extend) — `/api/security/totp/enroll`
  without a token → `401`; `/api/auth/2fa-check` passes through.

## Documentation

- `docs/installation/index.md` — under _Security & Authentication_:
  `HOMEPAGE_AUTH_USERNAME` now required for password login; describe 2FA
  setup via the Security page; note that recovery from a lost
  authenticator is emptying `config/auth.json`; keep the existing
  reverse-proxy rate-limit warning and note it also covers
  `/api/auth/2fa-check`.
- `progress.md` — move "TOTP-based 2FA login" out of _Not yet
  implemented_ into the shipped section; record the breaking
  `HOMEPAGE_AUTH_USERNAME` requirement.
- Changelog / release note — breaking change callout.

## Dependencies

- `otplib` — TOTP generation and verification.
- `qrcode` — server-side QR data-URL for the enrollment page.

## Out-of-scope follow-ups

- Recovery codes.
- Multi-user credentials.
- WebAuthn / passkeys.
- Per-route or per-IP rate limiting inside the app.
