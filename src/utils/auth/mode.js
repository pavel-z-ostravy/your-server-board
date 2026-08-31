import { isAuthEnabled } from "utils/env";

// True only when username + password login is the active authentication mode:
// auth is enabled, OIDC is not fully configured (which would take over), and a
// password is set. Mirrors the credentials-provider build condition in
// `src/pages/api/auth/[...nextauth].js` (`authEnabled && !hasOidcConfig`, plus a
// password). Reads env at call time so tests and runtime config changes take
// effect without a reload.
export function passwordAuthActive() {
  const hasOidcConfig = Boolean(
    process.env.HOMEPAGE_OIDC_ISSUER && process.env.HOMEPAGE_OIDC_CLIENT_ID && process.env.HOMEPAGE_OIDC_CLIENT_SECRET,
  );
  return isAuthEnabled() && !hasOidcConfig && Boolean(process.env.HOMEPAGE_AUTH_PASSWORD);
}
