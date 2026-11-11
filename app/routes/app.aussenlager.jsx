import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { useNavigation } from "@remix-run/react";

import {
  Page,
  Card,
  Button,
  InlineStack,
  InlineGrid,
  BlockStack,
  Box,
  Badge,
  Text,
  TextField,
  Spinner,
  Select,
  Pagination,
} from "@shopify/polaris";

/* =======================
   HELPERS
======================= */
function escapeShopifyQueryValue(input) {
  if (!input) return "";
  return String(input)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/"/g, '\\"');
}

function buildProductsQuery(raw) {
  const q = (raw || "").trim();
  if (!q) return null;

  const looksAdvanced =
    q.includes(":") ||
    /\b(AND|OR|NOT)\b/i.test(q) ||
    q.includes("(") ||
    q.includes(")");

  if (looksAdvanced) return q;

  const val = escapeShopifyQueryValue(q);
  const quoted = q.includes(" ") ? `"${val}"` : val;

  if (q.startsWith("gid://")) return `id:${val}`;
  if (/^\d+$/.test(q)) return `id:${val}`;
  if (q.startsWith("variant:")) {
    const id = q.split(":")[1];
    return `variant_id:${escapeShopifyQueryValue(id)}`;
  }
  return `title:${quoted} OR sku:${quoted}`;
}

const getStockStatus = (qty) => {
  const count = Number(qty) || 0;
  if (count <= 5) return { label: "Niedrig", tone: "critical" };
  if (count <= 20) return { label: "Mittel", tone: "warning" };
  return { label: "Gesund", tone: "success" };
};

/* =======================
   FILTER LOGIC
   Both filters now use Shopify inventoryQuantity (shopifyQty) as the
   stock value — NOT the hauptlager metafield.

   lowMain:        shopifyQty <= aussenlagerQty
   lowAfterReorder: shopifyQty - meldeQty <= aussenlagerQty
======================= */
const filterLowMainInventory = (shopifyQty, aussenlagerQty) =>
  shopifyQty <= aussenlagerQty;

const filterLowAfterReorder = (shopifyQty, meldeQty, aussenlagerQty) =>
  shopifyQty - meldeQty <= aussenlagerQty;

const edgeTotalAussenlager = (edge) =>
  (edge.node.variants?.edges || []).reduce(
    (sum, ve) => sum + (Number(ve.node?.aussenlager?.value) || 0),
    0,
  );

/* =======================
   LOADER
======================= */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url  = new URL(request.url);

  const qParam     = url.searchParams.get("q") || "";
  const page       = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
  const PAGE_SIZE  = [10, 20, 30, 50].includes(limitParam) ? limitParam : 50;
  // Standard: roter Filter (Hauptlager <= Außenlager)
  const filterParam = url.searchParams.get("filter") || "lowMain";
  const filterType  = ["none", "lowMain", "lowAfterReorder"].includes(filterParam)
    ? filterParam
    : "lowMain";
  const vendorParam = url.searchParams.get("vendor") || "";

  const query = buildProductsQuery(qParam);

  let allEdges    = [];
  let hasMore     = true;
  let afterCursor = null;

  while (hasMore) {
    const res = await admin.graphql(
      `query Products($first: Int!, $after: String, $query: String) {
        products(
          first: $first
          after: $after
          query: $query
          sortKey: TITLE
          reverse: false
        ) {
          edges {
            cursor
            node {
              id
              title
              vendor
              status
              totalInventory
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    inventoryQuantity

                    aussenlager: metafield(namespace: "custom", key: "aussenlager") { value }
                    hauptlager:  metafield(namespace: "custom", key: "hauptlager")  { value }
                    melde:       metafield(namespace: "custom", key: "melde")       { value }

                    inventoryItem {
                      id
                      inventoryLevels(first: 1) {
                        edges {
                          node {
                            quantities(names: ["available", "committed"]) {
                              name
                              quantity
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
              featuredImage { url }
            }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { variables: { first: 250, after: afterCursor, query } },
    );

    const data  = await res.json();
    const edges = data.data.products.edges;
    allEdges    = allEdges.concat(edges);

    hasMore     = data.data.products.pageInfo.hasNextPage;
    afterCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;

    if (allEdges.length >= 5000) break;
  }

  // ─────────────────────────────────────────────────────────────────────
  // AUTO-CORRECT HAUPTLAGER
  // For every variant where hauptlager metafield is set but <= 0,
  // fetch real on-hand (available + committed) and write it back.
  // ─────────────────────────────────────────────────────────────────────
  const correctionPromises = [];

  for (const edge of allEdges) {
    for (const variantEdge of edge.node.variants.edges) {
      const variant = variantEdge.node;

      const rawHauptlager = variant.hauptlager?.value;
      if (rawHauptlager === null || rawHauptlager === undefined) continue;

      const hauptlagerNum = Number(rawHauptlager);
      if (hauptlagerNum > 0) continue;

      const quantities =
        variant.inventoryItem?.inventoryLevels?.edges[0]?.node?.quantities || [];
      const available = quantities.find((q) => q.name === "available")?.quantity || 0;
      const committed = quantities.find((q) => q.name === "committed")?.quantity || 0;
      const onHand    = available + committed;

      if (onHand === hauptlagerNum) continue;

      correctionPromises.push(
        admin.graphql(
          `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              metafields: [{
                ownerId:   variant.id,
                namespace: "custom",
                key:       "hauptlager",
                value:     String(onHand),
                type:      "number_integer",
              }],
            },
          },
        ).then(async (mutRes) => {
          const mutData = await mutRes.json();
          const errors  = mutData.data?.metafieldsSet?.userErrors;
          if (!errors?.length) {
            variant.hauptlager = { value: String(onHand) };
          }
        }),
      );
    }
  }

  if (correctionPromises.length > 0) {
    await Promise.all(correctionPromises);
  }

  // ── Attach DB warehouse / reorder data ──────────────────────────────
  const productIds = allEdges.map((e) => e.node.id);

  const warehouses = await db.externalWarehouse.findMany({
    where: { productId: { in: productIds } },
  });

  const warehouseMap = Object.fromEntries(warehouses.map((w) => [w.productId, w.warehouse]));
  const reorderMap   = Object.fromEntries(warehouses.map((w) => [w.productId, w.reorder]));

  const allProducts = allEdges.map((edge) => ({
    ...edge,
    node: {
      ...edge.node,
      externalWarehouse: warehouseMap[edge.node.id] || "",
      reorderLevel:      reorderMap[edge.node.id]   || "",
    },
  }));

  // ── Eine Zeile je Variante mit Außenlager-Wert ──────────────────────
  // Filter und Seiten laufen über alle Zeilen, nicht nur die aktuelle Seite.
  const searchLower = qParam && !qParam.includes(":") ? qParam.toLowerCase() : "";

  const allRows = [];
  for (const edge of allProducts.filter((e) => edgeTotalAussenlager(e) > 0)) {
    const node = edge.node;
    let variants = node.variants.edges.map((e) => e.node);

    if (searchLower) {
      const matched = variants.filter(
        (v) =>
          v.sku?.toLowerCase().includes(searchLower) ||
          v.id?.toLowerCase().includes(searchLower),
      );
      if (matched.length > 0) variants = matched;
    }

    for (const variant of variants) {
      if ((Number(variant.aussenlager?.value) || 0) <= 0) continue;
      allRows.push({
        product: {
          id: node.id,
          title: node.title,
          vendor: node.vendor,
          image: node.featuredImage?.url || null,
          hasRealVariants: node.variants.edges.length > 1 || variant.title !== "Default Title",
        },
        variant,
      });
    }
  }

  // Sortierung wie im Altshop: Hersteller, Artikel, Hauptlager
  allRows.sort(
    (a, b) =>
      (a.product.vendor || "").localeCompare(b.product.vendor || "", "de") ||
      a.product.title.localeCompare(b.product.title, "de") ||
      (Number(a.variant.inventoryQuantity) || 0) - (Number(b.variant.inventoryQuantity) || 0),
  );

  const vendors = [...new Set(allProducts.map((e) => e.node.vendor).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "de"));

  const vendorRows = vendorParam
    ? allRows.filter(({ product }) => product.vendor === vendorParam)
    : allRows;
  const unfilteredCount = vendorRows.length;
  const redCount = vendorRows.filter(({ variant }) => filterLowMainInventory(Number(variant.inventoryQuantity) || 0, Number(variant.aussenlager?.value) || 0)).length;
  const orangeCount = vendorRows.filter(({ variant }) => filterLowAfterReorder(Number(variant.inventoryQuantity) || 0, Number(variant.melde?.value) || 0, Number(variant.aussenlager?.value) || 0)).length;
  const rows = vendorRows.filter(({ variant }) => {
    const shopifyQty    = Number(variant.inventoryQuantity) || 0;
    const aussenlagerQty = Number(variant.aussenlager?.value) || 0;
    const meldeQty       = Number(variant.melde?.value) || 0;
    if (filterType === "lowMain") return filterLowMainInventory(shopifyQty, aussenlagerQty);
    if (filterType === "lowAfterReorder")
      return filterLowAfterReorder(shopifyQty, meldeQty, aussenlagerQty);
    return true;
  });

  const totalCount = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const startIdx   = (safePage - 1) * PAGE_SIZE;
  const pageRows   = rows.slice(startIdx, startIdx + PAGE_SIZE);

  return json({
    rows: pageRows,
    totalCount,
    unfilteredCount,
    redCount,
    orangeCount,
    totalPages,
    currentPage: safePage,
    q: qParam,
    limit: PAGE_SIZE,
    filterType,
    vendor: vendorParam,
    vendors,
  });
};

/* =======================
   ACTION
======================= */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const type = form.get("type");

  if (type === "reorder-level") {
    const { session } = await authenticate.admin(request);
    const { shop } = session;
    const productId = form.get("productId");
    const reorder   = form.get("reorder");
    await db.externalWarehouse.upsert({
      where:  { shop_productId: { shop, productId } },
      update: { reorder: String(reorder || "0") },
      create: { shop, productId, reorder: String(reorder || "0"), warehouse: "0" },
    });
    return json({ success: true });
  }

  if (type === "delete-variant") {
    await admin.graphql(
      `mutation productVariantDelete($id: ID!) {
        productVariantDelete(id: $id) { deletedProductVariantId userErrors { field message } }
      }`,
      { variables: { id: form.get("variantId") } },
    );
    return json({ success: true });
  }

  if (type === "delete") {
    await admin.graphql(
      `mutation productDelete($id: ID!) {
        productDelete(input: { id: $id }) { deletedProductId }
      }`,
      { variables: { id: form.get("productId") } },
    );
    return json({ success: true });
  }

  if (type === "variant-price") {
    const productId = form.get("productId");
    const variantId = form.get("variantId");
    const price     = form.get("price");
    const result = await admin.graphql(
      `mutation variantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }`,
      { variables: { productId, variants: [{ id: variantId, price }] } },
    );
    const d = await result.json();
    const errors = d.data?.productVariantsBulkUpdate?.userErrors;
    if (errors?.length) return json({ success: false, errors });
    return json({ success: true });
  }

  if (type === "variant-inventory") {
    const inventoryItemId = form.get("inventoryItemId");
    const quantity        = parseInt(form.get("quantity"), 10);
    const locRes = await admin.graphql(
      `query getLocation($id: ID!) {
        inventoryItem(id: $id) {
          inventoryLevels(first: 1) { edges { node { location { id } } } }
        }
      }`,
      { variables: { id: inventoryItemId } },
    );
    const locData    = await locRes.json();
    const locationId = locData.data?.inventoryItem?.inventoryLevels?.edges[0]?.node?.location?.id;
    if (!locationId) return json({ success: false, error: "Location not found" });

    const invRes = await admin.graphql(
      `mutation inventorySet($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { field message } }
      }`,
      {
        variables: {
          input: {
            name: "available",
            reason: "correction",
            ignoreCompareQuantity: true,
            quantities: [{ inventoryItemId, locationId, quantity }],
          },
        },
      },
    );
    const invData = await invRes.json();
    const errors  = invData.data?.inventorySetQuantities?.userErrors;
    if (errors?.length) return json({ success: false, errors });
    return json({ success: true });
  }

  // ─────────────────────────────────────────────────────────────────────
  // TRANSFER TO AUSSENLAGER
  // ─────────────────────────────────────────────────────────────────────
  if (type === "transfer-to-aussenlager") {
    const variantId        = form.get("variantId");
    const inventoryItemId  = form.get("inventoryItemId");
    const newAussenlager   = parseInt(form.get("newAussenlager"),   10) || 0;
    const shopifyInventory = parseInt(form.get("shopifyInventory"), 10) || 0;
    let   newHauptlager    = shopifyInventory - newAussenlager;

    if (newHauptlager <= 0 && inventoryItemId) {
      const onHandRes = await admin.graphql(
        `query getOnHand($id: ID!) {
          inventoryItem(id: $id) {
            inventoryLevels(first: 1) {
              edges {
                node {
                  quantities(names: ["available", "committed"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }`,
        { variables: { id: inventoryItemId } },
      );
      const onHandData = await onHandRes.json();
      const quantities =
        onHandData.data?.inventoryItem?.inventoryLevels?.edges[0]?.node?.quantities || [];
      const available = quantities.find((q) => q.name === "available")?.quantity || 0;
      const committed = quantities.find((q) => q.name === "committed")?.quantity || 0;
      newHauptlager   = available + committed;
    }

    const result = await admin.graphql(
      `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key value }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: variantId, namespace: "custom", key: "aussenlager",
              value: String(newAussenlager), type: "number_integer",
            },
            {
              ownerId: variantId, namespace: "custom", key: "hauptlager",
              value: String(newHauptlager), type: "number_integer",
            },
          ],
        },
      },
    );
    const d = await result.json();
    const errors = d.data?.metafieldsSet?.userErrors;
    if (errors?.length) return json({ success: false, errors });
    return json({ success: true });
  }

  if (type === "update-melde") {
    const variantId = form.get("variantId");
    const melde     = form.get("melde");
    const result = await admin.graphql(
      `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key value }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: variantId, namespace: "custom", key: "melde",
              value: String(melde || "0"), type: "number_integer",
            },
          ],
        },
      },
    );
    const d = await result.json();
    const errors = d.data?.metafieldsSet?.userErrors;
    if (errors?.length) return json({ success: false, errors });
    return json({ success: true });
  }

  if (type === "sync-all-inventory") {
    const productId       = form.get("productId");
    const inventoryItemId = form.get("inventoryItemId");
    const newShopifyQty   = parseInt(form.get("newShopifyQty"), 10);
    const newExternalQty  = parseInt(form.get("newExternalQty"), 10);

    const locRes = await admin.graphql(
      `query getLocation($id: ID!) {
        inventoryItem(id: $id) {
          inventoryLevels(first: 1) { edges { node { location { id } } } }
        }
      }`,
      { variables: { id: inventoryItemId } },
    );
    const locData    = await locRes.json();
    const locationId = locData.data?.inventoryItem?.inventoryLevels?.edges[0]?.node?.location?.id;
    if (!locationId) return json({ success: false, error: "Location not found" });

    const invRes = await admin.graphql(
      `mutation inventorySet($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { field message } }
      }`,
      {
        variables: {
          input: {
            name: "available",
            reason: "correction",
            ignoreCompareQuantity: true,
            quantities: [{ inventoryItemId, locationId, quantity: newShopifyQty }],
          },
        },
      },
    );
    const invData = await invRes.json();
    const errors  = invData.data?.inventorySetQuantities?.userErrors;
    if (errors?.length) return json({ success: false, errors });

    const { session } = await authenticate.admin(request);
    const { shop }    = session;
    await db.externalWarehouse.upsert({
      where:  { shop_productId: { shop, productId } },
      update: { warehouse: String(newExternalQty) },
      create: { shop, productId, warehouse: String(newExternalQty) },
    });
    return json({ success: true });
  }

  if (type === "external-warehouse") {
    const { session } = await authenticate.admin(request);
    const { shop }    = session;
    const productId   = form.get("productId");
    const warehouse   = form.get("warehouse");
    await db.externalWarehouse.upsert({
      where:  { shop_productId: { shop, productId } },
      update: { warehouse },
      create: { shop, productId, warehouse },
    });
    return json({ success: true });
  }

  return json({ success: false, error: "Unknown action type" });
};

/* =======================
   DARSTELLUNG
======================= */
const th = { textAlign: "left", padding: "10px 12px", fontSize: 12, fontWeight: 600, color: "var(--p-color-text-secondary)", borderBottom: "1px solid var(--p-color-border)", background: "var(--p-color-bg-surface-secondary)", whiteSpace: "nowrap" };
const td = { padding: "10px 12px", borderBottom: "1px solid var(--p-color-border-secondary)", verticalAlign: "middle" };

/* Klickbarer Wert, der zum Eingabefeld wird */
function InlineEditable({ value, onSave, type = "text", editing, onStartEdit, onCancelEdit, placeholder = "–", strong, tone }) {
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value, editing]);
  const handleSave = () => {
    onCancelEdit();
    if (String(val) !== String(value)) onSave(val);
  };
  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        value={val ?? ""}
        onChange={(e) => setVal(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") { setVal(value); onCancelEdit(); } }}
        style={{ width: 84, padding: "6px 8px", borderRadius: 8, border: "2px solid var(--p-color-border-focus)", font: "inherit", textAlign: "right" }}
      />
    );
  }
  const empty = value === "" || value === null || value === undefined;
  return (
    <button
      type="button"
      onClick={onStartEdit}
      title="Zum Bearbeiten klicken"
      style={{
        minWidth: 84, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--p-color-border)", background: "var(--p-color-bg-surface)",
        cursor: "text", textAlign: "right", font: "inherit", fontWeight: strong ? 650 : 450,
        color: tone === "critical" ? "var(--p-color-text-critical)" : empty ? "var(--p-color-text-secondary)" : "var(--p-color-text)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--p-color-border-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--p-color-border)")}
    >
      {empty ? placeholder : value}
    </button>
  );
}

function Stat({ label, value, tone, active, onClick, hint }) {
  return (
    <div onClick={onClick} style={{ cursor: "pointer", borderRadius: 12, outline: active ? "2px solid var(--p-color-border-emphasis)" : "none" }}>
      <Card>
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
          <Text as="p" variant="heading2xl" tone={tone}>{value}</Text>
          {hint && <Text as="p" variant="bodySm" tone="subdued">{hint}</Text>}
        </BlockStack>
      </Card>
    </div>
  );
}

/* =======================
   SEITE – eine Zeile je Variante mit Außenlager.
   „Hauptlager“ = Shopify-Bestand der Variante.
======================= */
export default function Index() {
  const { rows, totalCount, unfilteredCount, redCount, orangeCount, totalPages, currentPage, q, limit, filterType, vendor, vendors } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const [editingCell, setEditingCell] = useState(null);
  const [tempWarehouse2, setTempWarehouse2] = useState({});
  const [search, setSearch] = useState(q || "");
  useEffect(() => setSearch(q || ""), [q]);

  const buildUrl = ({ q: qVal, page: pg, limit: lim, filter: flt, vendor: vnd }) => {
    const sp = new URLSearchParams();
    if (qVal) sp.set("q", qVal);
    sp.set("page", String(pg ?? currentPage));
    sp.set("limit", String(lim ?? limit));
    sp.set("filter", String(flt ?? filterType));
    const vndVal = vnd ?? vendor;
    if (vndVal) sp.set("vendor", vndVal);
    return `?${sp.toString()}`;
  };

  const isEditing = (id, field) => editingCell?.id === id && editingCell?.field === field;
  const startEdit = (id, field) => setEditingCell({ id, field });
  const cancelEdit = () => setEditingCell(null);

  const saveInventoryByInventoryItem = (inventoryItemId, quantity) => submit({ type: "variant-inventory", inventoryItemId, quantity }, { method: "post" });
  const transferToAussenlager = (variantId, inventoryItemId, shopifyInventory, inputQty) => {
    const n = Number(inputQty);
    if (inputQty === "" || inputQty === null || inputQty === undefined || isNaN(n) || n < 0) return;
    submit({ type: "transfer-to-aussenlager", variantId, inventoryItemId, newAussenlager: String(n), shopifyInventory: String(Number(shopifyInventory) || 0) }, { method: "post" });
    setTempWarehouse2((prev) => ({ ...prev, [variantId]: "" }));
  };
  const saveMelde = (variantId, melde) => submit({ type: "update-melde", variantId, melde: String(melde || "0") }, { method: "post" });

  const go = (patch) => navigate(buildUrl({ q: q || "", page: 1, ...patch }));

  return (
    <Page
      title="Außenlager"
      subtitle="Hauptlager, Außenlager und Meldebestand je Geschmack – Werte direkt in der Tabelle anklicken und ändern"
      titleMetadata={busy ? <Spinner size="small" /> : null}
    >
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
          <Stat label="Geschmäcker mit Außenlager" value={unfilteredCount} active={filterType === "none"} onClick={() => go({ filter: "none" })} hint="Alle anzeigen" />
          <Stat label="Hauptlager ≤ Außenlager" value={redCount} tone={redCount ? "critical" : undefined} active={filterType === "lowMain"} onClick={() => go({ filter: "lowMain" })} hint="Umlagern ins Hauptlager" />
          <Stat label="Hauptlager − Melde ≤ Außenlager" value={orangeCount} tone={orangeCount ? "caution" : undefined} active={filterType === "lowAfterReorder"} onClick={() => go({ filter: "lowAfterReorder" })} hint="Bald umlagern" />
        </InlineGrid>

        <Card padding="0">
          <Box padding="400">
            <InlineStack gap="300" blockAlign="end" wrap>
              <div style={{ flex: 1, minWidth: 260 }}>
                <TextField
                  label="Suche"
                  labelHidden
                  placeholder="Produkt, Hersteller oder sku:12345"
                  value={search}
                  onChange={setSearch}
                  onKeyDown={(e) => { if (e.key === "Enter") go({ q: search.trim() }); }}
                  clearButton
                  onClearButtonClick={() => go({ q: "" })}
                  autoComplete="off"
                  connectedRight={<Button onClick={() => go({ q: search.trim() })}>Suchen</Button>}
                />
              </div>
              <div style={{ minWidth: 200 }}>
                <Select label="Hersteller" labelHidden options={[{ label: "Alle Hersteller", value: "" }, ...vendors.map((v) => ({ label: v, value: v }))]} value={vendor} onChange={(val) => go({ vendor: val })} />
              </div>
              <div style={{ minWidth: 120 }}>
                <Select label="Pro Seite" labelHidden options={["10", "20", "30", "50"].map((v) => ({ label: `${v} pro Seite`, value: v }))} value={String(limit)} onChange={(val) => go({ limit: val })} />
              </div>
            </InlineStack>
          </Box>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={th}>Artikel</th>
                  <th style={th}>Hersteller</th>
                  <th style={{ ...th, textAlign: "right" }}>Hauptlager</th>
                  <th style={{ ...th, textAlign: "right" }}>Außenlager</th>
                  <th style={{ ...th, textAlign: "right" }}>Außenlager neu</th>
                  <th style={{ ...th, textAlign: "right" }}>Meldebestand</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, textAlign: "right" }}>Preis</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan="8" style={{ ...td, textAlign: "center", padding: 40 }}><Text tone="subdued" as="p">Keine Geschmäcker für diese Auswahl.</Text></td></tr>
                ) : (
                  rows.map(({ product, variant: vr }) => {
                    const main = Number(vr.inventoryQuantity) || 0;
                    const ext = Number(vr.aussenlager?.value) || 0;
                    const melde = Number(vr.melde?.value) || 0;
                    const red = main <= ext;
                    const orange = !red && main - melde <= ext;
                    return (
                      <tr key={vr.id} style={{ background: red ? "var(--p-color-bg-surface-critical)" : orange ? "var(--p-color-bg-surface-caution)" : "transparent" }}>
                        <td style={{ ...td, minWidth: 260 }}>
                          <InlineStack gap="300" blockAlign="center" wrap={false}>
                            <div style={{ width: 40, height: 40, borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-surface-secondary)", flexShrink: 0, border: "1px solid var(--p-color-border-secondary)" }}>
                              {product.image && <img src={`${product.image}${product.image.includes("?") ? "&" : "?"}width=80`} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
                            </div>
                            <BlockStack gap="050">
                              <Text as="span" fontWeight="semibold">{product.title}</Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {product.hasRealVariants ? `${vr.title} · ` : ""}{vr.sku ? `SKU ${vr.sku}` : ""}
                              </Text>
                            </BlockStack>
                          </InlineStack>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}><Text as="span" tone="subdued">{product.vendor || "–"}</Text></td>
                        <td style={{ ...td, textAlign: "right" }}>
                          <InlineEditable value={String(vr.inventoryQuantity ?? "")} editing={isEditing(vr.id, "inventory")} onStartEdit={() => startEdit(vr.id, "inventory")} onCancelEdit={cancelEdit} onSave={(v) => saveInventoryByInventoryItem(vr.inventoryItem?.id, v)} type="number" />
                        </td>
                        <td style={{ ...td, textAlign: "right" }}>
                          <Text as="span" tone="critical" fontWeight="bold">{vr.aussenlager?.value ?? "–"}</Text>
                        </td>
                        <td style={{ ...td, textAlign: "right" }}>
                          <InlineEditable value={tempWarehouse2[vr.id] ?? ""} placeholder="neu …" editing={isEditing(vr.id, "warehouse2")} onStartEdit={() => startEdit(vr.id, "warehouse2")} onCancelEdit={cancelEdit} onSave={(v) => transferToAussenlager(vr.id, vr.inventoryItem?.id, main, v)} type="number" />
                        </td>
                        <td style={{ ...td, textAlign: "right" }}>
                          <InlineEditable value={vr.melde?.value ?? ""} editing={isEditing(vr.id, "melde")} onStartEdit={() => startEdit(vr.id, "melde")} onCancelEdit={cancelEdit} onSave={(v) => saveMelde(vr.id, v)} type="number" />
                        </td>
                        <td style={td}>
                          {red ? <Badge tone="critical">Umlagern</Badge> : orange ? <Badge tone="warning">Bald umlagern</Badge> : <Badge tone="success">OK</Badge>}
                        </td>
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                          <Text as="span">{vr.price ? `${Number(vr.price).toFixed(2).replace(".", ",")} €` : "–"}</Text>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <Box padding="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                {filterType === "none" ? `${totalCount} Geschmäcker` : `${totalCount} von ${unfilteredCount} Geschmäckern`}{q ? ` · Suche „${q}“` : ""} · sortiert nach Hersteller, Artikel, Hauptlager
              </Text>
              <Pagination
                hasPrevious={currentPage > 1}
                hasNext={currentPage < totalPages}
                label={`Seite ${currentPage} von ${totalPages}`}
                onPrevious={() => { cancelEdit(); navigate(buildUrl({ q: q || "", page: currentPage - 1 })); }}
                onNext={() => { cancelEdit(); navigate(buildUrl({ q: q || "", page: currentPage + 1 })); }}
              />
            </InlineStack>
          </Box>
        </Card>
      </BlockStack>
    </Page>
  );
}
