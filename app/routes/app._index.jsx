import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, InlineGrid, Text, Badge, Button, Box, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, parseTimes } from "../lib/settings.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const settings = await getSettings();
  let last = null;
  let problems = [];
  try {
    last = await prisma.repricerRun.findFirst({ where: { dryRun: false, status: { not: "running" } }, orderBy: { startedAt: "desc" } });
    if (last) {
      problems = await prisma.repricerEvent.findMany({
        where: { runId: last.id, type: { in: ["ek_block", "data", "not_in_omnia", "error"] } },
        orderBy: [{ level: "asc" }, { title: "asc" }],
        take: 8,
      });
    }
  } catch {}
  return json({ last, problems, times: parseTimes(settings.repricerTimes), enabled: settings.repricerEnabled === "true" });
};

const fmt = (d) => new Date(d).toLocaleString("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function Tile({ title, text, action, onClick, badge }) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">{title}</Text>
          {badge}
        </InlineStack>
        <Text as="p" tone="subdued">{text}</Text>
        <InlineStack><Button onClick={onClick}>{action}</Button></InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function Uebersicht() {
  const { last, problems, times, enabled } = useLoaderData();
  const navigate = useNavigate();
  return (
    <Page title="Kwax Shop-Verwaltung" subtitle="Repricer, Produkte und Lager">
      <BlockStack gap="400">
        {!enabled && <Banner tone="warning" title="Der Repricer-Zeitplan ist ausgeschaltet." action={{ content: "Einstellungen", onAction: () => navigate("/app/repricer") }} />}
        {last?.status === "failed" && (
          <Banner tone="critical" title={`Letzter Repricer-Lauf fehlgeschlagen (${fmt(last.startedAt)})`} action={{ content: "Protokoll öffnen", onAction: () => navigate(`/app/repricer?run=${last.id}`) }}>
            <p>{last.message}</p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <Tile
            title="Repricer"
            text={last ? `Letzter Lauf ${fmt(last.startedAt)}: ${last.updated} Preise übernommen, ${last.clamped} begrenzt, ${last.ekBlocked} EK-Sperren. Nächste Läufe: ${times.join(", ")} Uhr.` : `Noch kein Lauf protokolliert. Geplant: ${times.join(", ")} Uhr.`}
            action="Repricer öffnen"
            onClick={() => navigate("/app/repricer")}
            badge={last && <Badge tone={last.status === "success" ? "success" : last.status === "failed" ? "critical" : "warning"}>{last.status === "success" ? "OK" : last.status === "failed" ? "Fehler" : "Hinweise"}</Badge>}
          />
          <Tile title="Produkte" text="Produkte anlegen und bearbeiten: Preise, EK, Omnia Min/Max, EAN, Texte, Pflichtangaben und Export – mit Produkt-Check." action="Produkte öffnen" onClick={() => navigate("/app/produkte")} />
          <Tile title="Außenlager" text="Hauptlager, Außenlager und Meldebestand je Variante, rote Ampel bei Nachschubbedarf." action="Außenlager öffnen" onClick={() => navigate("/app/aussenlager")} />
        </InlineGrid>

        {problems.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Offene Punkte aus dem letzten Repricer-Lauf</Text>
                <Button variant="plain" onClick={() => navigate(`/app/repricer?run=${last.id}`)}>Alle anzeigen</Button>
              </InlineStack>
              {problems.map((e) => (
                <Box key={e.id} paddingBlockEnd="200" borderBlockEndWidth="025" borderColor="border-secondary">
                  <InlineStack align="space-between" blockAlign="start" wrap={false} gap="300">
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">{e.title}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">SKU {e.sku} · {e.message}</Text>
                    </BlockStack>
                    {e.productId && <Button size="slim" onClick={() => navigate(`/app/produkte/${e.productId.split("/").pop()}`)}>Bearbeiten</Button>}
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
