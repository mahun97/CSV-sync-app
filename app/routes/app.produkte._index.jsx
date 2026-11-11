import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  Thumbnail,
  TextField,
  Select,
  InlineStack,
  BlockStack,
  Button,
  Box,
  Pagination,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const esc = (s) => String(s).replace(/(["\\:()])/g, "\\$1");

function buildQuery({ q, status, vendor }) {
  const parts = [];
  if (q) {
    const t = esc(q.trim());
    parts.push(`(title:*${t}* OR sku:${t}* OR barcode:${t} OR vendor:*${t}*)`);
  }
  if (status) parts.push(`status:${status}`);
  if (vendor) parts.push(`vendor:"${esc(vendor)}"`);
  return parts.join(" AND ") || null;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const status = url.searchParams.get("status") || "";
  const vendor = url.searchParams.get("vendor") || "";
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");

  const res = await admin.graphql(
    `query ($first: Int, $last: Int, $after: String, $before: String, $query: String) {
      products(first: $first, last: $last, after: $after, before: $before, query: $query, sortKey: UPDATED_AT, reverse: true) {
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        nodes {
          id title vendor status totalInventory updatedAt
          featuredMedia { preview { image { url } } }
          variantsCount { count }
          exp: metafield(namespace: "custom", key: "export_repricer") { value }
          variants(first: 1) { nodes { sku price } }
        }
      }
      shop { productVendors: productVendors(first: 250) { nodes } }
    }`,
    {
      variables: {
        first: before ? null : 50,
        last: before ? 50 : null,
        after: after || null,
        before: before || null,
        query: buildQuery({ q, status, vendor }),
      },
    },
  );
  const data = (await res.json()).data;
  const products = data.products.nodes;

  // Hinweise aus dem letzten echten Repricer-Lauf
  let issues = {};
  try {
    const last = await prisma.repricerRun.findFirst({ where: { dryRun: false, status: { not: "running" } }, orderBy: { startedAt: "desc" } });
    if (last) {
      const ev = await prisma.repricerEvent.groupBy({
        by: ["productId", "type"],
        where: { runId: last.id, productId: { in: products.map((p) => p.id) }, type: { in: ["not_in_omnia", "data", "ek_block", "clamped"] } },
        _count: true,
      });
      for (const e of ev) (issues[e.productId] ??= []).push({ type: e.type, count: e._count });
    }
  } catch {}

  return json({
    products,
    pageInfo: data.products.pageInfo,
    vendors: data.shop.productVendors?.nodes || [],
    issues,
    q,
    status,
    vendor,
  });
};

const STATUS = {
  ACTIVE: { tone: "success", label: "Aktiv" },
  DRAFT: { tone: "info", label: "Entwurf" },
  ARCHIVED: { tone: undefined, label: "Archiviert" },
};
const ISSUE = {
  not_in_omnia: { tone: "warning", label: "Fehlt in Omnia" },
  data: { tone: "warning", label: "Min/Max-Fehler" },
  ek_block: { tone: "critical", label: "EK-Sperre" },
  clamped: { tone: "attention", label: "Begrenzt" },
};

export default function Produkte() {
  const { products, pageInfo, vendors, issues, q, status, vendor } = useLoaderData();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(q);

  const go = (patch) => {
    const p = new URLSearchParams(params);
    p.delete("after");
    p.delete("before");
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    navigate(`/app/produkte?${p.toString()}`);
  };

  return (
    <Page
      title="Produkte"
      subtitle="Artikel, Preise, Omnia-Grenzen und Produkttexte an einem Ort"
      primaryAction={{ content: "Produkt anlegen", onAction: () => navigate("/app/produkte/neu") }}
    >
      <Card padding="0">
        <Box padding="300">
          <InlineStack gap="300" wrap={false} blockAlign="end">
            <div style={{ flex: 1 }}>
              <TextField
                label="Suche"
                labelHidden
                placeholder="Titel, SKU, EAN oder Hersteller …"
                value={search}
                onChange={setSearch}
                clearButton
                onClearButtonClick={() => { setSearch(""); go({ q: "" }); }}
                autoComplete="off"
                connectedRight={<Button onClick={() => go({ q: search })}>Suchen</Button>}
              />
            </div>
            <Select
              label="Status"
              labelHidden
              options={[{ label: "Alle Status", value: "" }, { label: "Aktiv", value: "active" }, { label: "Entwurf", value: "draft" }, { label: "Archiviert", value: "archived" }]}
              value={status}
              onChange={(v) => go({ status: v })}
            />
            <Select
              label="Hersteller"
              labelHidden
              options={[{ label: "Alle Hersteller", value: "" }, ...vendors.map((v) => ({ label: v, value: v }))]}
              value={vendor}
              onChange={(v) => go({ vendor: v })}
            />
          </InlineStack>
        </Box>
        <IndexTable
          resourceName={{ singular: "Produkt", plural: "Produkte" }}
          itemCount={products.length}
          selectable={false}
          headings={[{ title: "" }, { title: "Produkt" }, { title: "Status" }, { title: "Varianten", alignment: "end" }, { title: "Bestand", alignment: "end" }, { title: "Preis ab", alignment: "end" }, { title: "Omnia" }, { title: "Hinweise" }]}
        >
          {products.map((p, i) => (
            <IndexTable.Row id={p.id} key={p.id} position={i} onClick={() => navigate(`/app/produkte/${p.id.split("/").pop()}`)}>
              <IndexTable.Cell>
                <Thumbnail size="small" source={p.featuredMedia?.preview?.image?.url || ImageIcon} alt="" />
              </IndexTable.Cell>
              <IndexTable.Cell>
                <BlockStack gap="050">
                  <Text as="span" fontWeight="semibold">{p.title}</Text>
                  <Text as="span" variant="bodySm" tone="subdued">{p.vendor} · SKU {p.variants.nodes[0]?.sku || "–"}</Text>
                </BlockStack>
              </IndexTable.Cell>
              <IndexTable.Cell><Badge tone={STATUS[p.status]?.tone}>{STATUS[p.status]?.label || p.status}</Badge></IndexTable.Cell>
              <IndexTable.Cell><Text as="span" alignment="end">{p.variantsCount?.count}</Text></IndexTable.Cell>
              <IndexTable.Cell><Text as="span" alignment="end" tone={p.totalInventory <= 0 ? "critical" : undefined}>{p.totalInventory}</Text></IndexTable.Cell>
              <IndexTable.Cell><Text as="span" alignment="end">{Number(p.variants.nodes[0]?.price || 0).toFixed(2).replace(".", ",")} €</Text></IndexTable.Cell>
              <IndexTable.Cell>{p.exp?.value === "1" ? <Badge tone="success">Repricer</Badge> : <Text tone="subdued" as="span">–</Text>}</IndexTable.Cell>
              <IndexTable.Cell>
                <InlineStack gap="100">
                  {(issues[p.id] || []).map((x) => (
                    <Badge key={x.type} tone={ISSUE[x.type]?.tone}>{`${ISSUE[x.type]?.label}${x.count > 1 ? ` ×${x.count}` : ""}`}</Badge>
                  ))}
                </InlineStack>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
        <Box padding="300">
          <InlineStack align="center">
            <Pagination
              hasPrevious={pageInfo.hasPreviousPage}
              hasNext={pageInfo.hasNextPage}
              onPrevious={() => { const p = new URLSearchParams(params); p.delete("after"); p.set("before", pageInfo.startCursor); navigate(`/app/produkte?${p}`); }}
              onNext={() => { const p = new URLSearchParams(params); p.delete("before"); p.set("after", pageInfo.endCursor); navigate(`/app/produkte?${p}`); }}
            />
          </InlineStack>
        </Box>
      </Card>
    </Page>
  );
}
