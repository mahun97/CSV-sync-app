import prisma from "../db.server";

// Admin-Zugriff ohne Browser-Sitzung (Cron, Repricer) über die gespeicherte Offline-Sitzung.
const API_VERSION = "2025-01";

async function refreshAccessToken(shop, refreshToken) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export async function getOfflineSession() {
  const offline = await prisma.session.findFirst({
    where: { id: { startsWith: "offline_" } },
    select: { id: true, accessToken: true, expires: true, refreshToken: true, refreshTokenExpires: true },
  });
  if (!offline?.accessToken) throw new Error("Kein Offline-Token gefunden. App neu installieren.");

  const shop = offline.id.replace("offline_", "");
  if (!offline.expires) return { shop, token: offline.accessToken };

  const shouldRefresh = Date.now() >= new Date(offline.expires).getTime() - 2 * 60 * 1000;
  if (!shouldRefresh) return { shop, token: offline.accessToken };
  if (!offline.refreshToken) throw new Error("Token abgelaufen und kein Refresh-Token vorhanden.");

  const refreshed = await refreshAccessToken(shop, offline.refreshToken);
  const updated = await prisma.session.update({
    where: { id: offline.id },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? offline.refreshToken,
      expires: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : offline.expires,
      refreshTokenExpires: refreshed.refresh_token_expires_in
        ? new Date(Date.now() + refreshed.refresh_token_expires_in * 1000)
        : offline.refreshTokenExpires,
    },
    select: { accessToken: true },
  });
  return { shop, token: updated.accessToken };
}

export async function offlineGraphql(query, variables = {}) {
  const { shop, token } = await getOfflineSession();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    const throttled = res.status === 429 || json.errors?.some?.((e) => e.extensions?.code === "THROTTLED");
    if (throttled) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
  throw new Error("Shopify-API dauerhaft gedrosselt");
}
