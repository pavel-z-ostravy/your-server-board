export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isAuthEnabled } = await import("./utils/env");
  const { ensureAuthSecret } = await import("./utils/auth/secret");
  const { ensureInitialUser } = await import("./utils/auth/credentials-store");
  const { readAuthFile, authFileCorrupt } = await import("./utils/auth/auth-file");

  // Detect a present-but-unparseable config/auth.json BEFORE anything writes to
  // it. ensureAuthSecret() would otherwise atomically replace the corrupt file
  // with a minimal {secret}, destroying the original bytes and letting the next
  // restart read a valid-but-userless file and silently re-bootstrap admin/admin
  // with the 2FA secret gone.
  readAuthFile();
  if (isAuthEnabled() && authFileCorrupt()) {
    throw new Error(
      "config/auth.json exists but could not be parsed. Refusing to touch it — creating a fresh " +
        "default account would drop your credentials and 2FA secret. Fix or remove the file and restart.",
    );
  }

  if (isAuthEnabled()) {
    const secret = ensureAuthSecret();
    const fromEnv = Boolean(process.env.NEXTAUTH_SECRET || process.env.HOMEPAGE_AUTH_SECRET);
    if (!fromEnv && readAuthFile().secret !== secret) {
      throw new Error(
        "Could not persist the auth signing secret to config/auth.json and no HOMEPAGE_AUTH_SECRET is set. " +
          "The middleware and the auth route would use different secrets, so every sign-in would fail. " +
          "Make config/ writable or set HOMEPAGE_AUTH_SECRET.",
      );
    }
  }
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
  if (init.reason === "corrupt") {
    throw new Error(
      "config/auth.json exists but could not be parsed. Refusing to overwrite it with a fresh " +
        "default account (which would drop your credentials and 2FA secret). Fix or remove the file and restart.",
    );
  }
  if (init.reason === "readonly") {
    throw new Error(
      "config/ is not writable and no HOMEPAGE_AUTH_USERNAME / HOMEPAGE_AUTH_PASSWORD is set — " +
        "cannot create a login. Make config/ writable or set the env vars.",
    );
  }
}
