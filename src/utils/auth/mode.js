import { isAuthEnabled } from "utils/env";

// mirror of the OIDC check in src/pages/api/auth/[...nextauth].js
export function hasOidcConfig() {
  return Boolean(
    process.env.HOMEPAGE_OIDC_ISSUER && process.env.HOMEPAGE_OIDC_CLIENT_ID && process.env.HOMEPAGE_OIDC_CLIENT_SECRET,
  );
}

export function passwordAuthActive() {
  return isAuthEnabled() && !hasOidcConfig();
}
