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
