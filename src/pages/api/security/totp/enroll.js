import { getServerSession } from "next-auth/next";

import { authOptions } from "pages/api/auth/[...nextauth]";
import { generateEnrollment, qrDataUrl } from "utils/auth/totp";
import { isTotpEnabled } from "utils/auth/totp-store";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (isTotpEnabled()) return res.status(409).json({ error: "2FA is already enabled" });

  const { secret, otpauthUrl } = generateEnrollment(session.user?.name ?? "user");
  return res.status(200).json({ secret, otpauthUrl, qrDataUrl: await qrDataUrl(otpauthUrl) });
}
