import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { useNavigation } from "@remix-run/react";

import {
  Page,
  Card,
  Thumbnail,
  Button,
  InlineStack,
  Badge,
  Text,
  TextField,
  Spinner,
  Select,
} from "@shopify/polaris";

/* =======================
   HELPERS (Search & Status)
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

  if (q.startsWith("gid://")) {
    return `id:${val}`;
  }

  if (/^\d+$/.test(q)) {
    return `id:${val}`;
  }

  if (q.startsWith("variant:")) {
    const id = q.split(":")[1];
    return `variant_id:${escapeShopifyQueryValue(id)}`;
  }

  return `title:${quoted} OR sku:${quoted}`;
}

// Stock status - triggers at <= 5 for "low"
const getStockStatus = (qty) => {
  const count = Number(qty) || 0;
  if (count <= 5) return { label: "Niedrig", tone: "critical" };
  if (count <= 20) return { label: "Mittel", tone: "warning" };
  return { label: "Gesund", tone: "success" };
};

/* =======================
   FILTER LOGIC
======================= */
// Filter 1: Hauptlager <= Melde (hauptlager at or below reorder point)
const filterLowMainInventory = (hauptlagerQty, meldeQty) => {
  return hauptlagerQty <= meldeQty;
};

// Filter 2: Hauptlager minus Melde <= Aussenlager
// (main inventory - reorder level <= external inventory)
const filterLowAfterReorder = (node, warehouseQty) => {
  const mainQty = Number(node.totalInventory) || 0;
  const reorderLevel = Number(node.reorderLevel) || 0;
  return mainQty - reorderLevel <= warehouseQty;
};

function toPositiveInt(v, fallback = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : fallback;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const qParam = url.searchParams.get("q") || "";
  const after = url.searchParams.get("after") || null;

  const query = buildProductsQuery(qParam);

  const PAGE_SIZE = 10;

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

                  aussenlager: metafield(namespace: "custom", key: "aussenlager") {
                    value
                  }

                  hauptlager: metafield(namespace: "custom", key: "hauptlager") {
                    value
                  }

                  melde: metafield(namespace: "custom", key: "melde") {
                    value
                  }

                  inventoryItem {
                    id
                  }
                }
              }
            }
            featuredImage { url }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }`,
    {
      variables: {
        first: PAGE_SIZE,
        after,
        query,
      },
    },
  );

  const data = await res.json();
  const productIds = data.data.products.edges.map((e) => e.node.id);

  const warehouses = await db.externalWarehouse.findMany({
    where: {
      productId: { in: productIds },
    },
  });

  const warehouseMap = Object.fromEntries(
    warehouses.map((w) => [w.productId, w.warehouse]),
  );

  const reorderMap = Object.fromEntries(
    warehouses.map((w) => [w.productId, w.reorder]),
  );

  const productsWithWarehouse = data.data.products.edges.map((edge) => ({
    ...edge,
    node: {
      ...edge.node,
      externalWarehouse: warehouseMap[edge.node.id] || "",
      reorderLevel: reorderMap[edge.node.id] || "",
    },
  }));

  return json({
    products: productsWithWarehouse,
    pageInfo: data.data.products.pageInfo,
    q: qParam,
    after,
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
    const shop = session.shop;

    const productId = form.get("productId");
    const reorder = form.get("reorder");

    await db.externalWarehouse.upsert({
      where: { shop_productId: { shop, productId } },
      update: { reorder: String(reorder || "0") },
      create: {
        shop,
        productId,
        reorder: String(reorder || "0"),
        warehouse: "0",
      },
    });

    return json({ success: true });
  }

  if (type === "delete-variant") {
    const variantId = form.get("variantId");

    await admin.graphql(
      `mutation productVariantDelete($id: ID!) {
        productVariantDelete(id: $id) {
          deletedProductVariantId
          userErrors { field message }
        }
      }`,
      { variables: { id: variantId } },
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
    const price = form.get("price");

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
    const quantity = parseInt(form.get("quantity"), 10);

    const locRes = await admin.graphql(
      `query getLocation($id: ID!) {
        inventoryItem(id: $id) {
          inventoryLevels(first: 1) {
            edges { node { location { id } } }
          }
        }
      }`,
      { variables: { id: inventoryItemId } },
    );

    const locData = await locRes.json();
    const locationId =
      locData.data?.inventoryItem?.inventoryLevels?.edges[0]?.node?.location
        ?.id;

    if (!locationId)
      return json({ success: false, error: "Location not found" });

    const invRes = await admin.graphql(
      `mutation inventorySet($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
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
    const errors = invData.data?.inventorySetQuantities?.userErrors;
    if (errors?.length) return json({ success: false, errors });
    return json({ success: true });
  }

  // -------------------------------------------------------
  // NEW ACTION: transfer-to-aussenlager
  // Updates custom.aussenlager = newAussenlager
  // Updates custom.hauptlager  = currentHauptlager - newAussenlager
  // Both metafields are set via metafieldsSet on the variant.
  // -------------------------------------------------------
  if (type === "transfer-to-aussenlager") {
    const variantId = form.get("variantId");
    const newAussenlager = parseInt(form.get("newAussenlager"), 10) || 0;
    const currentHauptlager = parseInt(form.get("currentHauptlager"), 10) || 0;

    const newHauptlager = currentHauptlager - newAussenlager;

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
              ownerId: variantId,
              namespace: "custom",
              key: "aussenlager",
              value: String(newAussenlager),
              // Use "number_integer" if these metafields were created as integers,
              // or "single_line_text_field" if created as text.
              type: "number_integer",
            },
            {
              ownerId: variantId,
              namespace: "custom",
              key: "hauptlager",
              value: String(newHauptlager),
              type: "number_integer",
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
    const productId = form.get("productId");
    const inventoryItemId = form.get("inventoryItemId");
    const newShopifyQty = parseInt(form.get("newShopifyQty"), 10);
    const newExternalQty = parseInt(form.get("newExternalQty"), 10);

    const locRes = await admin.graphql(
      `query getLocation($id: ID!) {
        inventoryItem(id: $id) {
          inventoryLevels(first: 1) {
            edges { node { location { id } } }
          }
        }
      }`,
      { variables: { id: inventoryItemId } },
    );

    const locData = await locRes.json();
    const locationId =
      locData.data?.inventoryItem?.inventoryLevels?.edges[0]?.node?.location
        ?.id;

    if (!locationId) {
      return json({ success: false, error: "Location not found" });
    }

    const invRes = await admin.graphql(
      `mutation inventorySet($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            name: "available",
            reason: "correction",
            ignoreCompareQuantity: true,
            quantities: [
              { inventoryItemId, locationId, quantity: newShopifyQty },
            ],
          },
        },
      },
    );

    const invData = await invRes.json();
    const errors = invData.data?.inventorySetQuantities?.userErrors;

    if (errors?.length) {
      return json({ success: false, errors });
    }

    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    await db.externalWarehouse.upsert({
      where: { shop_productId: { shop, productId } },
      update: { warehouse: String(newExternalQty) },
      create: { shop, productId, warehouse: String(newExternalQty) },
    });

    return json({ success: true });
  }

  if (type === "external-warehouse") {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    const productId = form.get("productId");
    const warehouse = form.get("warehouse");

    await db.externalWarehouse.upsert({
      where: {
        shop_productId: { shop, productId },
      },
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
const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
};
const thStyle = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "2px solid #e1e3e5",
  color: "#6d7175",
  fontWeight: 600,
  background: "#f6f6f7",
};
const tdStyle = {
  padding: "10px 12px",
  borderBottom: "1px solid #e1e3e5",
  verticalAlign: "middle",
};

/* =======================
   INLINE EDIT CELL
======================= */
function InlineEditable({
  value,
  onSave,
  type = "text",
  editing,
  onStartEdit,
  onCancelEdit,
}) {
  const [val, setVal] = useState(value);

  useEffect(() => setVal(value), [value, editing]);

  const handleSave = () => {
    onCancelEdit();
    if (String(val) !== String(value)) onSave(val);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setVal(value);
      onCancelEdit();
    }
  };

  if (editing) {
    return (
      <div style={{ minWidth: 110 }}>
        <TextField
          value={val}
          onChange={setVal}
          onBlur={handleSave}
          autoFocus
          type={type}
          onKeyDown={handleKeyDown}
        />
      </div>
    );
  }

  return (
    <div
      onClick={onStartEdit}
      title="Click to edit"
      style={{
        cursor: "pointer",
        padding: "4px 6px",
        borderRadius: 6,
        border: "1px solid #e1e3e5",
        transition: "all 0.15s",
        display: "inline-block",
        minWidth: 60,
        background: "#f6f6f7",
        height: "30px",
        textAlign: "center",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.border = "1px solid #bbb";
        e.currentTarget.style.background = "#f6f6f7";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.border = "1px solid #bbb";
        e.currentTarget.style.background = "#f6f6f7";
      }}
    >
      {value ?? "—"}
    </div>
  );
}

/* =======================
   MAIN COMPONENT (With Filters)
======================= */
export default function Index() {
  const { products, pageInfo, q, after } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();

  const navigation = useNavigation();
  const isPageLoading =
    navigation.state === "loading" || navigation.state === "submitting";

  const lastCursor = useMemo(() => {
    return products?.length ? products[products.length - 1].cursor : null;
  }, [products]);

  const [cursorStack, setCursorStack] = useState([]);
  const [openVariantProductId, setOpenVariantProductId] = useState(null);
  const [editingCell, setEditingCell] = useState(null);
  const [tempWarehouse2, setTempWarehouse2] = useState({});

  // FILTER STATE
  const [filterType, setFilterType] = useState("none");

  // Search UI
  const [search, setSearch] = useState(q || "");
  useEffect(() => setSearch(q || ""), [q]);

  useEffect(() => {
    setCursorStack([]);
  }, [q]);

  const buildUrl = ({ q, after }) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (after) sp.set("after", after);
    return `?${sp.toString()}`;
  };

  const isEditing = (scope, id, field) =>
    editingCell?.scope === scope &&
    editingCell?.id === id &&
    editingCell?.field === field;

  const startEdit = (scope, id, field) => setEditingCell({ scope, id, field });
  const cancelEdit = () => setEditingCell(null);

  const saveProductPrice = (productId, variantId, rawPrice) => {
    const price = String(rawPrice || "")
      .replace("₹", "")
      .trim();
    submit(
      { type: "variant-price", productId, variantId, price },
      { method: "post" },
    );
  };

  const saveInventoryByInventoryItem = (inventoryItemId, quantity) => {
    submit(
      { type: "variant-inventory", inventoryItemId, quantity },
      { method: "post" },
    );
  };

  const saveWarehouse = (productId, warehouse) => {
    submit(
      { type: "external-warehouse", productId, warehouse },
      { method: "post" },
    );
  };

  const saveReorderLevel = (productId, reorder) => {
    submit({ type: "reorder-level", productId, reorder }, { method: "post" });
  };

  // Updated: sets custom.aussenlager = inputQty,
  // and custom.hauptlager = currentHauptlager - inputQty
  const transferToAussenlager = (variantId, currentHauptlager, productId, inputQty) => {
    const newAussenlager = Number(inputQty) || 0;
    if (newAussenlager <= 0) return;

    submit(
      {
        type: "transfer-to-aussenlager",
        variantId,
        newAussenlager: String(newAussenlager),
        currentHauptlager: String(Number(currentHauptlager) || 0),
      },
      { method: "post" },
    );

    setTempWarehouse2((prev) => ({
      ...prev,
      [productId]: "",
    }));
  };

  const deleteProduct = (productId) =>
    submit({ type: "delete", productId }, { method: "post" });

  const getRowInfo = (node) => {
    let variants = node.variants.edges.map((e) => e.node);

    if (q && !q.includes(":")) {
      const searchLower = q.toLowerCase();

      const filtered = variants.filter(
        (v) =>
          v.sku?.toLowerCase().includes(searchLower) ||
          v.id?.toLowerCase().includes(searchLower),
      );

      if (filtered.length > 0) {
        variants = filtered;
      }
    }

    const firstVariant = variants[0];

    const hasRealVariants =
      variants.length > 1 || firstVariant?.title !== "Default Title";

    const qty = hasRealVariants
      ? variants.reduce((sum, v) => sum + Number(v.inventoryQuantity || 0), 0)
      : Number(firstVariant?.inventoryQuantity ?? node.totalInventory ?? 0);

    return { variants, firstVariant, hasRealVariants, qty };
  };

  // APPLY FILTERS — fixed: was referencing undefined `firstVariant`
  const filteredProducts = useMemo(() => {
    return products.filter(({ node }) => {
      const { firstVariant } = getRowInfo(node);
      // aussenlager and melde read directly from Shopify variant metafields
      const warehouseQty = Number(firstVariant?.aussenlager?.value) || 0;
      const hauptlagerQty = Number(firstVariant?.hauptlager?.value) || 0;
      const meldeQty = Number(firstVariant?.melde?.value) || 0;

      if (filterType === "none") {
        return true;
      } else if (filterType === "lowMain") {
        // Red zone: hauptlager <= melde (reorder point breached)
        return filterLowMainInventory(hauptlagerQty, meldeQty);
      } else if (filterType === "lowAfterReorder") {
        return filterLowAfterReorder(node, warehouseQty);
      }
      return true;
    });
  }, [products, filterType]);

  return (
    <>
      {isPageLoading && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#fff",
              padding: "40px 60px",
              borderRadius: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
              textAlign: "center",
            }}
          >
            <Spinner size="large" />
            <div style={{ marginTop: 16, fontSize: 16, fontWeight: 500 }}>
              Bitte warten...
            </div>
          </div>
        </div>
      )}
      <Page title="Lagerverwalter">
        <Card>
          {/* SEARCH & FILTER SECTION */}
          <div style={{ padding: 16, borderBottom: "1px solid #e1e3e5" }}>
            {/* Search Bar */}
            <InlineStack gap="300" align="space-between">
              <div style={{ flex: 1, minWidth: 280 }}>
                <TextField
                  label="Search by Title or SKU"
                  labelHidden
                  placeholder='Suchen... (z.B. "Nike" oder "sku:ABC123")'
                  value={search}
                  onChange={setSearch}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      navigate(buildUrl({ q: search.trim() || "" }));
                    }
                  }}
                  clearButton
                  onClearButtonClick={() => navigate(`.`)}
                />
              </div>

              <InlineStack gap="200">
                <Button
                  variant="primary"
                  onClick={() => navigate(buildUrl({ q: search.trim() || "" }))}
                >
                  Suchen
                </Button>
                <Button
                  disabled={!q}
                  onClick={() => navigate(buildUrl({ q: "" }))}
                >
                  Zurücksetzen
                </Button>
              </InlineStack>
            </InlineStack>

            {/* Info Text */}
            <div style={{ marginTop: 10 }}>
              <Text as="p" variant="bodySm" tone="subdued">
                Sortiert nach Titel
                {q ? (
                  <>
                    {" "}
                    | Suchbegriff: <strong>{q}</strong>
                  </>
                ) : null}
              </Text>
            </div>

            {/* FILTER DROPDOWN */}
            <div
              style={{
                marginTop: 16,
                maxWidth: "100%",
                display: "flex",
                gap: 8,
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Select
                label="Filter"
                options={[
                  { label: "Kein Filter", value: "none" },
                  {
                    label: "🔴 Nur Hauptlager <= Meldebestand",
                    value: "lowMain",
                  },
                  {
                    label: "🟠 Hauptlager minus Melde <= Aussenlager",
                    value: "lowAfterReorder",
                  },
                ]}
                value={filterType}
                onChange={setFilterType}
              />
              <Text as="p" variant="bodySm" tone="subdued">
                Zeige {filteredProducts.length} von {products.length} Produkten
              </Text>
            </div>
          </div>

          {/* TABLE */}
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Artikel</th>
                  <th style={thStyle}>Hersteller</th>
                  {/* Renamed: was "Hauptlager", now shows real Shopify stock */}
                  <th style={thStyle}>Inventory</th>
                  <th style={thStyle}>Status</th>
                  {/* New column: shows custom.hauptlager metafield */}
                  <th style={thStyle}>Hauptlager</th>
                  {/* Shows custom.aussenlager metafield (live from Shopify) */}
                  <th style={thStyle}>Außenlager</th>
                  {/* Renamed: was "Aussenlager Neu" */}
                  <th style={thStyle}>Außenlager Neu</th>
                  <th style={thStyle}>Meldebestand (in VKE)</th>
                  <th style={thStyle}>Aktion</th>
                </tr>
              </thead>

              <tbody>
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan="9" style={{ ...tdStyle, textAlign: "center" }}>
                      <Text tone="subdued">
                        Keine Produkte entsprechen diesem Filter
                      </Text>
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map(({ node, cursor }) => {
                    const { variants, firstVariant, hasRealVariants, qty } =
                      getRowInfo(node);
                    const isOpen = openVariantProductId === node.id;
                    const reorderLevel = Number(node.reorderLevel) || 0;
                    const canEditRowInventory = !hasRealVariants;

                    // Values from Shopify metafields (always up-to-date via loader)
                    const aussenlagerValue = !hasRealVariants
                      ? firstVariant?.aussenlager?.value ?? "—"
                      : "—";
                    const hauptlagerValue = !hasRealVariants
                      ? firstVariant?.hauptlager?.value ?? "—"
                      : "—";
                    const currentHauptlager =
                      Number(firstVariant?.hauptlager?.value) || 0;

                    // Meldebestand from custom.melde metafield
                    const meldeValue = !hasRealVariants
                      ? firstVariant?.melde?.value ?? "—"
                      : "—";
                    const meldeQty = Number(firstVariant?.melde?.value) || 0;

                    // Red zone: hauptlager has hit or dropped below the reorder point
                    const isRedZone =
                      !hasRealVariants && currentHauptlager <= meldeQty && meldeQty > 0;

                    // Stock status badge
                    const stockStatus = getStockStatus(qty);

                    return (
                      <Fragment key={node.id}>
                        <tr
                          style={{
                            background: isRedZone
                              ? "rgba(255, 0, 0, 0.08)"
                              : "transparent",
                          }}
                        >
                          <td style={{ ...tdStyle, minWidth: 220 }}>
                            <div>
                              <Text as="p" variant="bodyMd">
                                {node.title}
                              </Text>
                              {firstVariant?.sku ? (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  SKU: {firstVariant.sku}
                                </Text>
                              ) : null}
                            </div>
                          </td>

                          <td style={{ ...tdStyle, minWidth: 300 }}>
                            <Text as="p">{node.vendor || "—"}</Text>
                          </td>

                          {/* Inventory: real Shopify stock quantity */}
                          <td
                            style={{
                              ...tdStyle,
                              minWidth: 110,
                              textAlign: "center",
                            }}
                          >
                            <Text as="p">{String(qty)}</Text>
                          </td>

                          {/* Status Badge */}
                          <td style={{ ...tdStyle, minWidth: 100 }}>
                            <Badge tone={stockStatus.tone}>
                              {stockStatus.label}
                            </Badge>
                          </td>

                          {/* Hauptlager: custom.hauptlager metafield */}
                          <td style={{ ...tdStyle, minWidth: 120 }}>
                            {!hasRealVariants ? (
                              <Text as="p">{hauptlagerValue}</Text>
                            ) : (
                              <Text as="p" tone="subdued">
                                —
                              </Text>
                            )}
                          </td>

                          {/* Außenlager: custom.aussenlager metafield (read from Shopify) */}
                          <td style={{ ...tdStyle, minWidth: 120 }}>
                            {!hasRealVariants ? (
                              <Text as="p">{aussenlagerValue}</Text>
                            ) : (
                              <Text as="p" tone="subdued">
                                —
                              </Text>
                            )}
                          </td>

                          {/* Außenlager Neu: input that triggers metafield update */}
                          <td style={{ ...tdStyle, minWidth: 180 }}>
                            {!hasRealVariants ? (
                              <InlineEditable
                                value={tempWarehouse2[node.id] || ""}
                                editing={isEditing(
                                  "product",
                                  node.id,
                                  "warehouse2",
                                )}
                                onStartEdit={() =>
                                  startEdit("product", node.id, "warehouse2")
                                }
                                onCancelEdit={cancelEdit}
                                onSave={(v) =>
                                  transferToAussenlager(
                                    firstVariant?.id,
                                    currentHauptlager,
                                    node.id,
                                    v,
                                  )
                                }
                                type="number"
                              />
                            ) : (
                              <Text as="p" tone="subdued">
                                —
                              </Text>
                            )}
                          </td>

                          <td style={{ ...tdStyle, minWidth: 160 }}>
                            {!hasRealVariants ? (
                              <InlineStack gap="200" blockAlign="center">
                                <Text as="p">{meldeValue}</Text>
                                {isRedZone && (
                                  <Badge tone="critical">🔴 Rot</Badge>
                                )}
                              </InlineStack>
                            ) : (
                              <Text tone="subdued">—</Text>
                            )}
                          </td>

                          <td style={{ ...tdStyle, minWidth: 260 }}>
                            <InlineStack gap="200">
                              {hasRealVariants && (
                                <Button
                                  size="slim"
                                  onClick={() => {
                                    cancelEdit();
                                    setOpenVariantProductId(
                                      isOpen ? null : node.id,
                                    );
                                  }}
                                >
                                  {isOpen
                                    ? "Varianten ausblenden"
                                    : "Varianten"}
                                </Button>
                              )}
                            </InlineStack>
                          </td>
                        </tr>

                        {hasRealVariants && isOpen && (
                          <tr>
                            <td
                              colSpan={9}
                              style={{
                                ...tdStyle,
                                background: "#f6f6f7",
                                paddingLeft: 40,
                              }}
                            >
                              <Text variant="headingSm" as="p">
                                Varianten
                              </Text>

                              <div style={{ marginTop: 10 }}>
                                <table
                                  style={{
                                    width: "100%",
                                    borderCollapse: "collapse",
                                  }}
                                >
                                  <thead>
                                    <tr style={{ background: "#f6f6f7" }}>
                                      <th
                                        style={{
                                          padding: 8,
                                          textAlign: "left",
                                        }}
                                      >
                                        Artikel
                                      </th>
                                      <th
                                        style={{
                                          padding: 8,
                                          textAlign: "left",
                                        }}
                                      >
                                        Preis
                                      </th>
                                      <th
                                        style={{
                                          padding: 8,
                                          textAlign: "left",
                                        }}
                                      >
                                        Inventory
                                      </th>
                                    </tr>
                                  </thead>

                                  <tbody>
                                    {variants.map((vr) => (
                                      <tr
                                        key={vr.id}
                                        style={{
                                          borderTop: "1px solid #e1e3e5",
                                        }}
                                      >
                                        <td style={{ padding: 8, width: 255 }}>
                                          <strong>{vr.title}</strong>
                                          {vr.sku ? (
                                            <div
                                              style={{
                                                fontSize: 12,
                                                opacity: 0.7,
                                              }}
                                            >
                                              SKU: {vr.sku}
                                            </div>
                                          ) : null}
                                        </td>

                                        <td style={{ padding: 8 }}>
                                          <Text as="p">
                                            {vr.price ? `€${vr.price}` : "—"}
                                          </Text>
                                        </td>

                                        <td style={{ padding: 8 }}>
                                          <InlineEditable
                                            value={String(
                                              vr.inventoryQuantity ?? "",
                                            )}
                                            editing={isEditing(
                                              "variant",
                                              vr.id,
                                              "inventory",
                                            )}
                                            onStartEdit={() =>
                                              startEdit(
                                                "variant",
                                                vr.id,
                                                "inventory",
                                              )
                                            }
                                            onCancelEdit={cancelEdit}
                                            onSave={(v) =>
                                              saveInventoryByInventoryItem(
                                                vr.inventoryItem?.id,
                                                v,
                                              )
                                            }
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

          {/* PAGINATION */}
          <InlineStack align="space-between" gap="300">
            <Button
              disabled={cursorStack.length === 0}
              onClick={() => {
                cancelEdit();

                const prev = cursorStack[cursorStack.length - 1];

                setCursorStack((s) => s.slice(0, -1));

                navigate(buildUrl({ q: q || "", after: prev || "" }));
              }}
            >
              Vorherige
            </Button>

            <Text as="p" variant="bodySm" tone="subdued">
              Seite {cursorStack.length + 1}
            </Text>

            <Button
              disabled={!pageInfo?.hasNextPage}
              variant="primary"
              onClick={() => {
                cancelEdit();

                setCursorStack((s) => [...s, after]);

                navigate(buildUrl({ q: q || "", after: lastCursor }));
              }}
            >
              Nächste
            </Button>
          </InlineStack>
        </Card>
      </Page>
    </>
  );
}