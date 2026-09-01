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
    return res.status(400).json({ error: "Username may only contain letters, digits, dots, underscores and dashes." });
  }

  try {
    await writeUser({ username: trimmed, password });
  } catch (error) {
    createLogger("auth").error("Could not save credentials: %s", error.message);
    return res.status(500).json({ error: "Could not save credentials." });
  }
  return res.status(200).json({ username: trimmed });
}
