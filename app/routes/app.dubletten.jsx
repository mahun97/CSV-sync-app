import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Button, Banner, IndexTable, ChoiceList, Box } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getNumberIndex, listDuplicates, listOutliers, nextFreeNumber } from "../lib/artikelnummern.server";

// Übersicht: welche Artikelnummern (Product model / Products id) stehen bei mehreren Produkten?
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const fresh = new URL(request.url).searchParams.get("neu") === "1";
  const index = await getNumberIndex(admin, { fresh });
  return json({ groups: listDuplicates(index), outliers: listOutliers(index), total: index.entries.length, next: nextFreeNumber(index), at: index.at });
};

const STATUS = { ACTIVE: ["Aktiv", "success"], DRAFT: ["Entwurf", "info"], ARCHIVED: ["Archiviert", undefined] };

export default function Dubletten() {
  const { groups, outliers, total, next, at } = useLoaderData();
  const navigate = useNavigate();
  const nav = useNavigation();
  const [filter, setFilter] = useState(["aktiv"]);
  const shown = filter.includes("aktiv") ? groups.filter((g) => g.active > 0) : groups;
  const rows = shown.flatMap((g) => g.products.map((p, i) => ({ g, p, first: i === 0 })));
  const stand = new Date(at).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <Page title="Doppelte Artikelnummern" subtitle="Product model / Products id, die bei mehr als einem Produkt stehen">
      <BlockStack gap="400">
        <Banner tone={groups.length ? "warning" : "success"} title={groups.length ? `${groups.length} Nummern sind mehrfach vergeben` : "Keine doppelten Nummern"}>
          <p>
            Geprüft: {total} Produkte, Stand {stand}. Geprüft wird jedes Feld für sich: dieselbe „Product model“ oder dieselbe „Products id“ bei mehreren Produkten. Oft ist es eine archivierte MHD-Kopie des aktiven Produkts.
            Nächste freie Nummer: <b>{next}</b>. Neue Produkte im Editor bekommen sie automatisch, und beim Speichern einer schon vergebenen Nummer kommt eine Warnung.
          </p>
        </Banner>
        <Card padding="0">
          <Box padding="300">
            <InlineStack align="space-between" blockAlign="center">
              <ChoiceList title="Filter" titleHidden allowMultiple choices={[{ label: `Nur Nummern mit mindestens einem aktiven Produkt (${groups.filter((g) => g.active > 0).length})`, value: "aktiv" }]} selected={filter} onChange={setFilter} />
              <Button loading={nav.state === "loading"} onClick={() => navigate("/app/dubletten?neu=1", { replace: true })}>Neu prüfen</Button>
            </InlineStack>
          </Box>
          <IndexTable
            resourceName={{ singular: "Produkt", plural: "Produkte" }}
            itemCount={rows.length}
            selectable={false}
            headings={[{ title: "Nummer" }, { title: "Produkt" }, { title: "Status" }, { title: "Product model" }, { title: "Products id" }, { title: "SKU" }]}
            emptyState={<Box padding="400"><Text as="p" tone="subdued">Keine Einträge.</Text></Box>}
          >
            {rows.map(({ g, p, first }, i) => (
              <IndexTable.Row id={`${g.field}-${g.value}-${p.id}`} key={`${g.field}-${g.value}-${p.id}`} position={i} onClick={() => navigate(`/app/produkte/${p.id.split("/").pop()}`)}>
                <IndexTable.Cell>{first ? <Text as="span" fontWeight="bold">{g.label} {g.value} <Text as="span" tone="subdued">({g.products.length}×)</Text></Text> : ""}</IndexTable.Cell>
                <IndexTable.Cell><Text as="span">{p.title}</Text></IndexTable.Cell>
                <IndexTable.Cell><Badge tone={STATUS[p.status]?.[1]}>{STATUS[p.status]?.[0] || p.status}</Badge></IndexTable.Cell>
                <IndexTable.Cell><Text as="span" tone={g.field === "product_model" ? "critical" : undefined}>{p.product_model || "–"}</Text></IndexTable.Cell>
                <IndexTable.Cell><Text as="span" tone={g.field === "products_id" ? "critical" : undefined}>{p.products_id || "–"}</Text></IndexTable.Cell>
                <IndexTable.Cell><Text as="span" tone="subdued">{p.sku || "–"}</Text></IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>

        {outliers.length > 0 && (
          <Card padding="0">
            <Box padding="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">{`Auffällige Nummern (${outliers.length})`}</Text>
                <Text as="p" tone="subdued" variant="bodySm">Weit über dem fortlaufenden Bereich, vermutlich Tippfehler. Für die Vorschlagsnummer werden sie ignoriert.</Text>
              </BlockStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "Produkt", plural: "Produkte" }}
              itemCount={outliers.length}
              selectable={false}
              headings={[{ title: "Produkt" }, { title: "Status" }, { title: "Product model" }, { title: "Products id" }, { title: "SKU" }]}
            >
              {outliers.map((p, i) => (
                <IndexTable.Row id={p.id} key={p.id} position={i} onClick={() => navigate(`/app/produkte/${p.id.split("/").pop()}`)}>
                  <IndexTable.Cell><Text as="span">{p.title}</Text></IndexTable.Cell>
                  <IndexTable.Cell><Badge tone={STATUS[p.status]?.[1]}>{STATUS[p.status]?.[0] || p.status}</Badge></IndexTable.Cell>
                  <IndexTable.Cell>{p.product_model || "–"}</IndexTable.Cell>
                  <IndexTable.Cell>{p.products_id || "–"}</IndexTable.Cell>
                  <IndexTable.Cell><Text as="span" tone="subdued">{p.sku || "–"}</Text></IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
