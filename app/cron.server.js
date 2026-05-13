import cron from "node-cron";
import prisma from "./db.server";
import { readSheetCSV } from "./lib/readSheet.server";

const API_VERSION = "2024-10";

// --------------------
// Refresh access token
// --------------------
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
  if (!res.ok)
    throw new Error(`Refresh failed: ${res.status} ${JSON.stringify(json)}`);
  return json; // { access_token, expires_in, refresh_token?, refresh_token_expires_in? }
}

// --------------------
// Get valid offline session (refresh if expired)
// --------------------
async function getValidOfflineSession() {
  const offline = await prisma.session.findFirst({
    where: { id: { startsWith: "offline_" } },
    // pull refresh + expiry too
    select: {
      id: true,
      accessToken: true,
      expires: true,
      refreshToken: true,
      refreshTokenExpires: true,
    },
  });

  console.log("offline", offline);

  if (!offline?.accessToken) {
    throw new Error(
      "No offline access token found. Install app on the store first.",
    );
  }

  const shop = offline.id.replace("offline_", "");

  // If no expires saved, treat as non-expiring
  if (!offline.expires) return { shop, token: offline.accessToken };

  const expiresAt = new Date(offline.expires).getTime();
  const now = Date.now();

  // refresh 2 mins early
  const shouldRefresh = now >= expiresAt - 2 * 60 * 1000;

  if (!shouldRefresh) return { shop, token: offline.accessToken };

  if (!offline.refreshToken) {
    throw new Error(
      "Access token expired and no refreshToken available. Reinstall app.",
    );
  }

  const refreshed = await refreshAccessToken(shop, offline.refreshToken);

  // save new tokens (refresh token may rotate)
  const updated = await prisma.session.update({
    where: { id: offline.id },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? offline.refreshToken,
      expires: refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000)
        : offline.expires,
      refreshTokenExpires: refreshed.refresh_token_expires_in
        ? new Date(Date.now() + refreshed.refresh_token_expires_in * 1000)
        : offline.refreshTokenExpires,
    },
    select: { accessToken: true },
  });

  return { shop, token: updated.accessToken };
}

// --------------------
// GraphQL call helper
// --------------------
async function graphqlForShop(shop, accessToken, query) {
  const res = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    },
  );

  const json = await res.json();

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}


async function runOnce() {
  const { shop, token } = await getValidOfflineSession();

  const ping = await graphqlForShop(
    shop,
    token,
    `query { shop { name } }`
  );

  console.log("🚀 Pricing metafield sync started for:", ping.shop.name);

  // 1️⃣ LOAD CSV
  const rows = await readSheetCSV();
  console.log("✅ CSV Loaded:", rows.length, "rows");

  const priceMap = {};
  for (const row of rows) {
    const csvProductId = String(row["product id"] || "").trim();
    const price = row["recommended price"];

    if (csvProductId && price) {
      priceMap[csvProductId] = Number(String(price).replace(",", "."));
    }
  }

  console.log("🧾 CSV Products:", Object.keys(priceMap).length);

  // 2️⃣ PAGINATION
  let hasNextPage = true;
  let cursor = null;
  let updated = 0;
  let scanned = 0;

  while (hasNextPage) {
    const data = await graphqlForShop(
      shop,
      token,
      `{
        productVariants(first: 100, after: ${cursor ? `"${cursor}"` : null}) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              sku
              omnia: metafield(namespace: "custom", key: "omnia") {
                value
              }
              pricing: metafield(namespace: "custom", key: "pricing") {
                value
              }
                pricingPremium: metafield(namespace: "custom", key: "pricing_premium") {
  value
}

pricingCustomer: metafield(namespace: "custom", key: "pricing_customer") {
  value
}
            }
          }
        }
      }`
    );

    const variants = data.productVariants.edges;
    console.log("📦 Scanning batch:", variants.length);

    for (const edge of variants) {
      const variant = edge.node;
      scanned++;

      // ✅ FIX: Changed from variant.metafield to variant.omnia (use the alias)
      const metafieldValue = variant.omnia?.value?.trim();
      if (!metafieldValue) continue;

      const csvPrice = priceMap[metafieldValue];
      if (csvPrice == null || Number.isNaN(csvPrice)) continue;

      // 3️⃣ SAFE PARSE EXISTING JSON
      let existing = {};
      try {
        existing = variant.pricing?.value
          ? JSON.parse(variant.pricing.value)
          : {};
      } catch {
        existing = {};
      }
      let existingPremium = {};
try {
  existingPremium = variant.pricingPremium?.value
    ? JSON.parse(variant.pricingPremium.value)
    : {};
} catch {
  existingPremium = {};
}

let existingCustomer = {};
try {
  existingCustomer = variant.pricingCustomer?.value
    ? JSON.parse(variant.pricingCustomer.value)
    : {};
} catch {
  existingCustomer = {};
}

      // 4️⃣ BUILD PATCH (NO STRUCTURE OVERWRITE)
      const newPricing = {

        ...existing,

        base_price: existing.base_price, // NEVER TOUCH

        base_price_google: csvPrice,
        base_price_idealo: csvPrice,
      };

      // ONLY PATCH tiered_google if exists
      if (existing.tiered_price_google) {
        newPricing.tiered_price_google = {
          ...existing.tiered_price_google,
          1: csvPrice,
        };
      }

      // ONLY PATCH tiered_idealo if exists
      if (existing.tiered_price_idealo) {
        newPricing.tiered_price_idealo = {
          ...existing.tiered_price_idealo,
          1: csvPrice,
        };
      }

      // ONLY KEEP tiered_price if it already exists
      if (existing.tiered_price) {
        newPricing.tiered_price = existing.tiered_price;
      }

      const newPremiumPricing = {
  ...existingPremium,

  base_price: existingPremium.base_price,

  base_price_google: csvPrice,
  base_price_idealo: csvPrice,
};

if (existingPremium.tiered_price_google) {
  newPremiumPricing.tiered_price_google = {
    ...existingPremium.tiered_price_google,
    1: csvPrice,
  };
}

if (existingPremium.tiered_price_idealo) {
  newPremiumPricing.tiered_price_idealo = {
    ...existingPremium.tiered_price_idealo,
    1: csvPrice,
  };
}

if (existingPremium.tiered_price) {
  newPremiumPricing.tiered_price = existingPremium.tiered_price;
}

const newCustomerPricing = {
  ...existingCustomer,

  base_price: existingCustomer.base_price,

  base_price_google: csvPrice,
  base_price_idealo: csvPrice,
};

if (existingCustomer.tiered_price_google) {
  newCustomerPricing.tiered_price_google = {
    ...existingCustomer.tiered_price_google,
    1: csvPrice,
  };
}

if (existingCustomer.tiered_price_idealo) {
  newCustomerPricing.tiered_price_idealo = {
    ...existingCustomer.tiered_price_idealo,
    1: csvPrice,
  };
}

if (existingCustomer.tiered_price) {
  newCustomerPricing.tiered_price = existingCustomer.tiered_price;
}

      console.log("💰 Updating SKU:", variant.sku);

      try {
       await graphqlForShop(
  shop,
  token,
  `mutation {
    metafieldsSet(metafields: [

      {
        ownerId: "${variant.id}"
        namespace: "custom"
        key: "pricing"
        type: "json"
        value: "${JSON.stringify(newPricing)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')}"
      },

      {
        ownerId: "${variant.id}"
        namespace: "custom"
        key: "pricing_premium"
        type: "json"
        value: "${JSON.stringify(newPremiumPricing)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')}"
      },

      {
        ownerId: "${variant.id}"
        namespace: "custom"
        key: "pricing_customer"
        type: "json"
        value: "${JSON.stringify(newCustomerPricing)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')}"
      }

    ]) {
      userErrors {
        field
        message
      }
    }
  }`
);

        updated++;
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.log("❌ Update failed:", err.message);
      }
    }

    hasNextPage = data.productVariants.pageInfo.hasNextPage;
    cursor = data.productVariants.pageInfo.endCursor;
  }

  console.log("──────── SYNC COMPLETE ────────");
  console.log("Variants scanned:", scanned);
  console.log("Variants updated:", updated);
  console.log("───────────────────────────────");
}


// ✅ don't crash dev server
runOnce().catch(console.error);
let isRunning = false;

cron.schedule("*/3 * * * *", async () => {
  if (isRunning) {
    console.log("⏳ Skipping run (already running)");
    return;
  }

  isRunning = true;
  try {
    await runOnce();
  } catch (e) {
    console.error(e);
  } finally {
    isRunning = false;
  }
});