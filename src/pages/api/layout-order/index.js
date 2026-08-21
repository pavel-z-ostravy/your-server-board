import { isValidSectionOrder } from "utils/config/layoutOrder";
import { getLayoutOrder, writeLayoutOrder } from "utils/config/layoutOrder.server";
import createLogger from "utils/logger";

const logger = createLogger("layoutOrderApi");

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.method === "GET") {
    return res.status(200).json({ order: getLayoutOrder() });
  }

  const { order } = req.body ?? {};
  if (!isValidSectionOrder(order)) {
    return res.status(400).json({ error: "Invalid order" });
  }

  try {
    const merged = writeLayoutOrder(order);
    return res.status(200).json({ order: merged });
  } catch (error) {
    logger.error("Failed to persist layout order:", error);
    return res.status(500).json({ error: "Failed to persist layout order" });
  }
}
