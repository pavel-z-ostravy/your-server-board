import { logFailedPasswordSignIn, verifyPassword } from "utils/auth/credentials";
import { passwordAuthActive } from "utils/auth/mode";
import { isTotpEnabled } from "utils/auth/totp-store";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Only meaningful when username + password is the active auth mode. Otherwise
  // this would be an unauthenticated password-validity + 2FA-state oracle, and
  // the plan gates every 2FA surface on HOMEPAGE_AUTH_ENABLED.
  if (!passwordAuthActive()) {
    return res.status(404).json({ error: "Not found" });
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
