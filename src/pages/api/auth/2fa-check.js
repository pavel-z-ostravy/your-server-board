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
