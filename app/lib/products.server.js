import { PRODUCT_METAFIELDS, VARIANT_METAFIELDS, num } from "./productFields";

const NS = "custom";

async function gql(admin, query, variables = {}) {
  const res = await admin.graphql(query, { variables });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const pmAliases = PRODUCT_METAFIELDS.map((f) => `m_${f.key}: metafield(namespace: "${NS}", key: "${f.key}") { value }`).join("\n");
const vmAliases = [...VARIANT_METAFIELDS.map((f) => f.key), "pricing", "pricing_premium", "pricing_customer"]
  .map((k) => `m_${k}: metafield(namespace: "${NS}", key: "${k}") { value }`)
  .join("\n");

const PRODUCT_QUERY = `
  query ($id: ID!) {
    product(id: $id) {
      id title handle vendor productType status tags descriptionHtml onlineStorePreviewUrl updatedAt
      options { name values }
      media(first: 20) { nodes { ... on MediaImage { id image { url altText } } } }
      ${pmAliases}
      variants(first: 50) {
        nodes {
          id title sku barcode price compareAtPrice
          selectedOptions { name value }
          inventoryItem {
            id
            unitCost { amount }
            inventoryLevels(first: 5) { nodes { location { id name } quantities(names: ["available"]) { quantity } } }
          }
          ${vmAliases}
        }
      }
    }
    locations(first: 10) { nodes { id name isActive } }
  }
`;

const pickMeta = (node, fields) => Object.fromEntries(fields.map((k) => [k, node[`m_${k}`]?.value ?? ""]));

export async function loadLocations(admin) {
  const d = await gql(admin, `{ locations(first: 10) { nodes { id name isActive } } }`);
  return d.locations.nodes.filter((l) => l.isActive);
}

export async function loadProduct(admin, gid) {
  const d = await gql(admin, PRODUCT_QUERY, { id: gid });
  const p = d.product;
  if (!p) return null;
  const locations = d.locations.nodes.filter((l) => l.isActive);
  const mainLoc = locations[0]?.id;
  return {
    locations,
    product: {
      id: p.id,
      title: p.title,
      handle: p.handle,
      vendor: p.vendor,
      productType: p.productType,
      status: p.status,
      tags: (p.tags || []).join(", "),
      descriptionHtml: p.descriptionHtml || "",
      previewUrl: p.onlineStorePreviewUrl,
      updatedAt: p.updatedAt,
      options: p.options,
      images: p.media.nodes.filter((m) => m.image).map((m) => ({ id: m.id, url: m.image.url, alt: m.image.altText })),
      meta: pickMeta(p, PRODUCT_METAFIELDS.map((f) => f.key)),
      variants: p.variants.nodes.map((v) => {
        const meta = pickMeta(v, VARIANT_METAFIELDS.map((f) => f.key));
        let pricing = {};
        try { pricing = JSON.parse(v.m_pricing?.value || "{}"); } catch {}
        const level = v.inventoryItem.inventoryLevels.nodes.find((l) => l.location.id === mainLoc) || v.inventoryItem.inventoryLevels.nodes[0];
        return {
          id: v.id,
          title: v.title,
          selectedOptions: v.selectedOptions,
          sku: v.sku || "",
          barcode: v.barcode || "",
          // Verkaufspreis = Google-Preis aus custom.pricing (wie der Ein-Preis-Abgleich), sonst Shopify-Preis
          price: String(pricing.base_price_google ?? pricing.base_price ?? v.price ?? ""),
          shopPrice: v.price,
          compareAtPrice: v.compareAtPrice || "",
          cost: v.inventoryItem.unitCost?.amount ?? "",
          inventoryItemId: v.inventoryItem.id,
          stock: level?.quantities?.[0]?.quantity ?? "",
          stockLocationId: level?.location?.id || mainLoc,
          stockLocationName: level?.location?.name || "",
          meta,
          pricingRaw: { pricing: v.m_pricing?.value || "", premium: v.m_pricing_premium?.value || "", customer: v.m_pricing_customer?.value || "" },
        };
      }),
    },
  };
}

function metaValue(field, value) {
  if (field.key === "omnia_min" || field.key === "omnia_max") return String(value ?? "").replace(",", ".").trim();
  if (field.kind === "bool" || field.type === "boolean") return value === true || value === "true" ? "true" : "false";
  if (field.kind === "flag10") return value === true || value === "true" || value === "1" ? "1" : "0";
  if (field.type === "number_integer") return String(parseInt(String(value).replace(",", "."), 10) || 0);
  if (field.type === "single_line_text_field") return String(value ?? "").replace(/\s*\n\s*/g, " ").trim();
  return String(value ?? "").trim();
}

function patchPricing(raw, price) {
  let p = {};
  try { p = JSON.parse(raw || "{}"); } catch {}
  const out = { ...p, base_price_google: price, base_price_idealo: price };
  if (out.base_price === undefined || out.base_price === null) out.base_price = price;
  if (p.tiered_price_google) out.tiered_price_google = { ...p.tiered_price_google, 1: price };
  if (p.tiered_price_idealo) out.tiered_price_idealo = { ...p.tiered_price_idealo, 1: price };
  return out;
}

// Baut metafieldsSet-Einträge + Löschungen für leere Felder
function collectMetafields(ownerId, fields, values, original = {}) {
  const set = [];
  const del = [];
  for (const f of fields) {
    const raw = values?.[f.key];
    if (raw === undefined) continue;
    const empty = raw === "" || raw === null;
    if (empty && f.kind !== "bool" && f.kind !== "flag10") {
      if (original[f.key]) del.push({ ownerId, namespace: NS, key: f.key });
      continue;
    }
    const value = metaValue(f, raw);
    if (String(original[f.key] ?? "") === value) continue;
    set.push({ ownerId, namespace: NS, key: f.key, type: f.type, value });
  }
  return { set, del };
}

async function flushMetafields(admin, set, del, errors) {
  for (let i = 0; i < set.length; i += 25) {
    const d = await gql(admin, `mutation ($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`, { m: set.slice(i, i + 25) });
    errors.push(...d.metafieldsSet.userErrors.map((e) => `Metafeld: ${e.message}`));
  }
  if (del.length) {
    const d = await gql(admin, `mutation ($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { field message } } }`, { m: del });
    errors.push(...d.metafieldsDelete.userErrors.map((e) => `Metafeld löschen: ${e.message}`));
  }
}

async function setStock(admin, items, errors) {
  if (!items.length) return;
  const d = await gql(
    admin,
    `mutation ($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message } } }`,
    { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: items } },
  );
  errors.push(...d.inventorySetQuantities.userErrors.map((e) => `Bestand: ${e.message}`));
}

async function addImages(admin, productId, urls, errors) {
  const media = urls.filter((u) => /^https?:\/\//.test(u)).map((u) => ({ originalSource: u, mediaContentType: "IMAGE" }));
  if (!media.length) return;
  const d = await gql(
    admin,
    `mutation ($id: ID!, $media: [CreateMediaInput!]!) { productCreateMedia(productId: $id, media: $media) { mediaUserErrors { message } } }`,
    { id: productId, media },
  );
  errors.push(...d.productCreateMedia.mediaUserErrors.map((e) => `Bild: ${e.message}`));
}

export async function saveProduct(admin, data, original) {
  const errors = [];
  const pid = data.id;

  const up = await gql(
    admin,
    `mutation ($p: ProductUpdateInput!) { productUpdate(product: $p) { userErrors { field message } } }`,
    {
      p: {
        id: pid,
        title: data.title,
        vendor: data.vendor,
        productType: data.productType,
        status: data.status,
        tags: String(data.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
        descriptionHtml: data.descriptionHtml,
      },
    },
  );
  errors.push(...up.productUpdate.userErrors.map((e) => e.message));

  const origVariants = Object.fromEntries((original?.variants || []).map((v) => [v.id, v]));
  const bulk = [];
  const set = [];
  const del = [];
  const stock = [];

  const pm = collectMetafields(pid, PRODUCT_METAFIELDS, data.meta, original?.meta);
  set.push(...pm.set);
  del.push(...pm.del);

  for (const v of data.variants) {
    const o = origVariants[v.id] || {};
    const price = num(v.price);
    const input = { id: v.id };
    if (v.barcode !== o.barcode) input.barcode = v.barcode;
    if (price !== null) input.price = price.toFixed(2);
    input.compareAtPrice = num(v.compareAtPrice) ? num(v.compareAtPrice).toFixed(2) : null;
    const inv = {};
    if (v.sku !== o.sku) inv.sku = v.sku;
    if (num(v.cost) !== null && num(v.cost) !== num(o.cost)) inv.cost = num(v.cost);
    if (Object.keys(inv).length) input.inventoryItem = inv;
    bulk.push(input);

    const vm = collectMetafields(v.id, VARIANT_METAFIELDS, v.meta, o.meta);
    set.push(...vm.set);
    del.push(...vm.del);

    if (price !== null && price !== num(o.price)) {
      for (const [key, raw] of [["pricing", o.pricingRaw?.pricing], ["pricing_premium", o.pricingRaw?.premium], ["pricing_customer", o.pricingRaw?.customer]]) {
        set.push({ ownerId: v.id, namespace: NS, key, type: "json", value: JSON.stringify(patchPricing(raw, price)) });
      }
    }
    if (v.stock !== "" && v.stock !== null && String(v.stock) !== String(o.stock) && v.stockLocationId) {
      stock.push({ inventoryItemId: o.inventoryItemId, locationId: v.stockLocationId, quantity: parseInt(v.stock, 10) || 0 });
    }
  }

  if (bulk.length) {
    const d = await gql(
      admin,
      `mutation ($pid: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $pid, variants: $v) { userErrors { field message } } }`,
      { pid, v: bulk },
    );
    errors.push(...d.productVariantsBulkUpdate.userErrors.map((e) => `Variante: ${e.message}`));
  }
  await flushMetafields(admin, set, del, errors);
  await setStock(admin, stock, errors);
  await addImages(admin, pid, data.newImages || [], errors);
  return { errors };
}

export async function createProduct(admin, data, locationId) {
  const errors = [];
  const optionName = (data.optionName || "").trim() || "Title";
  const single = data.variants.length === 1 && !data.variants[0].option?.trim();

  const productMeta = PRODUCT_METAFIELDS.map((f) => {
    const raw = data.meta?.[f.key];
    if ((raw === "" || raw === undefined) && f.kind !== "bool" && f.kind !== "flag10") return null;
    return { namespace: NS, key: f.key, type: f.type, value: metaValue(f, raw) };
  }).filter(Boolean);

  const variants = data.variants.map((v) => {
    const price = num(v.price) ?? 0;
    const pricing = JSON.stringify({ base_price: price, base_price_google: price, base_price_idealo: price });
    const meta = VARIANT_METAFIELDS.map((f) => {
      let raw = v.meta?.[f.key];
      if (f.key === "omnia" && !raw) raw = v.sku;
      if ((f.key === "aussenlager" || f.key === "melde") && (raw === "" || raw === undefined)) raw = "0";
      if (raw === "" || raw === undefined) return null;
      return { namespace: NS, key: f.key, type: f.type, value: metaValue(f, raw) };
    }).filter(Boolean);
    meta.push(
      { namespace: NS, key: "pricing", type: "json", value: pricing },
      { namespace: NS, key: "pricing_premium", type: "json", value: pricing },
      { namespace: NS, key: "pricing_customer", type: "json", value: pricing },
      { namespace: NS, key: "google_export", type: "boolean", value: "true" },
    );
    const input = {
      optionValues: [{ optionName, name: single ? "Default Title" : v.option.trim() }],
      price: price.toFixed(2),
      barcode: v.barcode || null,
      inventoryItem: { sku: v.sku || null, tracked: true, ...(num(v.cost) !== null ? { cost: num(v.cost) } : {}) },
      metafields: meta,
    };
    if (num(v.compareAtPrice)) input.compareAtPrice = num(v.compareAtPrice).toFixed(2);
    if (locationId && v.stock !== "" && v.stock !== undefined) {
      input.inventoryQuantities = [{ locationId, name: "available", quantity: parseInt(v.stock, 10) || 0 }];
    }
    return input;
  });

  const d = await gql(
    admin,
    `mutation ($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) { product { id } userErrors { field message } }
    }`,
    {
      input: {
        title: data.title,
        vendor: data.vendor,
        productType: data.productType,
        status: data.status || "DRAFT",
        tags: String(data.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
        descriptionHtml: data.descriptionHtml,
        productOptions: [{ name: optionName, values: variants.map((v) => ({ name: v.optionValues[0].name })) }],
        variants,
        metafields: productMeta,
      },
    },
  );
  errors.push(...d.productSet.userErrors.map((e) => `${(e.field || []).join(".")}: ${e.message}`));
  const id = d.productSet.product?.id;
  if (id) await addImages(admin, id, data.newImages || [], errors);
  return { id, errors };
}
