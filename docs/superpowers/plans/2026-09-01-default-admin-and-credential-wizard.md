# Default admin + in-app credential & 2FA wizard — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard login on-by-default with a bootstrapped `admin`/`admin` account, editable in-app (username + password + optional 2FA) via a `/security` wizard, with a warning banner and a sign-in brute-force throttle.

**Architecture:** `config/auth.json` is the single source of truth for the NextAuth signing secret and the credential record. `src/instrumentation.js` `register()` bootstraps both at startup. Middleware (Node.js runtime in Next 16), the NextAuth route, and instrumentation all read the file directly through one shared `auth-file.js` layer. `/api/auth/2fa-check` is deleted — the sign-in page reads `twoFactorEnabled` in `getServerSideProps`; `authorize()` is the only credential chokepoint and carries an in-memory progressive-delay throttle.

**Tech Stack:** Next.js 16.3 (Pages Router, `output: "standalone"`), next-auth v4 (`CredentialsProvider`, `jwt` sessions), `node:crypto` scrypt, `otplib`/`qrcode` (already installed), SWR, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-default-admin-and-credential-wizard-design.md` — read it in full before Task 1. The plan argues from the spec; where this plan is terse the spec is authoritative.

## Global Constraints

- **Middleware runtime is Node.js** (Next 16 default; the `runtime` config option is rejected). Task 0 verifies `readFileSync` works there before anything else.
- `isAuthEnabled()` becomes `process.env.HOMEPAGE_AUTH_ENABLED !== "false"` — only the exact string `"false"` disables. Every consumer uses truthiness on env vars (`Boolean(x)` / `!x`), never `x !== undefined` (docker-compose passes `""` for unset).
- Password hashing: `node:crypto` `scrypt`, params `N=16384, r=8, p=1`, 64-byte output, format string exactly `scrypt$16384$8$1$<saltB64>$<keyB64>`. Async (`scrypt` promisified) — never `scryptSync`.
- Constant-time compares go through the existing hash-first `constantTimeEquals` helper (sha256 then `timingSafeEqual`) — never a raw `===`, never `timingSafeEqual` on raw strings.
- Every failed password attempt logs exactly `createLogger("nextauth").warn("Failed password sign-in attempt")` (via `logFailedPasswordSignIn`) — **except** a request rejected because the throttle is already blocking, which does not log.
- `config/auth.json` is written `{ mode: 0o600 }` + `chmodSync(path, 0o600)` after. `auth-file.js` `writeAuthFile` is fully synchronous (no `await` inside) so it is atomic; a key whose patch value is `undefined` is deleted.
- `auth-file.js` imports **only** `node:fs` / `node:path` — it inlines the config dir (`process.env.HOMEPAGE_CONFIG_DIR || join(process.cwd(), "config")`), it does **not** import `utils/config/config`.
- OIDC mode (`HOMEPAGE_OIDC_ISSUER` + `HOMEPAGE_OIDC_CLIENT_ID` + `HOMEPAGE_OIDC_CLIENT_SECRET` all set) is unchanged and suppresses the bootstrap account, the banner, and the wizard.
- New test files are `*.test.js` / `*.test.jsx` (Vitest `include` is `src/**/*.test.{js,jsx}`). React component tests start with `// @vitest-environment jsdom`. API-route tests use `test-utils/create-mock-res` (`createMockRes()` → `.statusCode`, `.body`). Interactions use `fireEvent` from `@testing-library/react` — **not** `@testing-library/user-event`.
- Commit after every task; `feat:` / `test:` / `refactor:` / `docs:` prefix. Run the full suite (`pnpm test`) once before each commit; run `pnpm lint` before the final task.

## File structure

**New**
- `src/utils/auth/auth-file.js` — `readAuthFile()` (5 s cache), `writeAuthFile(patch)` (atomic merge/delete), `authFilePath()`.
- `src/utils/auth/password-hash.js` — `hashPassword(pw)`, `verifyHash(pw, stored)`.
- `src/utils/auth/secret.js` — `ensureAuthSecret()`.
- `src/utils/auth/credentials-store.js` — `managedByEnv()`, `readUser()`, `usingDefaultCredentials()`, `currentUsername()`, `writeUser({username,password})`, `ensureInitialUser()`.
- `src/instrumentation.js` — `register()`.
- `src/pages/api/security/credentials.js`, `src/pages/api/security/credentials-status.js`.
- `src/components/layout/CredentialsWarning.jsx`.
- Tests co-located / under `src/__tests__/…` mirroring existing layout.

**Modified**
- `src/utils/env.js`, `src/utils/auth/mode.js`, `src/utils/auth/credentials.js`, `src/utils/auth/totp-store.js`
- `src/pages/api/auth/[...nextauth].js`, `src/middleware.js`, `src/pages/auth/signin.jsx`, `src/pages/security.jsx`, `src/pages/_app.jsx`
- `docker-compose.yml`, `.env.example`, `docs/installation/index.md`, `README.md`, `progress.md`
- Test files: `[...nextauth].test.js`, `middleware.test.js`, `mcp/index.test.js`, `mode.test.js`, `security.test.jsx`, `signin.test.jsx`, `totp-store.test.js`

**Deleted**
- `src/pages/api/auth/2fa-check.js`, `src/__tests__/pages/api/auth/2fa-check.test.js`

---

## Task 0: Spike — confirm middleware Node runtime + instrumentation

**Files:** throwaway edits to `src/middleware.js`, a throwaway `src/instrumentation.js`. Nothing committed.

- [ ] **Step 1: Add a probe to middleware**

At the top of `src/middleware.js`:

```js
import { readFileSync } from "node:fs";
try {
  readFileSync("package.json", "utf8");
  // eslint-disable-next-line no-console
  console.log("[spike] middleware readFileSync OK");
} catch (e) {
  // eslint-disable-next-line no-console
  console.log("[spike] middleware readFileSync FAILED:", e.message);
}
```

- [ ] **Step 2: Add a probe instrumentation file**

`src/instrumentation.js`:

```js
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // eslint-disable-next-line no-console
  console.log("[spike] instrumentation register() ran (nodejs)");
  if (process.env.SPIKE_THROW === "1") throw new Error("[spike] register threw");
}
```

- [ ] **Step 3: Build and run**

```bash
pnpm build && PORT=3099 pnpm start
```

Expected in the console: `[spike] instrumentation register() ran (nodejs)` **before** any request, and (after `curl -s -o /dev/null http://localhost:3099/`) `[spike] middleware readFileSync OK`.

- [ ] **Step 4: Verify the throw path**

```bash
pnpm build && SPIKE_THROW=1 PORT=3099 pnpm start
```

Expected: the server exits / never becomes ready, printing the spike error.

- [ ] **Step 5: Verify standalone inclusion**

```bash
ls -la .next/standalone/src/instrumentation.js .next/standalone/src/middleware.js 2>/dev/null || \
  ls -la .next/standalone/instrumentation.js 2>/dev/null
grep -rl "spike" .next/standalone/ | head
```

Expected: `instrumentation.js` (or its bundled form) present in `.next/standalone/`.

- [ ] **Step 6: Record the outcome, revert the probes**

```bash
git checkout src/middleware.js
rm src/instrumentation.js
```

Write the result into the SDD ledger / plan-execution notes:
- **PASS** (middleware `fs` works, instrumentation runs + throws + is bundled) → proceed with the plan as written.
- **PARTIAL/FAIL** → apply the spec's fallback (§"Plan task 0 — spike": require `HOMEPAGE_AUTH_SECRET` in the env for non-Docker, Docker entrypoint exports it from the file) and adjust Tasks 3, 7, 9 accordingly before continuing.

---

## Task 1: `auth-file.js` + refactor `totp-store.js`

**Files:**
- Create: `src/utils/auth/auth-file.js`
- Test: `src/utils/auth/auth-file.test.js`
- Modify: `src/utils/auth/totp-store.js`
- Modify: `src/utils/auth/totp-store.test.js`

**Interfaces produced:**
- `readAuthFile(): object` — parsed `config/auth.json`, or `{}` on missing/corrupt (corrupt logs one `console.warn`). Module-level cache; re-reads from disk only when the cached copy is > 5 s old.
- `writeAuthFile(patch: object): void` — sync. Reads the file fresh from disk (bypassing the cache), `next = { ...current, ...patch }`, `delete next[k]` for every `k` with `patch[k] === undefined`, `writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 })`, `chmodSync(path, 0o600)`, sets the cache to `next`.
- `authFilePath(): string`.

- [ ] **Step 1: Write the failing test**

`src/utils/auth/auth-file.test.js`:

```js
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir;

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "ysb-authfile-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.HOMEPAGE_CONFIG_DIR;
  vi.restoreAllMocks();
});

async function load() {
  return import("utils/auth/auth-file");
}

describe("utils/auth/auth-file", () => {
  it("returns {} when the file is absent", async () => {
    const { readAuthFile } = await load();
    expect(readAuthFile()).toEqual({});
  });

  it("round-trips a write and merges without clobbering", async () => {
    const { readAuthFile, writeAuthFile } = await load();
    writeAuthFile({ secret: "s1" });
    writeAuthFile({ user: { username: "admin" } });
    expect(readAuthFile()).toEqual({ secret: "s1", user: { username: "admin" } });
  });

  it("deletes a key whose patch value is undefined", async () => {
    const { readAuthFile, writeAuthFile } = await load();
    writeAuthFile({ secret: "s1", totp: { secret: "abc" } });
    writeAuthFile({ totp: undefined });
    expect(readAuthFile()).toEqual({ secret: "s1" });
  });

  it("writes mode 0600", async () => {
    const { writeAuthFile, authFilePath } = await load();
    writeAuthFile({ secret: "s1" });
    expect(statSync(authFilePath()).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing looser file", async () => {
    writeFileSync(join(dir, "auth.json"), "{}");
    chmodSync(join(dir, "auth.json"), 0o644);
    const { writeAuthFile, authFilePath } = await load();
    writeAuthFile({ secret: "s1" });
    expect(statSync(authFilePath()).mode & 0o777).toBe(0o600);
  });

  it("caches reads for 5s and re-reads after", async () => {
    const { readAuthFile, writeAuthFile, authFilePath } = await load();
    writeAuthFile({ secret: "s1" });
    // out-of-band edit
    writeFileSync(authFilePath(), JSON.stringify({ secret: "s2" }));
    expect(readAuthFile().secret).toBe("s1"); // still cached
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    expect(readAuthFile().secret).toBe("s2"); // cache expired
  });

  it("treats a corrupt file as {} and warns once", async () => {
    writeFileSync(join(dir, "auth.json"), "not json {");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readAuthFile } = await load();
    expect(readAuthFile()).toEqual({});
    readAuthFile();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `pnpm vitest run src/utils/auth/auth-file.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/utils/auth/auth-file.js`**

```js
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mirror of CONF_DIR in utils/config/config.js — kept in sync deliberately so
// this module has zero src/ imports and stays cheap to pull into the middleware
// bundle.
function configDir() {
  return process.env.HOMEPAGE_CONFIG_DIR || join(process.cwd(), "config");
}

export function authFilePath() {
  return join(configDir(), "auth.json");
}

let cache = null; // { value, at }
let warned = false;

function readFresh() {
  const path = authFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console
      console.warn(`Could not read ${path}, treating auth state as empty: ${error.message}`);
    }
    return {};
  }
}

export function readAuthFile() {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const value = readFresh();
  cache = { value, at: Date.now() };
  return value;
}

export function writeAuthFile(patch) {
  const current = readFresh();
  const next = { ...current, ...patch };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete next[key];
  }
  const path = authFilePath();
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  cache = { value: next, at: Date.now() };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm vitest run src/utils/auth/auth-file.test.js` → PASS.

- [ ] **Step 5: Refactor `totp-store.js` onto `auth-file`**

New `src/utils/auth/totp-store.js`:

```js
import { readAuthFile, writeAuthFile } from "utils/auth/auth-file";

export function readTotpState() {
  return readAuthFile();
}

export function writeTotpState(state) {
  writeAuthFile({ totp: state.totp });
}

export function clearTotpState() {
  writeAuthFile({ totp: undefined });
}

export function isTotpEnabled() {
  return Boolean(readAuthFile().totp?.secret);
}
```

- [ ] **Step 6: Fix `totp-store.test.js`**

Update the `HOMEPAGE_CONFIG_DIR`-tmpdir setup to match `auth-file.test.js`. Rework the `clearTotpState` assertion:

```js
it("clearTotpState drops only totp and keeps secret/user", async () => {
  const { writeTotpState, clearTotpState } = await import("utils/auth/totp-store");
  const { writeAuthFile, readAuthFile } = await import("utils/auth/auth-file");
  writeAuthFile({ secret: "s1", user: { username: "admin" } });
  writeTotpState({ totp: { secret: "ABC", enabledAt: "x" } });
  clearTotpState();
  expect(readAuthFile()).toEqual({ secret: "s1", user: { username: "admin" } });
});
```

Keep the round-trip / `isTotpEnabled` / corrupt-file cases, adjusted to the new file layer.

- [ ] **Step 7: Full suite + commit**

Run: `pnpm test` — expect green (the 2FA endpoint tests that mock `utils/auth/totp-store` still pass; they mock the module wholesale).

```bash
git add src/utils/auth/auth-file.js src/utils/auth/auth-file.test.js src/utils/auth/totp-store.js src/utils/auth/totp-store.test.js
git commit -m "refactor(auth): add shared auth-file layer; fix clearTotpState file-wipe bug"
```

---

## Task 2: `password-hash.js`

**Files:** Create `src/utils/auth/password-hash.js` + `src/utils/auth/password-hash.test.js`.

**Interfaces produced:** `async hashPassword(pw): Promise<string>`, `async verifyHash(pw, stored): Promise<boolean>`.

- [ ] **Step 1: Failing test**

```js
import { describe, expect, it } from "vitest";
import { hashPassword, verifyHash } from "utils/auth/password-hash";

describe("utils/auth/password-hash", () => {
  it("round-trips", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyHash("correct horse", h)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const h = await hashPassword("a");
    expect(await verifyHash("b", h)).toBe(false);
  });

  it("returns false (no throw) for junk stored values", async () => {
    for (const junk of ["", "nope", "scrypt$1$1$1$x", "scrypt$16384$8$1$abc", null, undefined]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await verifyHash("a", junk)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run — expect fail.** `pnpm vitest run src/utils/auth/password-hash.test.js`

- [ ] **Step 3: Implement**

```js
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyHash(pw, stored) {
  if (typeof pw !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  try {
    const [, n, r, p, saltB64, keyB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    if (expected.length !== KEYLEN) return false;
    const actual = await scrypt(pw, salt, KEYLEN, { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run — expect pass.** **Step 5: `pnpm test`; commit**

```bash
git add src/utils/auth/password-hash.js src/utils/auth/password-hash.test.js
git commit -m "feat(auth): add async scrypt password hashing helper"
```

---

## Task 3: `secret.js`

**Files:** Create `src/utils/auth/secret.js` + `src/utils/auth/secret.test.js`.

**Interfaces produced:** `ensureAuthSecret(): string` (sync) — env → `HOMEPAGE_AUTH_SECRET` → `readAuthFile().secret` → generate `randomBytes(32).toString("base64url")` + `writeAuthFile({ secret })`. On a write error: return the value + `console.warn`, no throw.

- [ ] **Step 1: Failing test**

```js
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "ysb-secret-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.HOMEPAGE_AUTH_SECRET;
});
afterEach(() => {
  delete process.env.HOMEPAGE_CONFIG_DIR;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.HOMEPAGE_AUTH_SECRET;
});

describe("utils/auth/secret", () => {
  it("prefers NEXTAUTH_SECRET, then HOMEPAGE_AUTH_SECRET", async () => {
    process.env.HOMEPAGE_AUTH_SECRET = "H".repeat(40);
    let { ensureAuthSecret } = await import("utils/auth/secret");
    expect(ensureAuthSecret()).toBe("H".repeat(40));
    vi.resetModules();
    process.env.NEXTAUTH_SECRET = "N".repeat(40);
    ({ ensureAuthSecret } = await import("utils/auth/secret"));
    expect(ensureAuthSecret()).toBe("N".repeat(40));
  });

  it("generates, persists (base64url >=32 chars), and is idempotent", async () => {
    const { ensureAuthSecret } = await import("utils/auth/secret");
    const s = ensureAuthSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).secret).toBe(s);
    expect(ensureAuthSecret()).toBe(s);
  });

  it("reads an existing file secret", async () => {
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ secret: "fromfile-".padEnd(40, "x") });
    const { ensureAuthSecret } = await import("utils/auth/secret");
    expect(ensureAuthSecret()).toBe("fromfile-".padEnd(40, "x"));
  });

  it("does not throw when the dir is unwritable", async () => {
    process.env.HOMEPAGE_CONFIG_DIR = "/proc/nonexistent-ysb";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ensureAuthSecret } = await import("utils/auth/secret");
    expect(ensureAuthSecret()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect fail. Step 3: Implement**

```js
import { randomBytes } from "node:crypto";

import { readAuthFile, writeAuthFile } from "utils/auth/auth-file";

export function ensureAuthSecret() {
  const fromEnv = process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET;
  if (fromEnv) return fromEnv;

  const fromFile = readAuthFile().secret;
  if (fromFile) return fromFile;

  const secret = randomBytes(32).toString("base64url");
  try {
    writeAuthFile({ secret });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `Could not persist the auth signing secret (${error.message}). ` +
        `Set HOMEPAGE_AUTH_SECRET or make config/ writable — sessions will not survive a restart.`,
    );
  }
  return secret;
}
```

- [ ] **Step 4: Run — pass. Step 5: `pnpm test`; commit**

```bash
git add src/utils/auth/secret.js src/utils/auth/secret.test.js
git commit -m "feat(auth): add ensureAuthSecret (env -> config/auth.json -> generate)"
```

---

## Task 4: `mode.js` — export `hasOidcConfig`, drop the password clause

**Files:** Modify `src/utils/auth/mode.js` + `src/utils/auth/mode.test.js`.

- [ ] **Step 1: Update the test** — assert `hasOidcConfig()` is exported and that `passwordAuthActive()` no longer depends on `HOMEPAGE_AUTH_PASSWORD`:

```js
it("exposes hasOidcConfig", async () => {
  process.env.HOMEPAGE_OIDC_ISSUER = "x";
  process.env.HOMEPAGE_OIDC_CLIENT_ID = "x";
  process.env.HOMEPAGE_OIDC_CLIENT_SECRET = "x";
  const { hasOidcConfig } = await import("utils/auth/mode");
  expect(hasOidcConfig()).toBe(true);
});

it("passwordAuthActive ignores HOMEPAGE_AUTH_PASSWORD", async () => {
  process.env.HOMEPAGE_AUTH_ENABLED = "true";
  delete process.env.HOMEPAGE_AUTH_PASSWORD;
  delete process.env.HOMEPAGE_OIDC_ISSUER;
  const { passwordAuthActive } = await import("utils/auth/mode");
  expect(passwordAuthActive()).toBe(true);
});
```

- [ ] **Step 2: Run — fail. Step 3: Implement `src/utils/auth/mode.js`**

```js
import { isAuthEnabled } from "utils/env";

// mirror of the OIDC check in src/pages/api/auth/[...nextauth].js
export function hasOidcConfig() {
  return Boolean(
    process.env.HOMEPAGE_OIDC_ISSUER &&
      process.env.HOMEPAGE_OIDC_CLIENT_ID &&
      process.env.HOMEPAGE_OIDC_CLIENT_SECRET,
  );
}

export function passwordAuthActive() {
  return isAuthEnabled() && !hasOidcConfig();
}
```

- [ ] **Step 4: Run — pass. Step 5: `pnpm test`** (this file's callers: `2fa-check.js` — still exists, still works; `security.jsx` gSSP — works). **Commit**

```bash
git add src/utils/auth/mode.js src/utils/auth/mode.test.js
git commit -m "refactor(auth): export hasOidcConfig; passwordAuthActive drops the password clause"
```

---

## Task 5: `credentials-store.js`

**Files:** Create `src/utils/auth/credentials-store.js` + `src/utils/auth/credentials-store.test.js`.

**Interfaces produced:**
- `managedByEnv(): boolean`
- `readUser(): { username, passwordHash? } | null`
- `usingDefaultCredentials(): boolean` = `!managedByEnv() && !!readUser() && !readUser().passwordHash`
- `currentUsername(): string` = `managedByEnv() ? HOMEPAGE_AUTH_USERNAME : (readUser()?.username ?? "admin")`
- `async writeUser({ username, password }): Promise<void>`
- `async ensureInitialUser(): Promise<{ created: boolean, reason?: "disabled"|"env"|"oidc"|"exists"|"readonly" }>`

- [ ] **Step 1: Failing test**

```js
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "ysb-credstore-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
  for (const k of ["HOMEPAGE_AUTH_ENABLED", "HOMEPAGE_AUTH_USERNAME", "HOMEPAGE_AUTH_PASSWORD",
    "HOMEPAGE_OIDC_ISSUER", "HOMEPAGE_OIDC_CLIENT_ID", "HOMEPAGE_OIDC_CLIENT_SECRET"]) delete process.env[k];
});
afterEach(() => { delete process.env.HOMEPAGE_CONFIG_DIR; });

const load = () => import("utils/auth/credentials-store");

describe("utils/auth/credentials-store", () => {
  it("ensureInitialUser: skips when auth disabled", async () => {
    process.env.HOMEPAGE_AUTH_ENABLED = "false";
    expect((await (await load()).ensureInitialUser())).toEqual({ created: false, reason: "disabled" });
  });

  it("ensureInitialUser: skips when env-managed / OIDC / already exists", async () => {
    process.env.HOMEPAGE_AUTH_USERNAME = "u";
    process.env.HOMEPAGE_AUTH_PASSWORD = "p";
    expect((await (await load()).ensureInitialUser()).reason).toBe("env");
    vi.resetModules();
    delete process.env.HOMEPAGE_AUTH_USERNAME; delete process.env.HOMEPAGE_AUTH_PASSWORD;
    process.env.HOMEPAGE_OIDC_ISSUER = "x"; process.env.HOMEPAGE_OIDC_CLIENT_ID = "x"; process.env.HOMEPAGE_OIDC_CLIENT_SECRET = "x";
    expect((await (await load()).ensureInitialUser()).reason).toBe("oidc");
  });

  it("ensureInitialUser: creates {username:'admin'} with no hash", async () => {
    const cs = await load();
    expect(await cs.ensureInitialUser()).toEqual({ created: true });
    expect(cs.readUser()).toEqual({ username: "admin" });
    expect(cs.usingDefaultCredentials()).toBe(true);
    expect(cs.currentUsername()).toBe("admin");
  });

  it("writeUser adds a verifiable hash, clears default, preserves other keys", async () => {
    const cs = await load();
    const { writeAuthFile } = await import("utils/auth/auth-file");
    const { verifyHash } = await import("utils/auth/password-hash");
    writeAuthFile({ secret: "s1", totp: { secret: "T" } });
    await cs.writeUser({ username: "pavel", password: "hunter2!!" });
    const stored = (await import("utils/auth/auth-file")).readAuthFile();
    expect(stored.secret).toBe("s1");
    expect(stored.totp).toEqual({ secret: "T" });
    expect(await verifyHash("hunter2!!", stored.user.passwordHash)).toBe(true);
    expect(cs.usingDefaultCredentials()).toBe(false);
    expect(cs.currentUsername()).toBe("pavel");
  });

  it("currentUsername: env wins only when both env vars set", async () => {
    const cs = await load();
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ user: { username: "stored" } });
    expect(cs.currentUsername()).toBe("stored");
    process.env.HOMEPAGE_AUTH_USERNAME = "envuser"; // password not set
    expect(cs.currentUsername()).toBe("stored");
    process.env.HOMEPAGE_AUTH_PASSWORD = "envpass";
    expect(cs.currentUsername()).toBe("envuser");
  });
});
```

- [ ] **Step 2: Run — fail. Step 3: Implement `src/utils/auth/credentials-store.js`**

```js
import { readAuthFile, writeAuthFile } from "utils/auth/auth-file";
import { hashPassword } from "utils/auth/password-hash";
import { hasOidcConfig } from "utils/auth/mode";
import { isAuthEnabled } from "utils/env";

export function managedByEnv() {
  return Boolean(process.env.HOMEPAGE_AUTH_USERNAME && process.env.HOMEPAGE_AUTH_PASSWORD);
}

export function readUser() {
  return readAuthFile().user ?? null;
}

export function usingDefaultCredentials() {
  const user = readUser();
  return !managedByEnv() && !!user && !user.passwordHash;
}

export function currentUsername() {
  if (managedByEnv()) return process.env.HOMEPAGE_AUTH_USERNAME;
  return readUser()?.username ?? "admin";
}

export async function writeUser({ username, password }) {
  const passwordHash = await hashPassword(password);
  writeAuthFile({ user: { username, passwordHash, updatedAt: new Date().toISOString() } });
}

export async function ensureInitialUser() {
  if (!isAuthEnabled()) return { created: false, reason: "disabled" };
  if (managedByEnv()) return { created: false, reason: "env" };
  if (hasOidcConfig()) return { created: false, reason: "oidc" };
  if (readAuthFile().user) return { created: false, reason: "exists" };
  try {
    writeAuthFile({ user: { username: "admin" } });
  } catch {
    return { created: false, reason: "readonly" };
  }
  return { created: true };
}
```

- [ ] **Step 4: Run — pass. Step 5: `pnpm test`; commit**

```bash
git add src/utils/auth/credentials-store.js src/utils/auth/credentials-store.test.js
git commit -m "feat(auth): add credentials-store (stored user record + bootstrap)"
```

---

## Task 6: `verifyPassword` → async, three sources

**Files:** Modify `src/utils/auth/credentials.js` + `src/utils/auth/credentials.test.js`; add `await` at the two current call sites (`[...nextauth].js` `authorize`, `2fa-check.js`).

**Interface change:** `verifyPassword` becomes `async (username, password): Promise<boolean>`.

- [ ] **Step 1: Rework the test**

```js
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("utils/logger", () => ({ default: vi.fn(() => ({ warn: warnMock })) }));

let dir;
beforeEach(() => {
  vi.resetModules();
  warnMock.mockClear();
  dir = mkdtempSync(join(tmpdir(), "ysb-cred-"));
  process.env.HOMEPAGE_CONFIG_DIR = dir;
  for (const k of ["HOMEPAGE_AUTH_USERNAME", "HOMEPAGE_AUTH_PASSWORD"]) delete process.env[k];
});
afterEach(() => { delete process.env.HOMEPAGE_CONFIG_DIR; });

const load = () => import("utils/auth/credentials");

describe("verifyPassword", () => {
  it("env override wins and ignores a stored user", async () => {
    process.env.HOMEPAGE_AUTH_USERNAME = "admin";
    process.env.HOMEPAGE_AUTH_PASSWORD = "envpw";
    const { writeAuthFile } = await import("utils/auth/auth-file");
    const { hashPassword } = await import("utils/auth/password-hash");
    writeAuthFile({ user: { username: "admin", passwordHash: await hashPassword("stored") } });
    const { verifyPassword } = await load();
    expect(await verifyPassword("admin", "envpw")).toBe(true);
    expect(await verifyPassword("admin", "stored")).toBe(false);
  });

  it("stored user WITH hash → scrypt; wrong username fails", async () => {
    const { writeUser } = await import("utils/auth/credentials-store");
    await writeUser({ username: "pavel", password: "hunter2!!" });
    const { verifyPassword } = await load();
    expect(await verifyPassword("pavel", "hunter2!!")).toBe(true);
    expect(await verifyPassword("nope", "hunter2!!")).toBe(false);
    expect(await verifyPassword("pavel", "x")).toBe(false);
  });

  it("stored user WITHOUT hash → literal admin/admin", async () => {
    const { writeAuthFile } = await import("utils/auth/auth-file");
    writeAuthFile({ user: { username: "admin" } });
    const { verifyPassword } = await load();
    expect(await verifyPassword("admin", "admin")).toBe(true);
    expect(await verifyPassword("admin", "wrong")).toBe(false);
  });

  it("no user, no env → false; non-string → false", async () => {
    const { verifyPassword } = await load();
    expect(await verifyPassword("admin", "admin")).toBe(false);
    expect(await verifyPassword(1, 2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — fail. Step 3: Implement `src/utils/auth/credentials.js`**

```js
import { createHash, timingSafeEqual } from "node:crypto";

import { readUser, managedByEnv } from "utils/auth/credentials-store";
import { verifyHash } from "utils/auth/password-hash";
import createLogger from "utils/logger";

function sha256(v) {
  return createHash("sha256").update(String(v), "utf8").digest();
}

function constantTimeEquals(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

export async function verifyPassword(username, password) {
  if (typeof username !== "string" || typeof password !== "string") return false;

  if (managedByEnv()) {
    const u = constantTimeEquals(username, process.env.HOMEPAGE_AUTH_USERNAME);
    const p = constantTimeEquals(password, process.env.HOMEPAGE_AUTH_PASSWORD);
    return u && p;
  }

  const user = readUser();
  if (!user) return false;

  if (user.passwordHash) {
    const usernameOk = constantTimeEquals(username, user.username);
    const passwordOk = await verifyHash(password, user.passwordHash);
    return usernameOk && passwordOk;
  }

  const usernameOk = constantTimeEquals(username, user.username);
  const passwordOk = constantTimeEquals(password, "admin");
  return usernameOk && passwordOk;
}

export function logFailedPasswordSignIn() {
  createLogger("nextauth").warn("Failed password sign-in attempt");
}
```

- [ ] **Step 4: Add `await` at the callers (minimal, keeps the suite green)**

- `src/pages/api/auth/[...nextauth].js` `authorize`: `if (!(await verifyPassword(username, password))) { … }`.
- `src/pages/api/auth/2fa-check.js`: `if (!(await verifyPassword(username, password))) { … }`.

- [ ] **Step 5: Update the mocks in `[...nextauth].test.js` and `2fa-check.test.js`** — wherever `verifyPassword` is `vi.fn()`, use `.mockResolvedValue(...)` / `.mockReturnValue(Promise.resolve(...))`.

- [ ] **Step 6: `pnpm test` — green. Commit**

```bash
git add src/utils/auth/credentials.js src/utils/auth/credentials.test.js "src/pages/api/auth/[...nextauth].js" src/pages/api/auth/2fa-check.js src/__tests__/pages/api/auth/*.test.js
git commit -m "feat(auth): verifyPassword resolves env -> stored user -> default, async"
```

---

## Task 7: Always-on switch + `[...nextauth].js` / `middleware.js` rewire + test audit

**Files:** `src/utils/env.js` (+ new `src/utils/env.test.js`), `src/pages/api/auth/[...nextauth].js`, `src/middleware.js`, and reworks of `[...nextauth].test.js`, `middleware.test.js`, `src/pages/api/mcp/index.test.js`.

This is the "big-bang" task: flipping `isAuthEnabled()` changes the default for every test that assumed auth-off by omission.

- [ ] **Step 1: `src/utils/env.test.js` (new, failing)**

```js
import { afterEach, describe, expect, it } from "vitest";
import { isAuthEnabled } from "utils/env";

const restore = () => delete process.env.HOMEPAGE_AUTH_ENABLED;
afterEach(restore);

describe("isAuthEnabled", () => {
  it.each([
    [undefined, true], ["", true], ["true", true], ["1", true], ["yes", true], ["false", false],
  ])("%s -> %s", (val, expected) => {
    if (val === undefined) restore();
    else process.env.HOMEPAGE_AUTH_ENABLED = val;
    expect(isAuthEnabled()).toBe(expected);
  });
});
```

- [ ] **Step 2: Flip `src/utils/env.js`**

```js
export function isAuthEnabled() {
  return process.env.HOMEPAGE_AUTH_ENABLED !== "false";
}
```

- [ ] **Step 3: Run the full suite — expect RED across `[...nextauth].test.js`, `middleware.test.js`, `mcp/index.test.js`**

Note the failures. They are all "assumed auth-off by omission".

- [ ] **Step 4: Rewire `src/pages/api/auth/[...nextauth].js`**

Near the top, replace the `HOMEPAGE_AUTH_SECRET → NEXTAUTH_SECRET` mapping with:

```js
import { ensureAuthSecret } from "utils/auth/secret";
// …
const NEXTAUTH_SECRET = authEnabled ? ensureAuthSecret() : undefined;
if (authEnabled && !process.env.NEXTAUTH_SECRET) process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET;
```

Keep the `HOMEPAGE_EXTERNAL_URL → NEXTAUTH_URL` mapping. In the `if (authEnabled)` block:

- URL parse/validate only `if (process.env.NEXTAUTH_URL)`.
- Keep `if (hasOidcConfig && !process.env.NEXTAUTH_URL) throw new Error("OIDC auth requires HOMEPAGE_EXTERNAL_URL.")`.
- Replace the password-mode throw: it now only fires on `!NEXTAUTH_SECRET` (should never happen after `ensureAuthSecret`) — keep it as a safety net with a clear message.
- `if (NEXTAUTH_SECRET.length < MIN_AUTH_SECRET_LENGTH) throw …` — check the **local const**, not `process.env.NEXTAUTH_SECRET`.
- Add the partial-env warn:

```js
const homepageAuthUsername = process.env.HOMEPAGE_AUTH_USERNAME;
const homepageAuthPassword = process.env.HOMEPAGE_AUTH_PASSWORD;
if (authEnabled && Boolean(homepageAuthUsername) !== Boolean(homepageAuthPassword)) {
  createLogger("nextauth").warn(
    "HOMEPAGE_AUTH_USERNAME / HOMEPAGE_AUTH_PASSWORD: one is set without the other — " +
      "ignoring both; using stored / default credentials",
  );
}
```

`authOptions.secret = NEXTAUTH_SECRET`.

- [ ] **Step 5: Rewire `src/middleware.js`**

```js
import { ensureAuthSecret } from "utils/auth/secret";
import { isAuthEnabled } from "utils/env";

const authEnabled = isAuthEnabled();
if (!process.env.NEXTAUTH_URL && process.env.HOMEPAGE_EXTERNAL_URL) {
  process.env.NEXTAUTH_URL = process.env.HOMEPAGE_EXTERNAL_URL;
}
const authSecret = authEnabled ? ensureAuthSecret() : undefined;
```

Everything below (`getToken`, redirect, `401`, matcher, host check) unchanged.

- [ ] **Step 6: Rework `src/__tests__/pages/api/auth/[...nextauth].test.js`**

- Add `vi.mock("utils/auth/secret", () => ({ ensureAuthSecret: () => "x".repeat(44) }))`.
- In `beforeEach`, `delete process.env.HOMEPAGE_AUTH_ENABLED` (so it defaults on) and `delete process.env.NEXTAUTH_SECRET`.
- Tests for "auth disabled" behaviour (`providers: []`, empty session) → set `process.env.HOMEPAGE_AUTH_ENABLED = "false"`.
- "throws without external URL" → move under an OIDC env (`HOMEPAGE_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET` set, no URL); assert the OIDC-scoped message.
- Password-mode provider-build tests: only need `HOMEPAGE_AUTH_ENABLED` unset/`"true"` now (secret comes from the mock, credentials from the bootstrap/verifyPassword mock). Drop `HOMEPAGE_AUTH_USERNAME`/`PASSWORD` requirements.
- New: `it("warns on a half-set credential env")` — set `HOMEPAGE_AUTH_USERNAME` only, assert `warnMock` got the partial-env line.
- `authorize` tests: `verifyPassword` mock is `mockResolvedValue`; `await provider.options.authorize({...})`.
- Keep: the sanitized-logger tests, the malformed-URL throw (with a URL provided), `useSecureCookies` `true`/`false` by URL protocol.

- [ ] **Step 7: Rework `src/middleware.test.js`**

- Add `vi.mock("utils/auth/secret", () => ({ ensureAuthSecret: () => "x".repeat(44) }))`.
- Every test asserting unauthenticated **pass-through** (`NextResponse.next()`): set `process.env.HOMEPAGE_AUTH_ENABLED = "false"` in that test.
- Add: no `HOMEPAGE_AUTH_ENABLED` + no token → page request redirects to `/auth/signin`; `/api/x` → `401`.
- Add: `HOMEPAGE_AUTH_ENABLED = "false"` + no token → `NextResponse.next()`.
- Assert `getToken` is called with `secret: "x".repeat(44)`.
- Keep the host-header-check tests (they run first, unconditionally).

- [ ] **Step 8: `src/pages/api/mcp/index.test.js`**

Set `process.env.HOMEPAGE_AUTH_ENABLED = "false"` in the cases that assumed "no auth → no session check". Add one case: unset `HOMEPAGE_AUTH_ENABLED`, no bearer token, no session → `401`.

- [ ] **Step 9: Repo-wide grep audit**

```bash
grep -rn "HOMEPAGE_AUTH_ENABLED" src --include="*.test.js" --include="*.test.jsx"
```

Any test asserting auth-*off* behaviour that does not set `="false"` is now wrong — fix it.

- [ ] **Step 10: `pnpm test` — green. Commit**

```bash
git add src/utils/env.js src/utils/env.test.js "src/pages/api/auth/[...nextauth].js" src/middleware.js src/__tests__ src/pages/api/mcp/index.test.js
git commit -m "feat(auth): login on by default; secret from config/auth.json; test audit"
```

---

## Task 8: `authorize()` brute-force throttle

**Files:** `src/pages/api/auth/[...nextauth].js` + `src/__tests__/pages/api/auth/[...nextauth].test.js`.

- [ ] **Step 1: Failing test** (add to the nextauth test file)

```js
it("throttles after 5 consecutive wrong passwords", async () => {
  vi.useFakeTimers();
  process.env.HOMEPAGE_AUTH_ENABLED = "true";
  verifyPasswordMock.mockResolvedValue(false);
  const mod = await import("pages/api/auth/[...nextauth]");
  const authorize = mod.authOptions.providers[0].options.authorize;

  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await authorize({ username: "admin", password: "x" });
  }
  verifyPasswordMock.mockClear();
  await authorize({ username: "admin", password: "x" }); // blocked
  expect(verifyPasswordMock).not.toHaveBeenCalled();
  expect(warnMock).not.toHaveBeenCalled(); // blocked path does not log

  vi.advanceTimersByTime(1100);
  verifyPasswordMock.mockResolvedValue(true);
  isTotpEnabledMock.mockReturnValue(false);
  await expect(authorize({ username: "admin", password: "ok" })).resolves.toEqual({ id: "homepage", name: "admin" });
  vi.useRealTimers();
});

it("a wrong 2FA code does not advance the throttle", async () => {
  process.env.HOMEPAGE_AUTH_ENABLED = "true";
  verifyPasswordMock.mockResolvedValue(true);
  isTotpEnabledMock.mockReturnValue(true);
  verifyTokenMock.mockReturnValue(false);
  const mod = await import("pages/api/auth/[...nextauth]");
  const authorize = mod.authOptions.providers[0].options.authorize;
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    expect(await authorize({ username: "admin", password: "ok", token: "000000" })).toBeNull();
  }
  // still evaluating (not blocked) — verifyPassword called every time
  expect(verifyPasswordMock).toHaveBeenCalledTimes(8);
});
```

- [ ] **Step 2: Run — fail. Step 3: Implement the throttle** in `[...nextauth].js` (module scope + the `authorize` body — see the spec's code block, verbatim):

```js
const FAIL_THRESHOLD = 5;
let consecutiveFailures = 0;
let blockedUntil = 0;
```

`authorize`:

```js
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
}
```

- [ ] **Step 4: Run — pass. Step 5: `pnpm test`; commit**

```bash
git add "src/pages/api/auth/[...nextauth].js" "src/__tests__/pages/api/auth/[...nextauth].test.js"
git commit -m "feat(auth): progressive-delay brute-force throttle in authorize()"
```

---

## Task 9: `src/instrumentation.js`

**Files:** Create `src/instrumentation.js` + `src/instrumentation.test.js`.

- [ ] **Step 1: Failing test**

```js
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensureAuthSecret, ensureInitialUser, isAuthEnabled } = vi.hoisted(() => ({
  ensureAuthSecret: vi.fn(),
  ensureInitialUser: vi.fn(),
  isAuthEnabled: vi.fn(),
}));
vi.mock("utils/auth/secret", () => ({ ensureAuthSecret }));
vi.mock("utils/auth/credentials-store", () => ({ ensureInitialUser }));
vi.mock("utils/env", () => ({ isAuthEnabled }));

beforeEach(() => {
  vi.clearAllMocks();
  isAuthEnabled.mockReturnValue(true);
  ensureInitialUser.mockResolvedValue({ created: false, reason: "exists" });
  process.env.NEXT_RUNTIME = "nodejs";
});
afterEach(() => { delete process.env.NEXT_RUNTIME; });

const register = async () => (await import("./instrumentation")).register(); // test sits next to the module

describe("instrumentation.register", () => {
  it("no-ops outside the nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(ensureAuthSecret).not.toHaveBeenCalled();
  });

  it("ensures secret + user when auth is on", async () => {
    await register();
    expect(ensureAuthSecret).toHaveBeenCalled();
    expect(ensureInitialUser).toHaveBeenCalled();
  });

  it("skips ensureAuthSecret when auth is off", async () => {
    isAuthEnabled.mockReturnValue(false);
    await register();
    expect(ensureAuthSecret).not.toHaveBeenCalled();
  });

  it("prints the box when a user was created", async () => {
    ensureInitialUser.mockResolvedValue({ created: true });
    const w = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await register();
    expect(w.mock.calls.join("")).toMatch(/password: admin/);
  });

  it("throws on reason:readonly", async () => {
    ensureInitialUser.mockResolvedValue({ created: false, reason: "readonly" });
    await expect(register()).rejects.toThrow(/not writable/i);
  });
});
```

(Adjust the `vi.mock` specifiers if the test file's relative `import("../instrumentation")` needs a different alias for the mocked modules — `instrumentation.js` uses `await import("./utils/...")`, so the test mocks `"utils/auth/secret"` etc. via the alias, which Vitest resolves to the same file.)

- [ ] **Step 2: Run — fail. Step 3: Implement `src/instrumentation.js`** (verbatim from the spec):

```js
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isAuthEnabled } = await import("./utils/env");
  const { ensureAuthSecret } = await import("./utils/auth/secret");
  const { ensureInitialUser } = await import("./utils/auth/credentials-store");

  if (isAuthEnabled()) ensureAuthSecret();
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
      "config/ is not writable and no HOMEPAGE_AUTH_USERNAME / HOMEPAGE_AUTH_PASSWORD is set — " +
        "cannot create a login. Make config/ writable or set the env vars.",
    );
  }
}
```

- [ ] **Step 4: Run — pass. Step 5: `pnpm test` + `pnpm build`** (confirm the build still succeeds with `instrumentation.js` present). **Commit**

```bash
git add src/instrumentation.js src/instrumentation.test.js
git commit -m "feat(auth): instrumentation.js bootstraps the secret + admin/admin account"
```

---

## Task 10: Delete `2fa-check`; sign-in page reads the flag in `getServerSideProps`

**Files:** delete `src/pages/api/auth/2fa-check.js` + `src/__tests__/pages/api/auth/2fa-check.test.js`; modify `src/pages/auth/signin.jsx` + `src/__tests__/pages/auth/signin.test.jsx`.

- [ ] **Step 1: Rework `signin.test.jsx` (failing)**

Remove the `global.fetch` / `2fa-check` mock. Mock `utils/auth/totp-store` (`isTotpEnabled`) and `utils/auth/mode` (`passwordAuthActive`) for the `getServerSideProps` tests. Component tests pass `twoFactorEnabled` as a prop directly.

```js
it("getServerSideProps adds twoFactorEnabled", async () => {
  passwordAuthActiveMock.mockReturnValue(true);
  isTotpEnabledMock.mockReturnValue(true);
  getProviders.mockResolvedValueOnce({ credentials: { id: "credentials", type: "credentials" } });
  getSettingsMock.mockReturnValueOnce({ title: "H" });
  const res = await getServerSideProps({});
  expect(res.props.twoFactorEnabled).toBe(true);
});

it("2FA off: single step, signIn on submit, error on failure", async () => {
  signIn.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
  renderPasswordSignIn({ twoFactorEnabled: false });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in|continue/i }));
  await waitFor(() => expect(signIn).toHaveBeenCalledWith("credentials",
    expect.objectContaining({ redirect: false, username: "admin", password: "admin" })));
  expect(await screen.findByText(/invalid username or password/i)).toBeInTheDocument();
});

it("2FA on: step 1 -> Continue -> code field -> signIn with token", async () => {
  signIn.mockResolvedValue({ ok: true, url: "/" });
  renderPasswordSignIn({ twoFactorEnabled: true });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  fireEvent.change(await screen.findByLabelText(/authentication code/i), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: /verify|sign in/i }));
  await waitFor(() => expect(signIn).toHaveBeenCalledWith("credentials",
    expect.objectContaining({ token: "123456" })));
});
```

Keep the sanitized-`callbackUrl` tests (they already stub `window.location`); they now drive the no-fetch flow.

- [ ] **Step 2: Run — fail. Step 3: Delete the endpoint + its test**

```bash
git rm src/pages/api/auth/2fa-check.js src/__tests__/pages/api/auth/2fa-check.test.js
```

- [ ] **Step 4: `signin.jsx` — `getServerSideProps`**

```js
import { passwordAuthActive } from "utils/auth/mode";
import { isTotpEnabled } from "utils/auth/totp-store";
// …
export async function getServerSideProps(context) {
  const providers = await getProviders();
  const homepageSettings = getSettings();
  const settings = Object.fromEntries(
    PUBLIC_SIGN_IN_SETTINGS.filter((key) => Object.prototype.hasOwnProperty.call(homepageSettings, key)).map((key) => [
      key,
      homepageSettings[key],
    ]),
  );
  const twoFactorEnabled = passwordAuthActive() ? isTotpEnabled() : false;
  return { props: { providers, settings, twoFactorEnabled } };
}
```

- [ ] **Step 5: `signin.jsx` — component**

- Accept the `twoFactorEnabled` prop.
- Remove the pre-check `fetch` and the step-1-specific "invalid username or password" derived from a `401`.
- `twoFactorEnabled === false`: one form (username + password). Submit → `await signIn("credentials", { redirect: false, username, password })`. On `res?.ok` → `window.location.assign(callbackUrl)`; else set `error` to "Invalid username or password."
- `twoFactorEnabled === true`: two client-side steps. Step 1 (username + password) → "Continue" sets `step = "code"`. Step 2 (6-digit input, same attrs as the existing code field) + a "Back" link. Submit → `await signIn("credentials", { redirect: false, username, password, token })`. On `res?.ok` → navigate; else `error` = "Invalid username, password, or code."
- Keep the existing sanitized-`callbackUrl` memo and `window.location.assign` helper.
- Keep the OIDC provider branch and the "Authentication not configured" branch untouched.

- [ ] **Step 6: Run `pnpm vitest run src/__tests__/pages/auth/signin.test.jsx` — pass. Step 7: `pnpm test`; commit**

```bash
git add src/pages/auth/signin.jsx src/__tests__/pages/auth/signin.test.jsx
git commit -m "feat(auth): drop /api/auth/2fa-check; sign-in reads the 2FA flag server-side"
```

---

## Task 11: `/api/security/credentials` + `/api/security/credentials-status`

**Files:** Create both routes + `src/__tests__/pages/api/security/credentials.test.js` + `credentials-status.test.js`.

**Interfaces (see spec §"`src/pages/api/security/credentials.js`"):** `POST { currentPassword, username, password }` → `200 { username }` / `400` / `409` / `500`; `GET` status → `200 { usingDefaultCredentials, managedByEnv, username }`.

- [ ] **Step 1: Failing tests** — mirror the totp-endpoint test style. Example for `credentials.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import createMockRes from "test-utils/create-mock-res";

const { getServerSession, verifyPassword, logFailedPasswordSignIn, currentUsername, managedByEnv, writeUser } =
  vi.hoisted(() => ({
    getServerSession: vi.fn(), verifyPassword: vi.fn(), logFailedPasswordSignIn: vi.fn(),
    currentUsername: vi.fn(() => "admin"), managedByEnv: vi.fn(() => false), writeUser: vi.fn(),
  }));
vi.mock("next-auth/next", () => ({ getServerSession }));
vi.mock("pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
vi.mock("utils/auth/credentials", () => ({ verifyPassword, logFailedPasswordSignIn }));
vi.mock("utils/auth/credentials-store", () => ({ currentUsername, managedByEnv, writeUser }));
vi.mock("utils/logger", () => ({ default: () => ({ error: vi.fn() }) }));

import handler from "pages/api/security/credentials";

beforeEach(() => {
  vi.clearAllMocks();
  getServerSession.mockResolvedValue({ user: {} });
  currentUsername.mockReturnValue("admin");
  managedByEnv.mockReturnValue(false);
});

describe("POST /api/security/credentials", () => {
  it("405 for non-POST", async () => {
    const res = createMockRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
  });
  it("401 without a session", async () => {
    getServerSession.mockResolvedValue(null);
    const res = createMockRes();
    await handler({ method: "POST", body: {} }, res);
    expect(res.statusCode).toBe(401);
  });
  it("409 when managed by env", async () => {
    managedByEnv.mockReturnValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: {} }, res);
    expect(res.statusCode).toBe(409);
  });
  it("400 + log + no write on a wrong current password", async () => {
    verifyPassword.mockResolvedValue(false);
    const res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "x", username: "pavel", password: "longenough" } }, res);
    expect(res.statusCode).toBe(400);
    expect(logFailedPasswordSignIn).toHaveBeenCalled();
    expect(writeUser).not.toHaveBeenCalled();
  });
  it("400 on a short password / bad username", async () => {
    verifyPassword.mockResolvedValue(true);
    let res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "ok", username: "pavel", password: "short" } }, res);
    expect(res.statusCode).toBe(400);
    res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "ok", username: "b a d", password: "longenough" } }, res);
    expect(res.statusCode).toBe(400);
  });
  it("200 trims the username and writes", async () => {
    verifyPassword.mockResolvedValue(true);
    const res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "ok", username: "  pavel  ", password: "longenough" } }, res);
    expect(writeUser).toHaveBeenCalledWith({ username: "pavel", password: "longenough" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ username: "pavel" });
  });
  it("500 when writeUser throws", async () => {
    verifyPassword.mockResolvedValue(true);
    writeUser.mockRejectedValue(new Error("EACCES"));
    const res = createMockRes();
    await handler({ method: "POST", body: { currentPassword: "ok", username: "pavel", password: "longenough" } }, res);
    expect(res.statusCode).toBe(500);
  });
});
```

For `credentials-status.test.js`: `405` non-GET; `401` no session; `200` returns `{ usingDefaultCredentials, managedByEnv, username }` from the mocked store for the default / changed / env cases.

- [ ] **Step 2: Run — fail. Step 3: Implement `src/pages/api/security/credentials.js`**

```js
import { getServerSession } from "next-auth/next";

import { authOptions } from "pages/api/auth/[...nextauth]";
import { logFailedPasswordSignIn, verifyPassword } from "utils/auth/credentials";
import { currentUsername, managedByEnv, writeUser } from "utils/auth/credentials-store";
import createLogger from "utils/logger";

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (managedByEnv()) {
    return res.status(409).json({ error: "Credentials are managed by environment variables." });
  }

  const { currentPassword, username, password } = req.body ?? {};
  if (!(await verifyPassword(currentUsername(), currentPassword))) {
    logFailedPasswordSignIn();
    return res.status(400).json({ error: "Current password is incorrect." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const trimmed = typeof username === "string" ? username.trim() : "";
  if (!USERNAME_RE.test(trimmed)) {
    return res
      .status(400)
      .json({ error: "Username may only contain letters, digits, dots, underscores and dashes." });
  }

  try {
    await writeUser({ username: trimmed, password });
  } catch (error) {
    createLogger("auth").error("Could not save credentials: %s", error.message);
    return res.status(500).json({ error: "Could not save credentials." });
  }
  return res.status(200).json({ username: trimmed });
}
```

- [ ] **Step 4: Implement `src/pages/api/security/credentials-status.js`**

```js
import { getServerSession } from "next-auth/next";

import { authOptions } from "pages/api/auth/[...nextauth]";
import { currentUsername, managedByEnv, usingDefaultCredentials } from "utils/auth/credentials-store";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  return res.status(200).json({
    usingDefaultCredentials: usingDefaultCredentials(),
    managedByEnv: managedByEnv(),
    username: currentUsername(),
  });
}
```

- [ ] **Step 5: Run — pass. Step 6: `pnpm test`; commit**

```bash
git add src/pages/api/security/credentials.js src/pages/api/security/credentials-status.js src/__tests__/pages/api/security/credentials*.test.js
git commit -m "feat(security): add credentials change + status endpoints"
```

---

## Task 12: `CredentialsWarning` banner

**Files:** Create `src/components/layout/CredentialsWarning.jsx` + `src/components/layout/CredentialsWarning.test.jsx`; modify `src/pages/_app.jsx`.

- [ ] **Step 1: Failing test**

```js
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useSession, useSWR } = vi.hoisted(() => ({ useSession: vi.fn(), useSWR: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession }));
vi.mock("swr", () => ({ default: useSWR }));

import CredentialsWarning from "components/layout/CredentialsWarning";

describe("CredentialsWarning", () => {
  it("nothing + no SWR key when unauthenticated", () => {
    useSession.mockReturnValue({ status: "unauthenticated" });
    useSWR.mockReturnValue({ data: undefined });
    const { container } = render(<CredentialsWarning />);
    expect(container).toBeEmptyDOMElement();
    expect(useSWR).toHaveBeenCalledWith(null, expect.anything());
  });

  it("nothing when not using default credentials", () => {
    useSession.mockReturnValue({ status: "authenticated" });
    useSWR.mockReturnValue({ data: { usingDefaultCredentials: false } });
    const { container } = render(<CredentialsWarning />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the alert + link when default", () => {
    useSession.mockReturnValue({ status: "authenticated" });
    useSWR.mockReturnValue({ data: { usingDefaultCredentials: true } });
    render(<CredentialsWarning />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /change them now/i })).toHaveAttribute("href", "/security");
  });
});
```

- [ ] **Step 2: Run — fail. Step 3: Implement**

```jsx
import Link from "next/link";
import { useSession } from "next-auth/react";
import useSWR from "swr";

export default function CredentialsWarning() {
  const { status } = useSession();
  const { data } = useSWR(status === "authenticated" ? "/api/security/credentials-status" : null);

  if (!data?.usingDefaultCredentials) return null;

  return (
    <div
      role="alert"
      className="w-full bg-red-600 px-4 py-2 pl-14 text-sm text-white sm:pl-16"
    >
      You&apos;re signed in with the default admin / admin credentials — anyone who can reach this page can log in.{" "}
      <Link href="/security" className="font-medium underline">
        Change them now
      </Link>
    </div>
  );
}
```

- [ ] **Step 4: `_app.jsx` — insert after `<NavHeader />`**

```jsx
                <NavHeader />
                <CredentialsWarning />
                <Component {...pageProps} />
```

+ `import CredentialsWarning from "components/layout/CredentialsWarning";`.

- [ ] **Step 5: Run — pass. Step 6: `pnpm test`; commit**

```bash
git add src/components/layout/CredentialsWarning.jsx src/components/layout/CredentialsWarning.test.jsx src/pages/_app.jsx
git commit -m "feat(security): default-credentials warning banner"
```

---

## Task 13: `/security` Account card + wizard

**Files:** modify `src/pages/security.jsx` + `src/__tests__/pages/security.test.jsx`.

- [ ] **Step 1: Rework the test** — see the spec's §"`src/pages/security.jsx`" test bullet. Cover: `getServerSideProps` adds `managedByEnv` + `currentUsername`; summary shows the username; `managedByEnv` → explanatory text + no button; wizard step 1 validation (`password !== confirm` blocks POST); `200` → username updates + `mutate("/api/security/credentials-status")` called + advances (to `twofa` when the `twoFactorEnabled` prop is false, straight to `summary` when true); step 2 "Not now" → summary; step 2 "Set up 2FA" → enroll/confirm happy path (reuse the existing enroll/confirm mocks); the existing standalone-2FA-card tests still pass and their `phase`/`error`/`busy` are untouched.

Mock `swr`'s `mutate` (`vi.mock("swr", () => ({ mutate: vi.fn() }))` or spy).

- [ ] **Step 2: Run — fail. Step 3: Implement `security.jsx`**

- `getServerSideProps` → also read `managedByEnv()` and `currentUsername()` (from `utils/auth/credentials-store`), pass as props.
- Lift the 2FA card's `enabled` boolean to a page-level `useState(twoFactorEnabled)`.
- New **Account** card (own state: `wizardStep`, `wizardError`, `wizardBusy`, plus reuse of the enroll state for step 2), rendered above the 2FA card:
  - `summary`: "Signed in as **{currentUsername}**". `managedByEnv` → the "managed by environment variables" paragraph, no button. Else → "Change username & password" button → `wizardStep = "credentials"`.
  - `credentials`: 4 inputs. On submit: guard `password === confirm` client-side; `POST /api/security/credentials` (via the existing `postJson` helper). `!res.ok` → `wizardError = (await res.json()).error`. `res.ok` → update a local `displayUsername`, `import { mutate } from "swr"; mutate("/api/security/credentials-status")`, then `wizardStep = twoFactorEnabled ? "summary" : "twofa"`.
  - `twofa`: "Add two-factor authentication?" + "Set up 2FA" / "Not now". "Not now" → `summary`. "Set up 2FA" → run the existing enroll → QR + code field → confirm flow; on confirm `200` → `setEnabled(true)` + `wizardStep = "summary"`.
- The existing 2FA card: unchanged except it now reads `enabled` / `setEnabled` from page state.

- [ ] **Step 4: Run — pass. Step 5: `pnpm test`; commit**

```bash
git add src/pages/security.jsx src/__tests__/pages/security.test.jsx
git commit -m "feat(security): Account card with the change-credentials + optional-2FA wizard"
```

---

## Task 14: `docker-compose.yml` + `.env.example` + empty-string-env test

**Files:** `docker-compose.yml`, `.env.example`, a small test in `src/utils/env.test.js` or `mode.test.js`.

- [ ] **Step 1: Add the env passthrough to `docker-compose.yml`** — the 10 `HOMEPAGE_*` lines from the spec (`${YSB_*:-}` form), appended to the existing `environment:` list.

- [ ] **Step 2: `.env.example`** — document `YSB_AUTH_ENABLED`, `YSB_EXTERNAL_URL`, `YSB_AUTH_SECRET`, `YSB_AUTH_USERNAME`, `YSB_AUTH_PASSWORD`, `YSB_OIDC_*`, and a one-line note that login is on by default with `admin`/`admin` and must be changed before public exposure.

- [ ] **Step 3: Empty-string test** — assert the consumers treat `""` as unset:

```js
it("empty-string env vars behave as unset", async () => {
  process.env.HOMEPAGE_AUTH_USERNAME = "";
  process.env.HOMEPAGE_AUTH_PASSWORD = "";
  const { managedByEnv } = await import("utils/auth/credentials-store");
  expect(managedByEnv()).toBe(false);
});
```

- [ ] **Step 4: `pnpm test`; commit**

```bash
git add docker-compose.yml .env.example src/utils/*.test.js
git commit -m "feat(deploy): pass HOMEPAGE_AUTH_*/OIDC env through docker-compose"
```

---

## Task 15: Docs + full sweep + manual verification

**Files:** `docs/installation/index.md`, `README.md`, `progress.md`.

- [ ] **Step 1: `docs/installation/index.md`** — rewrite Security & Authentication per the spec's §Documentation: login on by default with `admin`/`admin`; a `!!! warning` callout to change / pin credentials before public exposure; `HOMEPAGE_AUTH_ENABLED=false` to disable; `NEXTAUTH_SECRET` auto-generated to `config/auth.json` (set `HOMEPAGE_AUTH_SECRET` for multi-replica / read-only `config/`); `HOMEPAGE_EXTERNAL_URL` optional for password mode, required for OIDC + HTTPS `Secure` cookies; the in-app throttle **plus** the still-recommended reverse-proxy rate limit + fail2ban on `<nextauth> Failed password sign-in attempt` for `POST /api/auth/callback/credentials`; recovery = delete `config/auth.json`; the two breaking-change notes.

- [ ] **Step 2: `README.md`** — update the auth bullet(s) + the security note (default-on, `admin`/`admin`, change before exposing).

- [ ] **Step 3: `progress.md`** — a shipped entry describing the feature; both breaking changes (#1 always-on, #2 MCP session).

- [ ] **Step 4: Full sweep**

```bash
pnpm test
pnpm lint
```

Both green. Fix any stragglers (import order, unused vars).

- [ ] **Step 5: Manual verification** — run the 11-point checklist in the spec's §Verification. Record pass/fail for each in the execution notes. Steps 1 (spike, already done in Task 0), 2–8 local, 9 Docker, 10 throttle, 11 read-only.

- [ ] **Step 6: Commit**

```bash
git add docs/installation/index.md README.md progress.md
git commit -m "docs: default-on auth, admin/admin bootstrap, credential wizard, throttle"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task(s) |
|---|---|
| Next 16 middleware = Node runtime | 0 (spike) |
| `config/auth.json` one file + `auth-file.js` + `clearTotpState` bug | 1 |
| `password-hash.js` (async scrypt, format) | 2 |
| `secret.js` `ensureAuthSecret` | 3 |
| `mode.js` `hasOidcConfig` export, `passwordAuthActive` | 4 |
| `credentials-store.js` (predicates, `writeUser`, `ensureInitialUser`, no `mustChange`) | 5 |
| `verifyPassword` async, 3 sources, no fall-through | 6 |
| `isAuthEnabled` default-on + `[...nextauth]`/`middleware` rewire (`ensureAuthSecret` gated, local `NEXTAUTH_SECRET` const, `NEXTAUTH_URL` map in middleware, partial-env warn, drop throws) + test audit | 7 |
| `authorize` throttle (no log while blocked, 2FA-fail doesn't advance) | 8 |
| `instrumentation.js` (`isAuthEnabled` guard, box, `readonly` throw) | 9 |
| Delete `2fa-check`; `signin.jsx` `getServerSideProps` flag + no-fetch form | 10 |
| `/api/security/credentials` + `/credentials-status` | 11 |
| `CredentialsWarning` + `_app.jsx` (conditional SWR key, `role="alert"`) | 12 |
| `security.jsx` Account card + wizard (own state, lift `enabled`, `mutate`) | 13 |
| `docker-compose.yml` / `.env.example` + `${VAR:-}` truthiness | 14 |
| Docs (`installation`, `README`, `progress`), full sweep, 11-point manual verification | 15 |
| MCP behaviour shift (breaking #2) | 7 (test), 15 (docs) |

**Placeholder scan:** no "TBD"/"add error handling"/"write tests for the above" — every code step has real code; every test step has real assertions; the exhaustive per-file test case lists live in the committed spec, which travels with this plan.

**Type / name consistency:** `readAuthFile`/`writeAuthFile`/`authFilePath` (Task 1) used identically in 3, 5, 6. `ensureAuthSecret` (Task 3) — Tasks 7 (middleware + nextauth), 9. `verifyPassword` async `Promise<boolean>` (Task 6) — awaited in Tasks 7/8 (`authorize`), 11 (`credentials.js`). `currentUsername` / `managedByEnv` / `usingDefaultCredentials` / `writeUser` / `readUser` / `ensureInitialUser` (Task 5) — Tasks 9, 10 (gSSP via `passwordAuthActive`), 11, 12 (via the status route), 13. `hasOidcConfig()` exported (Task 4) — Task 5. `twoFactorEnabled` prop (Task 10) — Task 13 (`security.jsx` reuses the same server-side derivation). Throttle constant `FAIL_THRESHOLD = 5` (Task 8) — Task 8 test uses 5.

**Ordering check:** every module a task imports is created in an earlier task (1 → 2 → 3 → 4 → 5 → 6 → 7 → 8, then 9–13 depend only on 1–8). Task 7 is the one big-bang (env flip); Task 6 pre-adds `await` at the call sites so 7's suite starts from green-minus-the-env-flip. The spike (0) gates the whole shape.
