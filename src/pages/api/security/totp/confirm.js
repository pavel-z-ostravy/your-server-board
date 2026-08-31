import { getServerSession } from "next-auth/next";

import { authOptions } from "pages/api/auth/[...nextauth]";
import createLogger from "utils/logger";
import { verifyToken } from "utils/auth/totp";
import { isTotpEnabled, writeTotpState } from "utils/auth/totp-store";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (isTotpEnabled()) return res.status(409).json({ error: "2FA is already enabled" });

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
