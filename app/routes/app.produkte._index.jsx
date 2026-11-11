import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  IndexFilters,
  useSetIndexFiltersMode,
  Text,
  Badge,
  Thumbnail,
  ChoiceList,
  InlineStack,
  BlockStack,
  InlineGrid,
  Box,
  Pagination,
} from "@shopify/polaris";
import { ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCatalog } from "../lib/catalog.server";

const esc = (s) => String(s).replace(/(["\\:()])/g, "\\$1");
const STATUS_TABS = ["", "active", "draft", "archived"];

function buildQuery({ q, status, vendor, kategorie }) {
  const parts = [];
  if (q) {
    const t = esc(q.trim());
    parts.push(`(title:*${t}* OR sku:${t}* OR barcode:${t} OR vendor:*${t}*)`);
  }
  if (status) parts.push(`status:${status}`);
  if (vendor) parts.push(`vendor:"${esc(vendor)}"`);
  if (kategorie) parts.push(`tag:"${esc(kategorie)}"`);
  return parts.join(" AND ") || null;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const status = url.searchParams.get("status") || "";
  const vendor = url.searchParams.get("vendor") || "";
  const kategorie = url.searchParams.get("kategorie") || "";
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");

  const gql = async (query, variables) => (await (await admin.graphql(query, { variables })).json()).data;
  const [data, catalog, counts] = await Promise.all([
    gql(
      `query ($first: Int, $last: Int, $after: String, $before: String, $query: String) {
        products(first: $first, last: $last, after: $after, before: $before, query: $query, sortKey: UPDATED_AT, reverse: true) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          nodes {
            id title vendor status totalInventory updatedAt tags
            featuredMedia { preview { image { url } } }
            variantsCount { count }
            exp: metafield(namespace: "custom", key: "export_repricer") { value }
            priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
          }
        }
      }`,
      { first: before ? null : 50, last: before ? 50 : null, after: after || null, before: before || null, query: buildQuery({ q, status, vendor, kategorie }) },
    ),
    getCatalog(gql),
    gql(`{
      aktiv: productsCount(query: "status:active") { count }
      entwurf: productsCount(query: "status:draft") { count }
      leer: productsCount(query: "status:active AND inventory_total:<=0") { count }
    }`),
  ]);
  const products = data.products.nodes;

  let issues = {};
  let lastRun = null;
  try {
    lastRun = await prisma.repricerRun.findFirst({ where: { dryRun: false, status: { not: "running" } }, orderBy: { startedAt: "desc" } });
    if (lastRun) {
      const ev = await prisma.repricerEvent.groupBy({
        by: ["productId", "type"],
        where: { runId: lastRun.id, productId: { in: products.map((p) => p.id) }, type: { in: ["not_in_omnia", "data", "ek_block", "clamped"] } },
        _count: true,
      });
      for (const e of ev) (issues[e.productId] ??= []).push({ type: e.type, count: e._count });
    }
  } catch {}

  return json({
    products,
    pageInfo: data.products.pageInfo,
    vendors: catalog.vendors.map((v) => v.name),
    categories: catalog.categories.map((c) => ({ tag: c.tag, label: c.parentTag ? `${c.parentTag} › ${c.title}` : c.title, parent: !c.parentTag })),
    counts: { aktiv: counts.aktiv.count, entwurf: counts.entwurf.count, leer: counts.leer.count, omniaProbleme: lastRun ? lastRun.notInOmnia : null },
    issues,
    q, status, vendor, kategorie,
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
const price = (r) => {
  const a = Number(r.minVariantPrice.amount);
  const b = Number(r.maxVariantPrice.amount);
  const f = (n) => n.toFixed(2).replace(".", ",");
  return a === b ? `${f(a)} €` : `${f(a)} – ${f(b)} €`;
};

function Stat({ label, value, tone, onClick }) {
  return (
    <div onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      <Card>
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
          <Text as="p" variant="headingXl" tone={tone}>{value ?? "–"}</Text>
        </BlockStack>
      </Card>
    </div>
  );
}

export default function Produkte() {
  const { products, pageInfo, vendors, categories, counts, issues, q, status, vendor, kategorie } = useLoaderData();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(q);
  const { mode, setMode } = useSetIndexFiltersMode();

  const go = (patch) => {
    const p = new URLSearchParams(params);
    p.delete("after");
    p.delete("before");
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    navigate(`/app/produkte?${p.toString()}`);
  };

  const tabs = ["Alle", "Aktiv", "Entwurf", "Archiviert"].map((t, i) => ({ id: `t${i}`, content: t, onAction: () => go({ status: STATUS_TABS[i] }) }));

  const filters = [
    {
      key: "kategorie",
      label: "Kategorie",
      filter: (
        <ChoiceList title="Kategorie" titleHidden choices={categories.map((c) => ({ label: c.label, value: c.tag }))} selected={kategorie ? [kategorie] : []} onChange={([v]) => go({ kategorie: v })} />
      ),
      shortcut: true,
    },
    {
      key: "vendor",
      label: "Hersteller",
      filter: <ChoiceList title="Hersteller" titleHidden choices={vendors.map((v) => ({ label: v, value: v }))} selected={vendor ? [vendor] : []} onChange={([v]) => go({ vendor: v })} />,
      shortcut: true,
    },
  ];
  const applied = [
    ...(kategorie ? [{ key: "kategorie", label: `Kategorie: ${categories.find((c) => c.tag === kategorie)?.label || kategorie}`, onRemove: () => go({ kategorie: "" }) }] : []),
    ...(vendor ? [{ key: "vendor", label: `Hersteller: ${vendor}`, onRemove: () => go({ vendor: "" }) }] : []),
  ];

  return (
    <Page
      title="Produkte"
      subtitle="Anlegen, duplizieren und pflegen – mit Preisen, Omnia-Grenzen, Texten und Pflichtangaben"
      primaryAction={{ content: "Produkt anlegen", icon: PlusIcon, onAction: () => navigate("/app/produkte/neu") }}
    >
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
          <Stat label="Aktive Produkte" value={counts.aktiv} onClick={() => go({ status: "active" })} />
          <Stat label="Entwürfe" value={counts.entwurf} onClick={() => go({ status: "draft" })} />
          <Stat label="Aktiv ohne Bestand" value={counts.leer} tone={counts.leer ? "caution" : undefined} />
          <Stat label="Fehlen in Omnia" value={counts.omniaProbleme} tone={counts.omniaProbleme ? "caution" : undefined} onClick={() => navigate("/app/repricer?type=not_in_omnia")} />
        </InlineGrid>

        <Card padding="0">
          <IndexFilters
            queryValue={query}
            queryPlaceholder="Titel, SKU, EAN oder Hersteller suchen"
            onQueryChange={setQuery}
            onQueryClear={() => { setQuery(""); go({ q: "" }); }}
            onQueryBlur={() => query !== q && go({ q: query })}
            cancelAction={{ onAction: () => { setQuery(q); } }}
            tabs={tabs}
            selected={Math.max(0, STATUS_TABS.indexOf(status))}
            onSelect={() => {}}
            filters={filters}
            appliedFilters={applied}
            onClearAll={() => go({ kategorie: "", vendor: "", q: "" })}
            mode={mode}
            setMode={setMode}
            canCreateNewView={false}
          />
          <div onKeyDown={(e) => e.key === "Enter" && go({ q: query })}>
            <IndexTable
              resourceName={{ singular: "Produkt", plural: "Produkte" }}
              itemCount={products.length}
              selectable={false}
              headings={[{ title: "" }, { title: "Produkt" }, { title: "Status" }, { title: "Geschmäcker", alignment: "end" }, { title: "Bestand", alignment: "end" }, { title: "Preis", alignment: "end" }, { title: "Omnia" }, { title: "Hinweise" }]}
            >
              {products.map((p, i) => {
                const cats = categories.filter((c) => !c.parent && p.tags.includes(c.tag)).slice(0, 2);
                return (
                  <IndexTable.Row id={p.id} key={p.id} position={i} onClick={() => navigate(`/app/produkte/${p.id.split("/").pop()}`)}>
                    <IndexTable.Cell><Thumbnail size="small" source={p.featuredMedia?.preview?.image?.url || ImageIcon} alt="" /></IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">{p.title}</Text>
                        <InlineStack gap="100" blockAlign="center">
                          <Text as="span" variant="bodySm" tone="subdued">{p.vendor}</Text>
                          {cats.map((c) => <Badge key={c.tag} size="small">{c.label.split(" › ").pop()}</Badge>)}
                        </InlineStack>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell><Badge tone={STATUS[p.status]?.tone}>{STATUS[p.status]?.label || p.status}</Badge></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{p.variantsCount?.count}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end" tone={p.totalInventory <= 0 ? "critical" : undefined}>{p.totalInventory}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{price(p.priceRangeV2)}</Text></IndexTable.Cell>
                    <IndexTable.Cell>{p.exp?.value === "1" ? <Badge tone="success">Repricer</Badge> : <Text tone="subdued" as="span">–</Text>}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100">
                        {(issues[p.id] || []).map((x) => (
                          <Badge key={x.type} tone={ISSUE[x.type]?.tone}>{`${ISSUE[x.type]?.label}${x.count > 1 ? ` ×${x.count}` : ""}`}</Badge>
                        ))}
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          </div>
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
      </BlockStack>
    </Page>
  );
}
