import { getServerSession } from "next-auth/next";

import { authOptions } from "pages/api/auth/[...nextauth]";
import { currentUsername, managedByEnv, usingDefaultCredentials } from "utils/auth/credentials-store";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  return res.status(200).json({
    usingDefaultCredentials: usingDefaultCredentials(),
    managedByEnv: managedByEnv(),
    username: currentUsername(),
  });
}
