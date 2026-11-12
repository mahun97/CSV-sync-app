import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getNumberIndex, findConflicts, nextFreeNumber } from "../lib/artikelnummern.server";

// Live-Prüfung im Produkt-Editor: ist Product model / Products id schon bei einem anderen Produkt vergeben?
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const index = await getNumberIndex(admin);
  const conflicts = findConflicts(index, {
    productId: url.searchParams.get("id") || null,
    product_model: url.searchParams.get("pm") || "",
    products_id: url.searchParams.get("pi") || "",
  });
  return json({ conflicts, next: nextFreeNumber(index), checked: `${url.searchParams.get("pm") || ""}|${url.searchParams.get("pi") || ""}` });
};
