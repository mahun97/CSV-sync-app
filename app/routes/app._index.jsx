import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { useNavigation } from "@remix-run/react";

import {
  Page,
  Card,
  Button,
  InlineStack,
  Badge,
  Text,
  TextField,
  Spinner,
  Select,
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
  const limitParam = parseInt(url.searchParams.get("limit") || "10", 10);
  const PAGE_SIZE  = [10, 20, 30, 50].includes(limitParam) ? limitParam : 10;

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

  const withAussenlager = allProducts.filter((edge) => edgeTotalAussenlager(edge) > 0);

  const totalCount   = withAussenlager.length;
  const totalPages   = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage     = Math.min(page, totalPages);
  const startIdx     = (safePage - 1) * PAGE_SIZE;
  const pageProducts = withAussenlager.slice(startIdx, startIdx + PAGE_SIZE);

  return json({
    products: pageProducts,
    totalCount,
    totalPages,
    currentPage: safePage,
    q: qParam,
    limit: PAGE_SIZE,
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
   STYLES
======================= */
const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };
const thStyle = {
  textAlign: "left", padding: "10px 12px",
  borderBottom: "2px solid #e1e3e5", color: "#6d7175", fontWeight: 600, background: "#f6f6f7",
};
const tdStyle = { padding: "10px 12px", borderBottom: "1px solid #e1e3e5", verticalAlign: "middle" };

/* =======================
   INLINE EDIT CELL
======================= */
function InlineEditable({ value, onSave, type = "text", editing, onStartEdit, onCancelEdit }) {
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value, editing]);

  const handleSave = () => {
    onCancelEdit();
    if (String(val) !== String(value)) onSave(val);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") { setVal(value); onCancelEdit(); }
  };

  if (editing) {
    return (
      <div style={{ minWidth: 110 }}>
        <TextField
          value={val} onChange={setVal} onBlur={handleSave}
          autoFocus type={type} onKeyDown={handleKeyDown}
        />
      </div>
    );
  }

  return (
    <div
      onClick={onStartEdit}
      title="Click to edit"
      style={{
        cursor: "pointer", padding: "4px 6px", borderRadius: 6,
        border: "1px solid #e1e3e5", transition: "all 0.15s",
        display: "inline-block", minWidth: 60, background: "#f6f6f7",
        height: "30px", textAlign: "center",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.border = "1px solid #bbb"; }}
      onMouseLeave={(e) => { e.currentTarget.style.border = "1px solid #e1e3e5"; }}
    >
      {value ?? "—"}
    </div>
  );
}

/* =======================
   MAIN COMPONENT
======================= */
export default function Index() {
  const { products, totalCount, totalPages, currentPage, q, limit } = useLoaderData();
  const navigate   = useNavigate();
  const submit     = useSubmit();
  const navigation = useNavigation();

  const isPageLoading =
    navigation.state === "loading" || navigation.state === "submitting";

  const [openVariantProductId, setOpenVariantProductId] = useState(null);
  const [editingCell,    setEditingCell]    = useState(null);
  const [tempWarehouse2, setTempWarehouse2] = useState({});
  const [filterType,     setFilterType]     = useState("none");
  const [search,         setSearch]         = useState(q || "");

  useEffect(() => setSearch(q || ""), [q]);

  const buildUrl = ({ q: qVal, page: pg, limit: lim }) => {
    const sp = new URLSearchParams();
    if (qVal) sp.set("q", qVal);
    sp.set("page",  String(pg  ?? currentPage));
    sp.set("limit", String(lim ?? limit));
    return `?${sp.toString()}`;
  };

  const isEditing  = (scope, id, field) =>
    editingCell?.scope === scope && editingCell?.id === id && editingCell?.field === field;
  const startEdit  = (scope, id, field) => setEditingCell({ scope, id, field });
  const cancelEdit = () => setEditingCell(null);

  const saveInventoryByInventoryItem = (inventoryItemId, quantity) =>
    submit({ type: "variant-inventory", inventoryItemId, quantity }, { method: "post" });

  const transferToAussenlager = (variantId, inventoryItemId, shopifyInventory, productId, inputQty) => {
    const newAussenlager = Number(inputQty);
    // Allow 0 (to reset Außenlager); only block empty/non-numeric input
    if (inputQty === "" || inputQty === null || inputQty === undefined || isNaN(newAussenlager)) return;
    if (newAussenlager < 0) return;
    submit(
      {
        type:             "transfer-to-aussenlager",
        variantId,
        inventoryItemId,
        newAussenlager:   String(newAussenlager),
        shopifyInventory: String(Number(shopifyInventory) || 0),
      },
      { method: "post" },
    );
    setTempWarehouse2((prev) => ({ ...prev, [productId]: "" }));
  };

  const saveMelde = (variantId, melde) =>
    submit({ type: "update-melde", variantId, melde: String(melde || "0") }, { method: "post" });

  const getRowInfo = (node) => {
    let variants = node.variants.edges.map((e) => e.node);

    if (q && !q.includes(":")) {
      const searchLower = q.toLowerCase();
      const filtered = variants.filter(
        (v) =>
          v.sku?.toLowerCase().includes(searchLower) ||
          v.id?.toLowerCase().includes(searchLower),
      );
      if (filtered.length > 0) variants = filtered;
    }

    variants = [...variants].sort(
      (a, b) => (Number(b.aussenlager?.value) || 0) - (Number(a.aussenlager?.value) || 0),
    );

    const firstVariant    = variants[0];
    const hasRealVariants = variants.length > 1 || firstVariant?.title !== "Default Title";

    // qty = total Shopify inventoryQuantity (shown as "Hauptlager" in the UI)
    const qty = hasRealVariants
      ? variants.reduce((sum, v) => sum + Number(v.inventoryQuantity || 0), 0)
      : Number(firstVariant?.inventoryQuantity ?? node.totalInventory ?? 0);

    const totalAussenlager = variants.reduce((sum, v) => sum + (Number(v.aussenlager?.value) || 0), 0);

    return { variants, firstVariant, hasRealVariants, qty, totalAussenlager };
  };

  // ─────────────────────────────────────────────────────────────────────
  // FILTER — uses Shopify inventoryQuantity (qty) as the stock value
  //
  // lowMain:         shopifyQty <= aussenlagerQty
  // lowAfterReorder: shopifyQty - meldeQty <= aussenlagerQty
  // ─────────────────────────────────────────────────────────────────────
  const filteredProducts = useMemo(() => {
    return products.filter(({ node }) => {
      const { variants, firstVariant, hasRealVariants, qty, totalAussenlager } =
        getRowInfo(node);

      if (totalAussenlager <= 0) return false;
      if (filterType === "none") return true;

      if (!hasRealVariants) {
        // Single-variant: use inventoryQuantity directly as shopify stock
        const shopifyQty   = Number(firstVariant?.inventoryQuantity) || 0;
        const aussenlagerQty = Number(firstVariant?.aussenlager?.value) || 0;
        const meldeQty       = Number(firstVariant?.melde?.value)       || 0;

        if (filterType === "lowMain")
          return filterLowMainInventory(shopifyQty, aussenlagerQty);
        if (filterType === "lowAfterReorder")
          return filterLowAfterReorder(shopifyQty, meldeQty, aussenlagerQty);
      } else {
        // Multi-variant: sum of all variants' inventoryQuantity as shopify stock
        const totalShopifyQty = variants.reduce(
          (sum, v) => sum + (Number(v.inventoryQuantity) || 0), 0,
        );
        const totalMelde = variants.reduce(
          (sum, v) => sum + (Number(v.melde?.value) || 0), 0,
        );

        if (filterType === "lowMain")
          return filterLowMainInventory(totalShopifyQty, totalAussenlager);
        if (filterType === "lowAfterReorder")
          return filterLowAfterReorder(totalShopifyQty, totalMelde, totalAussenlager);
      }
      return true;
    });
  }, [products, filterType]);

  return (
    <>
      {isPageLoading && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
          background: "rgba(0,0,0,0.4)", display: "flex",
          alignItems: "center", justifyContent: "center", zIndex: 9999,
        }}>
          <div style={{
            background: "#fff", padding: "40px 60px", borderRadius: 16,
            boxShadow: "0 10px 30px rgba(0,0,0,0.2)", textAlign: "center",
          }}>
            <Spinner size="large" />
            <div style={{ marginTop: 16, fontSize: 16, fontWeight: 500 }}>Bitte warten...</div>
          </div>
        </div>
      )}

      <Page title="Lagerverwalter">
        <Card>
          {/* ── SEARCH & FILTER ── */}
          <div style={{ padding: 16, borderBottom: "1px solid #e1e3e5" }}>
            <InlineStack gap="300" align="space-between">
              <div style={{ flex: 1, minWidth: 280 }}>
                <TextField
                  label="Search" labelHidden
                  placeholder='Suchen... (z.B. "Nike" oder "sku:ABC123")'
                  value={search}
                  onChange={setSearch}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      navigate(buildUrl({ q: search.trim() || "", page: 1 }));
                  }}
                  clearButton
                  onClearButtonClick={() => navigate(buildUrl({ q: "", page: 1 }))}
                />
              </div>
              <InlineStack gap="200">
                <Button variant="primary" onClick={() => navigate(buildUrl({ q: search.trim() || "", page: 1 }))}>
                  Suchen
                </Button>
                <Button disabled={!q} onClick={() => navigate(buildUrl({ q: "", page: 1 }))}>
                  Zurücksetzen
                </Button>
              </InlineStack>
            </InlineStack>

            <div style={{ marginTop: 10 }}>
              <Text as="p" variant="bodySm" tone="subdued">
                Zeigt nur Produkte mit Außenlager-Wert · Sortiert nach Titel
                {q ? <> | Suchbegriff: <strong>{q}</strong></> : null}
              </Text>
            </div>

            <div style={{
              marginTop: 16, display: "flex", gap: 16,
              justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap",
            }}>
              <InlineStack gap="400" blockAlign="end">
                <Select
                  label="Filter"
                  options={[
                    { label: "Kein Filter",                                        value: "none" },
                    { label: "🔴 Nur Hauptlager <= Außenlager",                    value: "lowMain" },
                    { label: "🟠 Hauptlager minus Melde <= Außenlager",            value: "lowAfterReorder" },
                  ]}
                  value={filterType}
                  onChange={setFilterType}
                />
                <Select
                  label="Produkte pro Seite"
                  options={[
                    { label: "10", value: "10" },
                    { label: "20", value: "20" },
                    { label: "30", value: "30" },
                    { label: "50", value: "50" },
                  ]}
                  value={String(limit)}
                  onChange={(val) => {
                    setFilterType("none");
                    navigate(buildUrl({ q: q || "", page: 1, limit: val }));
                  }}
                />
              </InlineStack>
              <div style={{ textAlign: "right" }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  {filterType === "none"
                    ? `${totalCount} Produkte mit Außenlager`
                    : `${filteredProducts.length} von ${totalCount} Produkten (gefiltert)`}
                  {" "}· Seite {currentPage} / {totalPages}
                </Text>
              </div>
            </div>
          </div>

          {/* ── TABLE ──
              Columns (7 total):
              Artikel | Hersteller | Hauptlager | Außenlager | Außenlager Neu | Meldebestand | Aktion
              "Hauptlager" here = Shopify inventoryQuantity
          */}
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Artikel</th>
                  <th style={thStyle}>Hersteller</th>
                  <th style={thStyle}>Hauptlager</th>
                  <th style={thStyle}>Außenlager</th>
                  <th style={thStyle}>Außenlager Neu</th>
                  <th style={thStyle}>Meldebestand (in VKE)</th>
                  <th style={thStyle}>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan="7" style={{ ...tdStyle, textAlign: "center" }}>
                      <Text tone="subdued">Keine Produkte entsprechen diesem Filter</Text>
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map(({ node }) => {
                    const {
                      variants, firstVariant, hasRealVariants,
                      qty, totalAussenlager,
                    } = getRowInfo(node);

                    const isOpen = openVariantProductId === node.id;

                    const aussenlagerValue = hasRealVariants
                      ? totalAussenlager > 0 ? String(totalAussenlager) : "—"
                      : firstVariant?.aussenlager?.value ?? "—";

                    const meldeValue = !hasRealVariants
                      ? firstVariant?.melde?.value ?? "—"
                      : "—";

                    // isRedZone: shopify stock <= melde threshold (consistent with filter logic)
                    const meldeQty   = Number(firstVariant?.melde?.value) || 0;
                    const shopifyQty = Number(firstVariant?.inventoryQuantity) || 0;
                    const isRedZone  =
                      !hasRealVariants && meldeQty > 0 && shopifyQty <= meldeQty;

                    return (
                      <Fragment key={node.id}>
                        <tr style={{ background: isRedZone ? "rgba(255,0,0,0.08)" : "transparent" }}>
                          <td style={{ ...tdStyle, minWidth: 220 }}>
                            <Text as="p" variant="bodyMd">{node.title}</Text>
                            {firstVariant?.sku && (
                              <Text as="p" variant="bodySm" tone="subdued">
                                SKU: {firstVariant.sku}
                              </Text>
                            )}
                          </td>
                          <td style={{ ...tdStyle, minWidth: 180 }}>
                            <Text as="p">{node.vendor || "—"}</Text>
                          </td>
                          {/* Hauptlager = Shopify inventoryQuantity */}
                          <td style={{ ...tdStyle, minWidth: 110, textAlign: "center" }}>
                            <Text as="p">{String(qty)}</Text>
                          </td>
                          <td style={{ ...tdStyle, minWidth: 110 }}>
                            <Text as="p">{aussenlagerValue}</Text>
                          </td>
                          <td style={{ ...tdStyle, minWidth: 155 }}>
                            {!hasRealVariants ? (
                              <InlineEditable
                                value={tempWarehouse2[node.id] ?? ""}
                                editing={isEditing("product", node.id, "warehouse2")}
                                onStartEdit={() => startEdit("product", node.id, "warehouse2")}
                                onCancelEdit={cancelEdit}
                                onSave={(v) =>
                                  transferToAussenlager(
                                    firstVariant?.id,
                                    firstVariant?.inventoryItem?.id,
                                    qty,
                                    node.id,
                                    v,
                                  )
                                }
                                type="number"
                              />
                            ) : (
                              <Text as="p" tone="subdued">—</Text>
                            )}
                          </td>
                          <td style={{ ...tdStyle, minWidth: 155 }}>
                            {!hasRealVariants ? (
                              <InlineStack gap="200" blockAlign="center">
                                <InlineEditable
                                  value={meldeValue === "—" ? "" : meldeValue}
                                  editing={isEditing("product", node.id, "melde")}
                                  onStartEdit={() => startEdit("product", node.id, "melde")}
                                  onCancelEdit={cancelEdit}
                                  onSave={(v) => saveMelde(firstVariant?.id, v)}
                                  type="number"
                                />
                                {isRedZone && <Badge tone="critical">🔴 Rot</Badge>}
                              </InlineStack>
                            ) : (
                              <Text tone="subdued">—</Text>
                            )}
                          </td>
                          <td style={{ ...tdStyle, minWidth: 170 }}>
                            <InlineStack gap="200">
                              {hasRealVariants && (
                                <Button
                                  size="slim"
                                  onClick={() => {
                                    cancelEdit();
                                    setOpenVariantProductId(isOpen ? null : node.id);
                                  }}
                                >
                                  {isOpen ? "Varianten ausblenden" : "Varianten"}
                                </Button>
                              )}
                            </InlineStack>
                          </td>
                        </tr>

                        {/* ── VARIANT SUB-TABLE ──
                            Columns (5 total):
                            Artikel | Preis | Hauptlager | Außenlager | Meldebestand
                            "Hauptlager" here = Shopify inventoryQuantity (editable)
                        */}
                        {hasRealVariants && isOpen && (
                          <tr>
                            <td colSpan={7} style={{ ...tdStyle, background: "#f6f6f7", paddingLeft: 40 }}>
                              <Text variant="headingSm" as="p">Varianten</Text>
                              <div style={{ marginTop: 10 }}>
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                  <thead>
                                    <tr style={{ background: "#f6f6f7" }}>
                                      <th style={{ padding: 8, textAlign: "left" }}>Artikel</th>
                                      <th style={{ padding: 8, textAlign: "left" }}>Preis</th>
                                      <th style={{ padding: 8, textAlign: "left" }}>Hauptlager</th>
                                      <th style={{ padding: 8, textAlign: "left" }}>Außenlager</th>
                                      <th style={{ padding: 8, textAlign: "left" }}>Meldebestand</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {variants
                                      .filter((vr) => Number(vr.aussenlager?.value) > 0)
                                      .map((vr) => (
                                        <tr key={vr.id} style={{ borderTop: "1px solid #e1e3e5" }}>
                                          <td style={{ padding: 8, width: 220 }}>
                                            <strong>{vr.title}</strong>
                                            {vr.sku && (
                                              <div style={{ fontSize: 12, opacity: 0.7 }}>
                                                SKU: {vr.sku}
                                              </div>
                                            )}
                                          </td>
                                          <td style={{ padding: 8 }}>
                                            <Text as="p">{vr.price ? `€${vr.price}` : "—"}</Text>
                                          </td>
                                          {/* Hauptlager = Shopify inventoryQuantity (editable) */}
                                          <td style={{ padding: 8 }}>
                                            <InlineEditable
                                              value={String(vr.inventoryQuantity ?? "")}
                                              editing={isEditing("variant", vr.id, "inventory")}
                                              onStartEdit={() => startEdit("variant", vr.id, "inventory")}
                                              onCancelEdit={cancelEdit}
                                              onSave={(v) =>
                                                saveInventoryByInventoryItem(vr.inventoryItem?.id, v)
                                              }
                                              type="number"
                                            />
                                          </td>
                                          <td style={{ padding: 8 }}>
                                            <Text as="p">{vr.aussenlager?.value ?? "—"}</Text>
                                          </td>
                                          <td style={{ padding: 8 }}>
                                            <InlineEditable
                                              value={vr.melde?.value ?? ""}
                                              editing={isEditing("variant", vr.id, "melde")}
                                              onStartEdit={() => startEdit("variant", vr.id, "melde")}
                                              onCancelEdit={cancelEdit}
                                              onSave={(v) => saveMelde(vr.id, v)}
                                              type="number"
                                            />
                                          </td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <br />

          <InlineStack align="space-between" gap="300">
            <Button
              disabled={currentPage <= 1}
              onClick={() => { cancelEdit(); navigate(buildUrl({ q: q || "", page: currentPage - 1 })); }}
            >
              Vorherige
            </Button>
            <Text as="p" variant="bodySm" tone="subdued">
              Seite {currentPage} von {totalPages} · {totalCount} Produkte · {limit} pro Seite
            </Text>
            <Button
              disabled={currentPage >= totalPages}
              variant="primary"
              onClick={() => { cancelEdit(); navigate(buildUrl({ q: q || "", page: currentPage + 1 })); }}
            >
              Nächste
            </Button>
          </InlineStack>
        </Card>
      </Page>
    </>
  );
}