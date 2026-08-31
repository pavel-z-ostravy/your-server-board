# Dashboard 2FA Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the dashboard's optional password auth into a single-user username + password + optional TOTP 2FA login.

**Architecture:** Sign-in becomes two-step. Step 1 posts username/password to a new session-less `/api/auth/2fa-check` that answers `{ twoFactorEnabled }`; step 2 (only when 2FA is on) collects a 6-digit code. The final `signIn("credentials", …)` call re-validates password + TOTP in `authorize()`, which stays the only place a session is minted. 2FA is enrolled in-app from a new **Security** page that persists a TOTP secret to an app-managed `config/auth.json`.

**Tech Stack:** Next.js 16 (Pages Router), next-auth v4 (`CredentialsProvider`, `jwt` sessions), `otplib` (TOTP), `qrcode` (enrollment QR), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-dashboard-2fa-login-design.md`

## Global Constraints

- Auth is active only when `HOMEPAGE_AUTH_ENABLED === "true"` (`isAuthEnabled()` from `utils/env`). Every behaviour below is gated on that, exactly as the current code is.
- Password comparison MUST be constant-time over SHA-256 digests (`node:crypto` `createHash` + `timingSafeEqual`), never a raw `===`, and MUST NOT throw on unequal byte lengths (multibyte passwords).
- Every failed password attempt (in `authorize()` AND in `/api/auth/2fa-check`) MUST log exactly `createLogger("nextauth").warn("Failed password sign-in attempt")` — same logger label, same string — so the documented fail2ban/CrowdSec filter keeps matching. The attempted password/username MUST NOT appear in any log line.
- No secret, password, or TOTP token may be returned in an API response except: `/api/security/totp/enroll` returns a freshly generated (not-yet-persisted) secret + otpauth URL + QR data URL to the authenticated user enrolling.
- `config/auth.json` is written with mode `0o600`. A missing/empty/corrupt file means "2FA disabled" and MUST NOT crash or throw out of `readTotpState()`.
- The auth secret floor is unchanged: `NEXTAUTH_SECRET`/`HOMEPAGE_AUTH_SECRET` ≥ 32 chars.
- Path-prefix rule: unauthenticated auth helpers live under `/api/auth/*` (middleware-exempt); session-only helpers live under `/api/security/*` (middleware-protected). Do not move routes between these prefixes.
- Tests: Vitest. API-route handler tests use `test-utils/create-mock-res` (`createMockRes()` → `res.statusCode`, `res.body`, `res.headers`). React tests start with `// @vitest-environment jsdom` and drive interactions with `fireEvent` from `@testing-library/react` (the project convention — do NOT add `@testing-library/user-event`). Module-under-test env manipulation uses `vi.resetModules()` + `process.env = { ...originalEnv }` in `beforeEach`, mirroring `src/__tests__/pages/api/auth/[...nextauth].test.js`.
- Follow existing style: sign-in / security UI uses plain English strings (not `t()`), matching the current `signin.jsx`. Tailwind classes match the existing sign-in form (`rounded-xl border … px-4 py-3 text-sm …`, button `bg-theme-600 …`).
- Commit after every task with a `feat:` / `test:` / `docs:` prefixed message.

---

## File Structure

**New files**
- `src/utils/auth/credentials.js` — `verifyPassword(username, password)`, `logFailedPasswordSignIn()`.
- `src/utils/auth/credentials.test.js`
- `src/utils/auth/totp-store.js` — `readTotpState()`, `writeTotpState(state)`, `clearTotpState()`, `isTotpEnabled()`.
- `src/utils/auth/totp-store.test.js`
- `src/utils/auth/totp.js` — `generateEnrollment(username)`, `qrDataUrl(otpauthUrl)`, `verifyToken(token, secret?)`.
- `src/utils/auth/totp.test.js`
- `src/pages/api/auth/2fa-check.js`
- `src/__tests__/pages/api/auth/2fa-check.test.js`
- `src/pages/api/security/totp/enroll.js`
- `src/pages/api/security/totp/confirm.js`
- `src/pages/api/security/totp/disable.js`
- `src/__tests__/pages/api/security/totp/enroll.test.js`
- `src/__tests__/pages/api/security/totp/confirm.test.js`
- `src/__tests__/pages/api/security/totp/disable.test.js`
- `src/pages/security.jsx`
- `src/__tests__/pages/security.test.jsx`

**Modified files**
- `src/pages/api/auth/[...nextauth].js` — credentials fields, `authorize()`, startup validation (delegates password check to `credentials.js`).
- `src/__tests__/pages/api/auth/[...nextauth].test.js` — update for username + token.
- `src/pages/auth/signin.jsx` — two-step form.
- `src/__tests__/pages/auth/signin.test.jsx` — two-step coverage.
- `src/components/layout/NavHeader.jsx` — Security nav entry.
- `src/components/layout/NavHeader.test.jsx` — assert the entry.
- `docs/installation/index.md` — `HOMEPAGE_AUTH_USERNAME`, 2FA setup, recovery.
- `progress.md` — move TOTP item to shipped, note breaking change.
- `package.json` — `otplib`, `qrcode` deps (via `pnpm add`).

---

## Task 1: `verifyPassword` credential helper

**Files:**
- Create: `src/utils/auth/credentials.js`
- Test: `src/utils/auth/credentials.test.js`

**Interfaces:**
- Consumes: nothing (reads `process.env` at call time).
- Produces:
  - `verifyPassword(username: unknown, password: unknown): boolean` — reads `process.env.HOMEPAGE_AUTH_USERNAME` and `process.env.HOMEPAGE_AUTH_PASSWORD` on each call; constant-time compare of both; returns `false` (never throws) if either env var is missing/empty or either arg is not a string.
  - `logFailedPasswordSignIn(): void` — `createLogger("nextauth").warn("Failed password sign-in attempt")`.

- [ ] **Step 1: Write the failing test**

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("utils/logger", () => ({ default: vi.fn(() => ({ warn: warnMock })) }));

import { logFailedPasswordSignIn, verifyPassword } from "utils/auth/credentials";

describe("utils/auth/credentials", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    warnMock.mockClear();
    process.env = { ...originalEnv };
    process.env.HOMEPAGE_AUTH_USERNAME = "admin";
    process.env.HOMEPAGE_AUTH_PASSWORD = "s3cret";
  });

  it("accepts the correct username and password", () => {
    expect(verifyPassword("admin", "s3cret")).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword("admin", "nope")).toBe(false);
  });

  it("rejects a wrong username", () => {
    expect(verifyPassword("root", "s3cret")).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(verifyPassword(123, "s3cret")).toBe(false);
    expect(verifyPassword("admin", { toString: () => "s3cret" })).toBe(false);
  });

  it("rejects everything when env vars are missing", () => {
    delete process.env.HOMEPAGE_AUTH_PASSWORD;
    expect(verifyPassword("admin", "s3cret")).toBe(false);
  });

  it("compares multibyte values without throwing on unequal byte length", () => {
    process.env.HOMEPAGE_AUTH_PASSWORD = "é";
    expect(verifyPassword("admin", "a")).toBe(false);
    expect(verifyPassword("admin", "é")).toBe(true);
  });

  it("logs a sanitized warning on a failed attempt", () => {
    logFailedPasswordSignIn();
    expect(warnMock).toHaveBeenCalledWith("Failed password sign-in attempt");
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm vitest run src/utils/auth/credentials.test.js`
Expected: FAIL — cannot resolve `utils/auth/credentials`.

- [ ] **Step 3: Implement**

```js
import { createHash, timingSafeEqual } from "node:crypto";

import createLogger from "utils/logger";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeEquals(a, b) {
  // Both digests are 32 bytes, so timingSafeEqual never throws here; the
  // hash step is what lets us compare arbitrary-length inputs safely.
  return timingSafeEqual(sha256(a), sha256(b));
}

export function verifyPassword(username, password) {
  const expectedUsername = process.env.HOMEPAGE_AUTH_USERNAME;
  const expectedPassword = process.env.HOMEPAGE_AUTH_PASSWORD;

  if (!expectedUsername || !expectedPassword) return false;
  if (typeof username !== "string" || typeof password !== "string") return false;

  const usernameMatch = constantTimeEquals(username, expectedUsername);
  const passwordMatch = constantTimeEquals(password, expectedPassword);
  return usernameMatch && passwordMatch;
}

export function logFailedPasswordSignIn() {
  createLogger("nextauth").warn("Failed password sign-in attempt");
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm vitest run src/utils/auth/credentials.test.js`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/utils/auth/credentials.js src/utils/auth/credentials.test.js
git commit -m "feat(auth): add shared verifyPassword credential helper"
```

---

## Task 2: TOTP state store

**Files:**
- Create: `src/utils/auth/totp-store.js`
- Test: `src/utils/auth/totp-store.test.js`

**Interfaces:**
- Consumes: `CONF_DIR` from `utils/config/config`.
- Produces:
  - `readTotpState(): { totp?: { secret: string, enabledAt: string } }` — parses `${CONF_DIR}/auth.json`; returns `{}` on missing/empty/unparseable file (and `createLogger("auth").warn(...)` on a parse/read error, not on a plain missing file).
  - `writeTotpState(state: object): void` — `writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 })`; throws on failure.
  - `clearTotpState(): void` — `writeTotpState({})`.
  - `isTotpEnabled(): boolean` — `Boolean(readTotpState().totp?.secret)`.

- [ ] **Step 1: Write the failing test**

```js
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock, confDir } = vi.hoisted(() => ({ warnMock: vi.fn(), confDir: { value: "" } }));
vi.mock("utils/logger", () => ({ default: vi.fn(() => ({ warn: warnMock })) }));
vi.mock("utils/config/config", () => ({
  get CONF_DIR() {
    return confDir.value;
  },
}));

import { clearTotpState, isTotpEnabled, readTotpState, writeTotpState } from "utils/auth/totp-store";

describe("utils/auth/totp-store", () => {
  beforeEach(() => {
    warnMock.mockClear();
    confDir.value = mkdtempSync(join(tmpdir(), "ysb-auth-"));
  });

  it("returns {} when the file does not exist, without warning", () => {
    expect(readTotpState()).toEqual({});
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("round-trips a written state", () => {
    writeTotpState({ totp: { secret: "ABC", enabledAt: "2026-08-31T00:00:00.000Z" } });
    expect(readTotpState()).toEqual({ totp: { secret: "ABC", enabledAt: "2026-08-31T00:00:00.000Z" } });
    expect(isTotpEnabled()).toBe(true);
  });

  it("writes the file with 0600 permissions", () => {
    writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
    const mode = statSync(join(confDir.value, "auth.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("treats a corrupt file as disabled and warns", () => {
    writeFileSync(join(confDir.value, "auth.json"), "not json{");
    expect(readTotpState()).toEqual({});
    expect(isTotpEnabled()).toBe(false);
    expect(warnMock).toHaveBeenCalled();
  });

  it("clearTotpState leaves an empty object", () => {
    writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
    clearTotpState();
    expect(readTotpState()).toEqual({});
    expect(JSON.parse(readFileSync(join(confDir.value, "auth.json"), "utf8"))).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm vitest run src/utils/auth/totp-store.test.js`
Expected: FAIL — cannot resolve `utils/auth/totp-store`.

- [ ] **Step 3: Implement**

```js
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONF_DIR } from "utils/config/config";
import createLogger from "utils/logger";

const AUTH_FILE = "auth.json";

function authPath() {
  return join(CONF_DIR, AUTH_FILE);
}

export function readTotpState() {
  const path = authPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    createLogger("auth").warn("Could not read %s, treating 2FA as disabled: %s", AUTH_FILE, error.message);
    return {};
  }
}

export function writeTotpState(state) {
  writeFileSync(authPath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearTotpState() {
  writeTotpState({});
}

export function isTotpEnabled() {
  return Boolean(readTotpState().totp?.secret);
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm vitest run src/utils/auth/totp-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/auth/totp-store.js src/utils/auth/totp-store.test.js
git commit -m "feat(auth): add app-managed TOTP state store (config/auth.json)"
```

---

## Task 3: TOTP verification + enrollment helpers

**Files:**
- Modify: `package.json` (via `pnpm add otplib qrcode`)
- Create: `src/utils/auth/totp.js`
- Test: `src/utils/auth/totp.test.js`

**Interfaces:**
- Consumes: `readTotpState` from `utils/auth/totp-store`; `getSettings` from `utils/config/config`.
- Produces:
  - `generateEnrollment(username: string): { secret: string, otpauthUrl: string }` — `authenticator.generateSecret()` + `authenticator.keyuri(username, issuer, secret)`, `issuer = getSettings().title || "Homepage"`.
  - `qrDataUrl(otpauthUrl: string): Promise<string>` — `QRCode.toDataURL(otpauthUrl)`.
  - `verifyToken(token: unknown, secret?: string): boolean` — trims token; returns `false` for a non-string / wrong-length token or when no secret is available (arg omitted AND no stored secret); else `authenticator.check(token, secret ?? readTotpState().totp.secret)`.

- [ ] **Step 1: Install dependencies**

Run: `pnpm add otplib qrcode`
Expected: `package.json` gains `otplib` and `qrcode` under `dependencies`; lockfile updated.

- [ ] **Step 2: Write the failing test**

```js
import { authenticator } from "otplib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readTotpState, getSettings } = vi.hoisted(() => ({
  readTotpState: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock("utils/auth/totp-store", () => ({ readTotpState }));
vi.mock("utils/config/config", () => ({ getSettings }));

import { generateEnrollment, qrDataUrl, verifyToken } from "utils/auth/totp";

const SECRET = authenticator.generateSecret();

describe("utils/auth/totp", () => {
  beforeEach(() => {
    readTotpState.mockReset();
    getSettings.mockReset();
    getSettings.mockReturnValue({ title: "My Board" });
  });

  it("verifies a current token against an explicit secret", () => {
    expect(verifyToken(authenticator.generate(SECRET), SECRET)).toBe(true);
  });

  it("verifies a current token against the stored secret", () => {
    readTotpState.mockReturnValue({ totp: { secret: SECRET } });
    expect(verifyToken(authenticator.generate(SECRET))).toBe(true);
  });

  it("rejects a wrong / malformed / missing token", () => {
    readTotpState.mockReturnValue({ totp: { secret: SECRET } });
    expect(verifyToken("000000")).toBe(false);
    expect(verifyToken("abc")).toBe(false);
    expect(verifyToken(undefined)).toBe(false);
    expect(verifyToken(123456)).toBe(false);
  });

  it("returns false when no secret is available", () => {
    readTotpState.mockReturnValue({});
    expect(verifyToken("123456")).toBe(false);
  });

  it("builds an otpauth URL with the settings title as issuer", () => {
    const { secret, otpauthUrl } = generateEnrollment("admin");
    expect(secret).toEqual(expect.any(String));
    expect(otpauthUrl).toContain("otpauth://totp/");
    expect(otpauthUrl).toContain("issuer=My%20Board");
    expect(otpauthUrl).toContain("admin");
  });

  it("falls back to Homepage as issuer", () => {
    getSettings.mockReturnValue({});
    expect(generateEnrollment("admin").otpauthUrl).toContain("issuer=Homepage");
  });

  it("produces a PNG data URL for a QR", async () => {
    const url = await qrDataUrl("otpauth://totp/x");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test — expect failure**

Run: `pnpm vitest run src/utils/auth/totp.test.js`
Expected: FAIL — cannot resolve `utils/auth/totp`.

- [ ] **Step 4: Implement**

```js
import { authenticator } from "otplib";
import QRCode from "qrcode";

import { getSettings } from "utils/config/config";
import { readTotpState } from "utils/auth/totp-store";

function issuer() {
  return getSettings().title || "Homepage";
}

export function generateEnrollment(username) {
  const secret = authenticator.generateSecret();
  return { secret, otpauthUrl: authenticator.keyuri(username, issuer(), secret) };
}

export function qrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}

export function verifyToken(token, secret) {
  const resolvedSecret = secret ?? readTotpState().totp?.secret;
  if (!resolvedSecret) return false;
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    return authenticator.check(trimmed, resolvedSecret);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the test — expect pass**

Run: `pnpm vitest run src/utils/auth/totp.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/utils/auth/totp.js src/utils/auth/totp.test.js
git commit -m "feat(auth): add TOTP verify + enrollment helpers (otplib, qrcode)"
```

---

## Task 4: Rewire `authorize()` and startup validation

**Files:**
- Modify: `src/pages/api/auth/[...nextauth].js`
- Modify: `src/__tests__/pages/api/auth/[...nextauth].test.js`

**Interfaces:**
- Consumes: `verifyPassword`, `logFailedPasswordSignIn` from `utils/auth/credentials`; `isTotpEnabled` from `utils/auth/totp-store`; `verifyToken` from `utils/auth/totp`.
- Produces: `authOptions` (unchanged export). `CredentialsProvider` now declares `credentials: { username, password, token }`; `authorize({ username, password, token })` returns `{ id: "homepage", name: <username> }` or `null`.

Details:
- Remove the local `homepageAuthPassword` digest + `logFailedPasswordSignIn` + inline compare; delegate to `utils/auth/credentials`.
- Keep reading `homepageAuthPassword` only for the *startup* "is password auth configured" check (`!homepageAuthPassword` branch). Add `const homepageAuthUsername = process.env.HOMEPAGE_AUTH_USERNAME;` and require it in the same branch: change the password-mode guard to
  `else if (!homepageAuthPassword || !homepageAuthUsername || !process.env.NEXTAUTH_SECRET)` and keep the existing error message text `"Password auth is enabled but required settings are missing."`.
- New `authorize`:

```js
async authorize(credentials) {
  const { username, password, token } = credentials ?? {};
  if (!verifyPassword(username, password)) {
    logFailedPasswordSignIn();
    return null;
  }
  if (isTotpEnabled() && !verifyToken(token)) {
    logFailedPasswordSignIn();
    return null;
  }
  return { id: "homepage", name: username };
}
```

- `credentials` config object:

```js
credentials: {
  username: { label: "Username", type: "text" },
  password: { label: "Password", type: "password" },
  token: { label: "Authentication code", type: "text" },
},
```

- [ ] **Step 1: Update the existing test file**

In `src/__tests__/pages/api/auth/[...nextauth].test.js`:

1. Add hoisted mocks and `vi.mock` for the three new deps:

```js
const { verifyPasswordMock, isTotpEnabledMock, verifyTokenMock } = vi.hoisted(() => ({
  verifyPasswordMock: vi.fn(),
  isTotpEnabledMock: vi.fn(() => false),
  verifyTokenMock: vi.fn(() => false),
}));
vi.mock("utils/auth/credentials", () => ({
  verifyPassword: verifyPasswordMock,
  logFailedPasswordSignIn: () => warnMock("Failed password sign-in attempt"),
}));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled: isTotpEnabledMock }));
vi.mock("utils/auth/totp", () => ({ verifyToken: verifyTokenMock }));
```

2. In `beforeEach`, add `verifyPasswordMock.mockReset(); isTotpEnabledMock.mockReset().mockReturnValue(false); verifyTokenMock.mockReset().mockReturnValue(false);`.

3. Add `process.env.HOMEPAGE_AUTH_USERNAME = "admin";` to every test that currently sets `HOMEPAGE_AUTH_PASSWORD = "secret"` and expects a provider to build (the password-mode tests). Leave the OIDC tests alone.

4. Replace the old `authorize` assertions in "builds a password provider …" and "logs failed password sign-in attempts …" and "compares multibyte passwords …" with:

```js
it("authorizes when the password is correct and 2FA is off", async () => {
  process.env.HOMEPAGE_AUTH_ENABLED = "true";
  process.env.HOMEPAGE_AUTH_USERNAME = "admin";
  process.env.HOMEPAGE_AUTH_PASSWORD = "secret";
  process.env.HOMEPAGE_AUTH_SECRET = "rk3Xk9wQ0mVJt7cZbN2yLpA8sHdF4gRuEwTiOaSvBnM=";
  process.env.HOMEPAGE_EXTERNAL_URL = "https://homepage.example";
  verifyPasswordMock.mockReturnValue(true);

  const mod = await import("pages/api/auth/[...nextauth]");
  const [provider] = mod.authOptions.providers;

  await expect(provider.options.authorize({ username: "admin", password: "secret" })).resolves.toEqual({
    id: "homepage",
    name: "admin",
  });
});

it("rejects a bad password and logs a sanitized warning", async () => {
  // …same env…
  verifyPasswordMock.mockReturnValue(false);
  const mod = await import("pages/api/auth/[...nextauth]");
  const [provider] = mod.authOptions.providers;

  await expect(provider.options.authorize({ username: "admin", password: "wrong" })).resolves.toBeNull();
  expect(warnMock).toHaveBeenCalledWith("Failed password sign-in attempt");
  expect(JSON.stringify(warnMock.mock.calls)).not.toContain("wrong");
});

it("requires a valid TOTP token when 2FA is enabled", async () => {
  // …same env…
  verifyPasswordMock.mockReturnValue(true);
  isTotpEnabledMock.mockReturnValue(true);
  const mod = await import("pages/api/auth/[...nextauth]");
  const [provider] = mod.authOptions.providers;

  verifyTokenMock.mockReturnValue(false);
  await expect(
    provider.options.authorize({ username: "admin", password: "secret", token: "000000" }),
  ).resolves.toBeNull();

  verifyTokenMock.mockReturnValue(true);
  await expect(
    provider.options.authorize({ username: "admin", password: "secret", token: "123456" }),
  ).resolves.toEqual({ id: "homepage", name: "admin" });
});
```

5. Add:

```js
it("throws when password auth is enabled without a username", async () => {
  process.env.HOMEPAGE_AUTH_ENABLED = "true";
  process.env.HOMEPAGE_AUTH_PASSWORD = "secret";
  process.env.HOMEPAGE_AUTH_SECRET = "rk3Xk9wQ0mVJt7cZbN2yLpA8sHdF4gRuEwTiOaSvBnM=";
  process.env.HOMEPAGE_EXTERNAL_URL = "https://homepage.example";
  // no HOMEPAGE_AUTH_USERNAME
  await expect(import("pages/api/auth/[...nextauth]")).rejects.toThrow(
    /Password auth is enabled but required settings are missing/i,
  );
});
```

6. Update the `provider.credentials` shape assertion if present, or add:

```js
it("declares username, password, and token credential fields", async () => {
  // …password-mode env with username…
  const mod = await import("pages/api/auth/[...nextauth]");
  const [provider] = mod.authOptions.providers;
  expect(Object.keys(provider.options.credentials)).toEqual(["username", "password", "token"]);
});
```

- [ ] **Step 2: Run the tests — expect failure**

Run: `pnpm vitest run "src/__tests__/pages/api/auth/[...nextauth].test.js"`
Expected: FAIL — `authorize` still expects `{ password }` only / username guard missing.

- [ ] **Step 3: Implement the changes in `src/pages/api/auth/[...nextauth].js`**

- Add imports:

```js
import { logFailedPasswordSignIn, verifyPassword } from "utils/auth/credentials";
import { isTotpEnabled } from "utils/auth/totp-store";
import { verifyToken } from "utils/auth/totp";
```

- Delete the local `createHash`/`timingSafeEqual` import if now unused (still used elsewhere? check — the OIDC block does not use it; remove `timingSafeEqual`, keep `createHash` only if still referenced, otherwise remove the whole `node:crypto` import).
- Delete `homepageAuthPasswordDigest` and the local `logFailedPasswordSignIn` function.
- Add `const homepageAuthUsername = process.env.HOMEPAGE_AUTH_USERNAME;` near the other `homepage*` consts.
- Change the startup guard:

```js
} else if (!homepageAuthPassword || !homepageAuthUsername || !process.env.NEXTAUTH_SECRET) {
  throw new Error("Password auth is enabled but required settings are missing.");
}
```

- Replace the `CredentialsProvider({...})` config with the new `credentials` object and `authorize` shown in the task header.

- [ ] **Step 4: Run the tests — expect pass**

Run: `pnpm vitest run "src/__tests__/pages/api/auth/[...nextauth].test.js"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/pages/api/auth/[...nextauth].js" "src/__tests__/pages/api/auth/[...nextauth].test.js"
git commit -m "feat(auth): username + optional TOTP in the credentials authorize()"
```

---

## Task 5: `POST /api/auth/2fa-check`

**Files:**
- Create: `src/pages/api/auth/2fa-check.js`
- Test: `src/__tests__/pages/api/auth/2fa-check.test.js`

**Interfaces:**
- Consumes: `verifyPassword`, `logFailedPasswordSignIn` from `utils/auth/credentials`; `isTotpEnabled` from `utils/auth/totp-store`.
- Produces: default `handler(req, res)`. `POST { username, password }` → `200 { twoFactorEnabled: boolean }` on correct credentials; `401 { error: "Invalid credentials" }` otherwise (never includes `twoFactorEnabled`); `405 { error: "Method not allowed" }` for non-POST; `400 { error: "Invalid request" }` for a non-object body.

- [ ] **Step 1: Write the failing test**

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { verifyPassword, isTotpEnabled, logFailedPasswordSignIn } = vi.hoisted(() => ({
  verifyPassword: vi.fn(),
  isTotpEnabled: vi.fn(),
  logFailedPasswordSignIn: vi.fn(),
}));
vi.mock("utils/auth/credentials", () => ({ verifyPassword, logFailedPasswordSignIn }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled }));

import handler from "pages/api/auth/2fa-check";

describe("pages/api/auth/2fa-check", () => {
  beforeEach(() => vi.clearAllMocks());

  it("405s non-POST methods", async () => {
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("400s a missing body", async () => {
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(res.statusCode).toBe(400);
  });

  it("401s and logs when credentials are wrong, without disclosing 2FA state", async () => {
    verifyPassword.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { username: "admin", password: "x" } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
    expect(res.body).not.toHaveProperty("twoFactorEnabled");
    expect(logFailedPasswordSignIn).toHaveBeenCalledTimes(1);
  });

  it("200s with twoFactorEnabled:false when 2FA is off", async () => {
    verifyPassword.mockReturnValue(true);
    isTotpEnabled.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { username: "admin", password: "ok" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ twoFactorEnabled: false });
  });

  it("200s with twoFactorEnabled:true when 2FA is on", async () => {
    verifyPassword.mockReturnValue(true);
    isTotpEnabled.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { username: "admin", password: "ok" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ twoFactorEnabled: true });
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm vitest run src/__tests__/pages/api/auth/2fa-check.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```js
import { logFailedPasswordSignIn, verifyPassword } from "utils/auth/credentials";
import { isTotpEnabled } from "utils/auth/totp-store";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid request" });
  }

  const { username, password } = body;
  if (!verifyPassword(username, password)) {
    logFailedPasswordSignIn();
    return res.status(401).json({ error: "Invalid credentials" });
  }

  return res.status(200).json({ twoFactorEnabled: isTotpEnabled() });
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm vitest run src/__tests__/pages/api/auth/2fa-check.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/auth/2fa-check.js src/__tests__/pages/api/auth/2fa-check.test.js
git commit -m "feat(auth): add session-less /api/auth/2fa-check pre-check endpoint"
```

---

## Task 6: `/api/security/totp/{enroll,confirm,disable}`

**Files:**
- Create: `src/pages/api/security/totp/enroll.js`
- Create: `src/pages/api/security/totp/confirm.js`
- Create: `src/pages/api/security/totp/disable.js`
- Test: `src/__tests__/pages/api/security/totp/enroll.test.js`
- Test: `src/__tests__/pages/api/security/totp/confirm.test.js`
- Test: `src/__tests__/pages/api/security/totp/disable.test.js`

**Interfaces:**
- Consumes: `getServerSession` from `next-auth/next`; `authOptions` from `pages/api/auth/[...nextauth]`; `generateEnrollment`, `qrDataUrl`, `verifyToken` from `utils/auth/totp`; `isTotpEnabled`, `writeTotpState`, `clearTotpState` from `utils/auth/totp-store`; `createLogger` from `utils/logger`.
- Produces three default handlers.
  - `enroll`: `POST` → `409 { error: "2FA is already enabled" }` if `isTotpEnabled()`; else `200 { secret, otpauthUrl, qrDataUrl }` for `generateEnrollment(session.user.name)`. Nothing persisted.
  - `confirm`: `POST { secret, token }` → `400 { error: "Invalid code" }` if `!verifyToken(token, secret)`; else `writeTotpState({ totp: { secret, enabledAt: new Date().toISOString() } })` and `200 { enabled: true }`; write failure → `500 { error: "Could not save 2FA settings" }`.
  - `disable`: `POST { token }` → `400 { error: "2FA is not enabled" }` if `!isTotpEnabled()`; `400 { error: "Invalid code" }` if `!verifyToken(token)`; else `clearTotpState()` and `200 { enabled: false }`.
- All three: non-POST → `405 { error: "Method not allowed" }`. Missing session → `401 { error: "Unauthorized" }` (defensive; middleware also guards `/api/security/*`). Session check helper is shared inline per file (do not add a new shared module for 3 short files).

- [ ] **Step 1: Write `enroll.test.js` (failing)**

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { getServerSession, isTotpEnabled, generateEnrollment, qrDataUrl } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  isTotpEnabled: vi.fn(),
  generateEnrollment: vi.fn(),
  qrDataUrl: vi.fn(),
}));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled, writeTotpState: vi.fn(), clearTotpState: vi.fn() }));
vi.mock("utils/auth/totp", () => ({ generateEnrollment, qrDataUrl, verifyToken: vi.fn() }));

import handler from "pages/api/security/totp/enroll";

describe("pages/api/security/totp/enroll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { name: "admin" } });
  });

  it("405s non-POST", async () => {
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("401s without a session", async () => {
    getServerSession.mockResolvedValue(null);
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(res.statusCode).toBe(401);
  });

  it("409s when 2FA is already enabled", async () => {
    isTotpEnabled.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(res.statusCode).toBe(409);
  });

  it("returns a fresh secret + QR without persisting", async () => {
    isTotpEnabled.mockReturnValue(false);
    generateEnrollment.mockReturnValue({ secret: "S", otpauthUrl: "otpauth://x" });
    qrDataUrl.mockResolvedValue("data:image/png;base64,AAA");
    const res = createMockRes();
    await handler({ method: "POST" }, res);
    expect(generateEnrollment).toHaveBeenCalledWith("admin");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ secret: "S", otpauthUrl: "otpauth://x", qrDataUrl: "data:image/png;base64,AAA" });
  });
});
```

- [ ] **Step 2: Write `confirm.test.js` (failing)**

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import createMockRes from "test-utils/create-mock-res";

const { getServerSession, verifyToken, writeTotpState } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  verifyToken: vi.fn(),
  writeTotpState: vi.fn(),
}));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/totp", () => ({ verifyToken, generateEnrollment: vi.fn(), qrDataUrl: vi.fn() }));
vi.mock("utils/auth/totp-store", () => ({ writeTotpState, isTotpEnabled: vi.fn(), clearTotpState: vi.fn() }));

import handler from "pages/api/security/totp/confirm";

describe("pages/api/security/totp/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { name: "admin" } });
  });

  it("rejects a wrong code and does not persist", async () => {
    verifyToken.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { secret: "S", token: "000000" } }, res);
    expect(res.statusCode).toBe(400);
    expect(writeTotpState).not.toHaveBeenCalled();
  });

  it("persists on a correct code", async () => {
    verifyToken.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { secret: "S", token: "123456" } }, res);
    expect(verifyToken).toHaveBeenCalledWith("123456", "S");
    expect(writeTotpState).toHaveBeenCalledWith({ totp: { secret: "S", enabledAt: expect.any(String) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it("500s when the write fails", async () => {
    verifyToken.mockReturnValue(true);
    writeTotpState.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const res = createMockRes();
    await handler({ method: "POST", body: { secret: "S", token: "123456" } }, res);
    expect(res.statusCode).toBe(500);
  });
});
```

- [ ] **Step 3: Write `disable.test.js` (failing)**

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import createMockRes from "test-utils/create-mock-res";

const { getServerSession, verifyToken, isTotpEnabled, clearTotpState } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  verifyToken: vi.fn(),
  isTotpEnabled: vi.fn(),
  clearTotpState: vi.fn(),
}));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/totp", () => ({ verifyToken, generateEnrollment: vi.fn(), qrDataUrl: vi.fn() }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled, clearTotpState, writeTotpState: vi.fn() }));

import handler from "pages/api/security/totp/disable";

describe("pages/api/security/totp/disable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { name: "admin" } });
    isTotpEnabled.mockReturnValue(true);
  });

  it("400s when 2FA is not enabled", async () => {
    isTotpEnabled.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { token: "123456" } }, res);
    expect(res.statusCode).toBe(400);
  });

  it("400s on a wrong code", async () => {
    verifyToken.mockReturnValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { token: "000000" } }, res);
    expect(res.statusCode).toBe(400);
    expect(clearTotpState).not.toHaveBeenCalled();
  });

  it("clears state on a correct code", async () => {
    verifyToken.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { token: "123456" } }, res);
    expect(clearTotpState).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });
});
```

- [ ] **Step 4: Run the three tests — expect failure**

Run: `pnpm vitest run src/__tests__/pages/api/security/`
Expected: FAIL — modules missing.

- [ ] **Step 5: Implement `enroll.js`**

```js
import { getServerSession } from "next-auth/next";

import { authOptions } from "pages/api/auth/[...nextauth]";
import { generateEnrollment, qrDataUrl } from "utils/auth/totp";
import { isTotpEnabled } from "utils/auth/totp-store";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (isTotpEnabled()) return res.status(409).json({ error: "2FA is already enabled" });

  const { secret, otpauthUrl } = generateEnrollment(session.user?.name ?? "user");
  return res.status(200).json({ secret, otpauthUrl, qrDataUrl: await qrDataUrl(otpauthUrl) });
}
```

- [ ] **Step 6: Implement `confirm.js`**

```js
import { getServerSession } from "next-auth/next";

import { authOptions } from "pages/api/auth/[...nextauth]";
import createLogger from "utils/logger";
import { verifyToken } from "utils/auth/totp";
import { writeTotpState } from "utils/auth/totp-store";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { secret, token } = req.body ?? {};
  if (typeof secret !== "string" || !verifyToken(token, secret)) {
    return res.status(400).json({ error: "Invalid code" });
  }

  try {
    writeTotpState({ totp: { secret, enabledAt: new Date().toISOString() } });
  } catch (error) {
    createLogger("auth").error("Could not persist 2FA settings: %s", error.message);
    return res.status(500).json({ error: "Could not save 2FA settings" });
  }

  return res.status(200).json({ enabled: true });
}
```

- [ ] **Step 7: Implement `disable.js`**

```js
import { getServerSession } from "next-auth/next";

import { authOptions } from "pages/api/auth/[...nextauth]";
import { verifyToken } from "utils/auth/totp";
import { clearTotpState, isTotpEnabled } from "utils/auth/totp-store";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (!isTotpEnabled()) return res.status(400).json({ error: "2FA is not enabled" });

  const { token } = req.body ?? {};
  if (!verifyToken(token)) return res.status(400).json({ error: "Invalid code" });

  clearTotpState();
  return res.status(200).json({ enabled: false });
}
```

- [ ] **Step 8: Run the three tests — expect pass**

Run: `pnpm vitest run src/__tests__/pages/api/security/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/pages/api/security src/__tests__/pages/api/security
git commit -m "feat(security): add TOTP enroll/confirm/disable endpoints"
```

---

## Task 7: Two-step sign-in page

**Files:**
- Modify: `src/pages/auth/signin.jsx`
- Modify: `src/__tests__/pages/auth/signin.test.jsx`

**Interfaces:**
- Consumes: `POST /api/auth/2fa-check` → `{ twoFactorEnabled }` / `401`; `signIn` from `next-auth/react`.
- Produces: unchanged default export + `getServerSideProps` (no signature change). New internal state; no new props.

Behaviour:
- Add state: `step` (`"credentials"`), `username`, `token`, `formError` (string), `submitting` (bool). Keep `password`.
- The password provider branch (`hasPasswordProvider`) renders one of two sub-forms based on `step`.
- **Step `credentials`:** `Username` + `Password` inputs, submit button labelled `Continue →`.
  - `onSubmit`: `setSubmitting(true)`, `setFormError("")`, then
    ```js
    const resp = await fetch("/api/auth/2fa-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (resp.status === 401) { setFormError("Invalid username or password."); setSubmitting(false); return; }
    if (!resp.ok) { setFormError("Something went wrong. Please try again."); setSubmitting(false); return; }
    const { twoFactorEnabled } = await resp.json();
    if (twoFactorEnabled) { setStep("totp"); setSubmitting(false); return; }
    await finishSignIn();
    ```
  - `finishSignIn` (shared):
    ```js
    const result = await signIn("credentials", { redirect: false, username, password, token });
    if (result?.ok) { window.location.assign(callbackUrl); return; }
    setSubmitting(false);
    if (step === "totp") setFormError("Invalid authentication code.");
    else setFormError("Invalid username or password.");
    ```
    (Use `window.location.assign` — a full load re-runs `getServerSideProps`/middleware so the now-authenticated session lands on the dashboard. `router.push` is acceptable too; pick `window.location.assign` for a clean session pickup.)
- **Step `totp`:** a single input — `type="text"`, `inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength={6}`, `pattern="\\d{6}"`, labelled `Authentication code`. Submit button `Verify →`. A `← Back` text button that does `setStep("credentials"); setToken(""); setFormError("")`.
  - `onSubmit`: `setSubmitting(true); setFormError(""); await finishSignIn();`
- `formError`, when set, renders in the existing red error box markup (reuse the current `error` styling block). Remove the old reliance on `router.query.error` for the password path (OIDC still may surface `router.query.error` — keep showing a generic error box if `error` is present AND `!hasPasswordProvider`).
- Everything else (OIDC branch, "not configured" branch, background, theme sync, glass card) stays byte-for-byte.

- [ ] **Step 1: Update `signin.test.jsx`**

Add `global.fetch` mock + `next-auth/react` `signIn` mock. Import `fireEvent` and `act` from `@testing-library/react`. Extend the existing `next/router` mock to allow overriding `query`. Stub `window.location.assign` (`vi.spyOn(window.location, "assign")` may fail in jsdom — instead `delete window.location; window.location = { assign: vi.fn() };` in `beforeEach`, restoring after). Add:

```js
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { signIn } from "next-auth/react";
// extend the existing next-auth/react mock: getProviders: vi.fn(), signIn: vi.fn()

function renderPasswordSignIn() {
  render(
    <SignInPage
      providers={{ credentials: { id: "credentials", name: "Credentials", type: "credentials" } }}
      settings={{ theme: "dark", color: "slate", title: "Homepage" }}
    />,
  );
}

async function submitCredentials(username = "admin", password = "secret") {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
}

it("signs in directly when 2FA is disabled", async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ twoFactorEnabled: false }) });
  signIn.mockResolvedValue({ ok: true, url: "/" });
  renderPasswordSignIn();
  await submitCredentials();

  await waitFor(() =>
    expect(signIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirect: false, username: "admin", password: "secret" }),
    ),
  );
});

it("shows the code step when 2FA is enabled", async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ twoFactorEnabled: true }) });
  renderPasswordSignIn();
  await submitCredentials();

  expect(await screen.findByLabelText("Authentication code")).toBeInTheDocument();
  expect(signIn).not.toHaveBeenCalled();
});

it("shows an error on wrong credentials", async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Invalid credentials" }) });
  renderPasswordSignIn();
  await submitCredentials("admin", "bad");
  expect(await screen.findByText(/invalid username or password/i)).toBeInTheDocument();
});

it("submits the code and surfaces an invalid-code error", async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ twoFactorEnabled: true }) });
  signIn.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
  renderPasswordSignIn();
  await submitCredentials();

  const codeInput = await screen.findByLabelText("Authentication code");
  fireEvent.change(codeInput, { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: /verify/i }));
  expect(await screen.findByText(/invalid authentication code/i)).toBeInTheDocument();
});
```

Keep the existing three tests. The "renders provider buttons when providers are available" test uses an OIDC provider so it still asserts a login button — leave it. Adjust only if it referenced the old single "Password" label.

- [ ] **Step 2: Run — expect failure**

Run: `pnpm vitest run src/__tests__/pages/auth/signin.test.jsx`
Expected: FAIL — no Username field / two-step behaviour absent.

- [ ] **Step 3: Implement the two-step form in `signin.jsx`**

Follow the behaviour spec above. Keep imports minimal — add `useCallback` if used for `finishSignIn`. Do not touch `getServerSideProps`.

- [ ] **Step 4: Run — expect pass**

Run: `pnpm vitest run src/__tests__/pages/auth/signin.test.jsx`
Expected: PASS (old + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/auth/signin.jsx src/__tests__/pages/auth/signin.test.jsx package.json pnpm-lock.yaml
git commit -m "feat(auth): two-step username/password then TOTP sign-in"
```

---

## Task 8: Security settings page

**Files:**
- Create: `src/pages/security.jsx`
- Test: `src/__tests__/pages/security.test.jsx`

**Interfaces:**
- Consumes: `getServerSession`, `authOptions`, `isTotpEnabled`, `getSettings`, `PageBackground`; the `/api/security/totp/*` endpoints.
- Produces: default `SecurityPage({ initialSettings, twoFactorEnabled })` + `getServerSideProps`.

`getServerSideProps(context)`:

```js
export async function getServerSideProps(context) {
  const { providers, ...settings } = getSettings();
  const twoFactorEnabled = isAuthEnabled() ? isTotpEnabled() : false;
  return { props: { initialSettings: settings, twoFactorEnabled } };
}
```

Page:
- `PageBackground` wrapper + `<div className="flex flex-col m-4 sm:m-8 mt-16 mb-2">` + `<h1 className="text-theme-800 dark:text-theme-300 text-xl font-medium mb-4">Security</h1>` (match `backups.js`).
- A card (`rounded-2xl border … p-6`, reuse sign-in card classes) titled **Two-factor authentication**.
- Local state `enabled` (init from prop), `phase` (`"idle" | "enrolling" | "disabling"`), `enrollment` (`{ secret, otpauthUrl, qrDataUrl }` | null), `code`, `error`, `busy`.
- **`enabled === false`, `phase === "idle"`:** text "Add a time-based one-time code from an authenticator app as a second factor." + `Enable 2FA` button → `POST /api/security/totp/enroll` → on 200 store `enrollment`, `phase = "enrolling"`.
- **`phase === "enrolling"`:** `<img src={enrollment.qrDataUrl} alt="2FA QR code" className="h-44 w-44" />`, the secret in a `<code>` (selectable), a 6-digit input (same attrs as sign-in step 2), `Confirm` button → `POST /api/security/totp/confirm { secret: enrollment.secret, token: code }` → 200 → `enabled = true`, `phase = "idle"`, clear `enrollment`/`code`; 400 → `error = "Invalid code, try again."`. A `Cancel` button → back to idle, drop `enrollment`.
- **`enabled === true`, `phase === "idle"`:** green "2FA is on." + `Disable 2FA` button → `phase = "disabling"`.
- **`phase === "disabling"`:** 6-digit input + `Confirm disable` → `POST /api/security/totp/disable { token: code }` → 200 → `enabled = false`, `phase = "idle"`; 400 → `error`.
- Errors render in the shared red box markup.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("components/layout/PageBackground", () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock("utils/config/config", () => ({ getSettings: vi.fn(() => ({})) }));
vi.mock("utils/env", () => ({ isAuthEnabled: () => true }));
vi.mock("utils/auth/totp-store", () => ({ isTotpEnabled: vi.fn(() => false) }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));

import SecurityPage from "pages/security";

describe("pages/security", () => {
  it("walks through enabling 2FA", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ secret: "S", otpauthUrl: "otpauth://x", qrDataUrl: "data:image/png;base64,AAA" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ enabled: true }) });

    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} />);

    fireEvent.click(screen.getByRole("button", { name: /enable 2fa/i }));
    expect(await screen.findByAltText("2FA QR code")).toHaveAttribute("src", "data:image/png;base64,AAA");

    fireEvent.change(screen.getByLabelText(/authentication code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(screen.getByText(/2fa is on/i)).toBeInTheDocument());
    expect(global.fetch).toHaveBeenLastCalledWith(
      "/api/security/totp/confirm",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an error on a bad enrollment code", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ secret: "S", otpauthUrl: "otpauth://x", qrDataUrl: "d" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "Invalid code" }) });

    render(<SecurityPage initialSettings={{}} twoFactorEnabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /enable 2fa/i }));
    fireEvent.change(await screen.findByLabelText(/authentication code/i), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(await screen.findByText(/invalid code, try again/i)).toBeInTheDocument();
  });

  it("renders the disable path when already enabled", async () => {
    render(<SecurityPage initialSettings={{}} twoFactorEnabled />);
    expect(screen.getByText(/2fa is on/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disable 2fa/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm vitest run src/__tests__/pages/security.test.jsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/pages/security.jsx`**

Per the behaviour spec above. Use `fetch` with `headers: { "Content-Type": "application/json" }` and `JSON.stringify` bodies. Keep it one focused file (~150 lines).

- [ ] **Step 4: Run — expect pass**

Run: `pnpm vitest run src/__tests__/pages/security.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/security.jsx src/__tests__/pages/security.test.jsx
git commit -m "feat(security): add Security page for TOTP 2FA enrollment"
```

---

## Task 9: Security nav entry

**Files:**
- Modify: `src/components/layout/NavHeader.jsx`
- Modify: `src/components/layout/NavHeader.test.jsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `NAV_ITEMS` gains `{ href: "/security", label: "Security", icon: BiLockAlt }`.

- [ ] **Step 1: Add the failing assertion**

In `NavHeader.test.jsx`, add / extend the nav-items test:

```js
it("includes a Security link", () => {
  render(<NavHeader />);
  // NavHeader renders items inside a Headless UI Menu; assert on the array-driven link.
  expect(screen.getByRole("menuitem", { name: /security/i })).toHaveAttribute("href", "/security");
});
```

If the existing tests don't open the menu, follow their existing pattern (they may render items directly or click `Open menu` first — match whatever "Backups" / "Widgets" assertions already do).

- [ ] **Step 2: Run — expect failure**

Run: `pnpm vitest run src/components/layout/NavHeader.test.jsx`
Expected: FAIL — no Security menuitem.

- [ ] **Step 3: Implement**

```js
import { BiCloudUpload, BiExtension, BiHome, BiLockAlt, BiMenu } from "react-icons/bi";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: BiHome },
  { href: "/backups", label: "Backups", icon: BiCloudUpload },
  { href: "/widgets", label: "Widgets", icon: BiExtension },
  { href: "/security", label: "Security", icon: BiLockAlt },
];
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm vitest run src/components/layout/NavHeader.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/NavHeader.jsx src/components/layout/NavHeader.test.jsx
git commit -m "feat(nav): add Security page link"
```

---

## Task 10: Full test + lint sweep and docs

**Files:**
- Modify: `docs/installation/index.md`
- Modify: `progress.md`

- [ ] **Step 1: Run the whole suite**

Run: `pnpm test`
Expected: PASS (all files). Fix any regressions in the auth/nextauth tests that other suites import (e.g. `src/pages/api/mcp/index.test.js` imports `authOptions` — ensure its env includes `HOMEPAGE_AUTH_USERNAME` where it enables auth; add it if the mcp test breaks).

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS. Fix import-order / unused-import issues (the `node:crypto` import in `[...nextauth].js` in particular).

- [ ] **Step 3: Update `docs/installation/index.md`**

In the *Security & Authentication* section:
- Under "Required environment variables for authentication", note password login now also needs `HOMEPAGE_AUTH_USERNAME`.
- Change "For password-only login:" list to:
  - `HOMEPAGE_AUTH_USERNAME` (the login username)
  - `HOMEPAGE_AUTH_PASSWORD` (a strong, unique password)
- Add a new subsection after the password block:

```markdown
#### Two-factor authentication (TOTP)

Once signed in with a username and password, open the **Security** page
from the navigation menu to enable an authenticator-app second factor.
Scan the QR code, confirm a code, and every subsequent sign-in will ask
for the 6-digit code after the password.

2FA state is stored in `config/auth.json` (created automatically). If you
lose access to your authenticator, delete or empty that file to disable
2FA; the next sign-in will only require the username and password.
```

- In the existing rate-limit `!!! warning`, add that the note also covers `POST /api/auth/2fa-check`.

- [ ] **Step 4: Update `progress.md`**

- Remove `- TOTP-based 2FA login` from *Not yet implemented — tracked as separate follow-up plans*.
- Add a bullet to the shipped/changelog narrative section describing: username now required for password auth (breaking — existing `HOMEPAGE_AUTH_PASSWORD`-only deployments must set `HOMEPAGE_AUTH_USERNAME`); optional TOTP 2FA enrolled from the new Security page; two-step sign-in; state in `config/auth.json`.

- [ ] **Step 5: Commit**

```bash
git add docs/installation/index.md progress.md
git commit -m "docs: document HOMEPAGE_AUTH_USERNAME requirement and TOTP 2FA"
```

---

## Self-Review

**Spec coverage**

| Spec item | Task |
|-----------|------|
| `HOMEPAGE_AUTH_USERNAME` required in password mode | 4, 10 |
| `HOMEPAGE_AUTH_PASSWORD` unchanged hashing | 1 |
| `config/auth.json` app-managed, `0600`, corrupt→disabled | 2 |
| `verifyPassword` shared, constant-time, multibyte-safe | 1 |
| `logFailedPasswordSignIn` shared, same string, in both `authorize` and `2fa-check` | 1, 4, 5 |
| `totp.js` generateEnrollment / qrDataUrl / verifyToken | 3 |
| `otplib` + `qrcode` deps | 3 |
| `authorize()` = password + conditional TOTP, returns `name: username` | 4 |
| `POST /api/auth/2fa-check` shape, 401 hides 2FA state, method guard | 5 |
| `/api/security/totp/enroll` 409 + no persist | 6 |
| `/api/security/totp/confirm` verify-then-persist, 500 on write failure | 6 |
| `/api/security/totp/disable` requires current code | 6 |
| Path-prefix rule (`/api/auth/*` exempt, `/api/security/*` guarded) | 5, 6 (middleware matcher already covers both — no matcher change needed) |
| Two-step sign-in, `redirect:false`, back button, error rendering | 7 |
| Security page + nav entry | 8, 9 |
| Docs + progress.md + breaking-change note | 10 |
| No recovery codes (out of scope) | — (delete-file recovery documented in 10) |

**Middleware note:** `src/middleware.js`'s matcher negative-lookahead is `(?!_next/static|_next/image|favicon.ico|robots.txt|manifest.json|sitemap.xml|icons/|api/auth|auth/)`. `/api/auth/2fa-check` matches `api/auth` → already exempt. `/api/security/*` is not listed → already protected. **No middleware change required.** Task 10 Step 1 should still add a middleware test only if quick; otherwise the existing middleware tests plus the `/api/security/*` 401 behaviour are covered structurally. (If adding: extend `src/middleware.test.js` with a case asserting `/api/security/totp/enroll` with no token → 401 and `/api/auth/2fa-check` → `next`.)

**Placeholder scan:** no TBD/TODO; every code step has real code.

**Type consistency:** `readTotpState()` shape `{ totp?: { secret, enabledAt } }` used consistently in tasks 2/3/4/6. `verifyToken(token, secret?)` signature consistent (tasks 3, 6). `generateEnrollment(username)` → `{ secret, otpauthUrl }` and endpoint adds `qrDataUrl` (task 3/6). `2fa-check` returns `{ twoFactorEnabled }` consumed in task 7. `signIn("credentials", { redirect:false, username, password, token })` matches `authorize` fields in task 4.

**Added to plan during review:** Task 7 Step 1 may need `@testing-library/user-event` (dev dep) — folded into that step. Task 10 Step 1 flags the `mcp/index.test.js` cross-import risk.
