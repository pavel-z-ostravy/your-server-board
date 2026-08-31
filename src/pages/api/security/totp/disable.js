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
